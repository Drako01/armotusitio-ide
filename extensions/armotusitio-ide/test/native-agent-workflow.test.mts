/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installFakeCodex } from './native-fake-provider.mts';
import { NativeAgentWorkflow, executionOrder, proposedWorkflow, workflowDigest } from '../src/native-agent-workflow.ts';

test('proposed workflow is a fixed auditable plan-implement-review chain', () => {
	const p = proposedWorkflow('codex', 'Add a safe API endpoint');
	assert.deepEqual(executionOrder(p), ['plan', 'implement', 'review']);
	assert.equal(p.handoffs[0].role, 'planner');
	assert.equal(p.handoffs[1].role, 'implementer');
	assert.equal(p.handoffs[2].role, 'reviewer');
	assert.notEqual(workflowDigest('/repo', p), workflowDigest('/repo2', p));
	assert.throws(() => proposedWorkflow('codex', ''), /HARNESS_AGENT_INSTRUCTION_INVALID/);
});

test('rejects forged approval before running anything', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-approval-'));
	try {
		const flow = new NativeAgentWorkflow(await fs.realpath(root), path.join(root, 'private'));
		const plan = proposedWorkflow('codex', 'Analyze modules');
		await assert.rejects(flow.start(plan, 'wrong', () => true), /HARNESS_WORKFLOW_APPROVAL_CHANGED/);
		assert.deepEqual(await flow.history(), []);
		await assert.rejects(flow.start(plan, workflowDigest(await fs.realpath(root), plan), () => false), /HARNESS_UNTRUSTED_WORKSPACE/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('executes three stages in order with fake provider; persists only metadata', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-e2e-'));
	const oldPath = process.env.PATH;
	const traceFile = path.join(os.tmpdir(), 'ats-workflow-trace-' + path.basename(root) + '.txt');
	try {
		const canonical = await fs.realpath(root);
		const bin = path.join(root, 'bin');
		await fs.mkdir(bin);
		const script = [
			'#!/usr/bin/env node',
			'let input = "";',
			'process.stdin.on("data", b => { input += b; });',
			'process.stdin.on("end", () => {',
			' const role = input.includes("Read-only assessment") ? "plan" : input.includes("Implement only") ? "implement" : "review";',
			' require("fs").appendFileSync(' + JSON.stringify(traceFile) + ', role + "\\n");',
			' console.log(role === "review" ? "HARNESS_REVIEW: PASS" : "fake provider passed");',
			'});'
		].join('\n');
		await installFakeCodex(bin, script);
		process.env.PATH = bin + path.delimiter + (oldPath || '');
		const plan = proposedWorkflow('codex', 'PRIVATETASK-DO-NOT-PERSIST');
		const flow = new NativeAgentWorkflow(canonical, path.join(root, 'private'));
		let verified = 0;
		let metrics = 0;
		const events: Array<{ kind: string; stepId?: string }> = [];
		const unsubscribe = flow.onEvent(event => { assert.equal(JSON.stringify(event).includes('PRIVATETASK'), false); events.push(event); });
		const run = await flow.start(plan, workflowDigest(canonical, plan), () => true, async () => { verified++; return true; }, async () => { metrics++; });
		const outcome = await run.result;
		unsubscribe();
		assert.deepEqual(events.map(event => event.kind), ['workflow-started', 'step-started', 'step-finished', 'step-started', 'step-finished', 'step-started', 'step-finished', 'verification-finished', 'workflow-finished']);
		assert.equal(outcome.status, 'passed');
		assert.equal(outcome.verification, 'passed');
		assert.equal(verified, 1);
		assert.equal(metrics, 3);
		assert.deepEqual(outcome.steps.map(s => s.status), ['passed', 'passed', 'passed']);
		assert.equal(await fs.readFile(traceFile, 'utf8'), 'plan\nimplement\nreview\n');
		const history = await flow.history();
		assert.equal(history.length, 1);
		assert.equal(history[0].status, 'passed');
		const raw = await fs.readFile(path.join(root, 'private', outcome.id + '.json'), 'utf8');
		assert.ok(!raw.includes('PRIVATETASK-DO-NOT-PERSIST'));
	} finally {
		if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
		await fs.rm(traceFile, { force: true });
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('interrupted workflow cannot replay an uncertain writer or use a changed plan', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-resume-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const plan = proposedWorkflow('codex', 'Maintain a fixture');
		const digest = workflowDigest(canonical, plan);
		const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
		const key = (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex');
		const record = {
			schemaVersion: 1, id, createdAt: new Date().toISOString(),
			projectKey: key, planDigest: digest, status: 'interrupted',
			steps: [
				{ id: 'plan', provider: 'codex', role: 'planner', status: 'passed' },
				{ id: 'implement', provider: 'codex', role: 'implementer', status: 'interrupted' },
				{ id: 'review', provider: 'codex', role: 'reviewer', status: 'pending' }
			]
		};
		await fs.writeFile(path.join(state, id + '.json'), JSON.stringify(record));
		const workflow = new NativeAgentWorkflow(canonical, state);
		await assert.rejects(workflow.restartInterrupted(id, plan, digest, () => true), /HARNESS_RESUME_WRITE_UNCERTAIN/);
		assert.equal((await workflow.history())[0].status, 'interrupted');
		await assert.rejects(workflow.restartInterrupted(id, plan, 'forged', () => true), /HARNESS_WORKFLOW_APPROVAL_CHANGED/);
		await assert.rejects(workflow.restartInterrupted('../outside', plan, digest, () => true), /HARNESS_RESUME_ID_INVALID/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('workflow history refuses injected fields inside persisted lifecycle events', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-events-state-'));
	try {
		const canonical = await fs.realpath(root);
		const dir = path.join(root, 'private');
		await fs.mkdir(dir);
		const id = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
		const digest = workflowDigest(canonical, proposedWorkflow('codex', 'Inspect code'));
		const key = (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex');
		const record = {
			schemaVersion: 1, id, createdAt: new Date().toISOString(),
			projectKey: key, planDigest: digest, status: 'passed', steps: [],
			events: [{ workflowId: id, kind: 'workflow-started', at: new Date().toISOString(), injectedPrompt: 'SECRET' }]
		};
		await fs.writeFile(path.join(dir, id + '.json'), JSON.stringify(record));
		const workflow = new NativeAgentWorkflow(canonical, dir);
		await assert.rejects(workflow.history(), /HARNESS_WORKFLOW_INVALID_STATE/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('workflow rejects calls beyond the five invocations explicitly approved in the IDE', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-call-budget-'));
	try {
		const canonical = await fs.realpath(root);
		const plan = {
			schemaVersion: 1 as const,
			handoffs: Array.from({ length: 6 }, (_, index) => ({
				id: 'read_' + index, role: 'planner' as const, provider: 'codex' as const,
				dependsOn: index === 0 ? [] : ['read_' + (index - 1)],
				instruction: 'Audit section ' + index
			}))
		};
		const flow = new NativeAgentWorkflow(canonical, path.join(root, 'private'));
		await assert.rejects(flow.start(plan, workflowDigest(canonical, plan), () => true), /HARNESS_WORKFLOW_CALL_BUDGET_EXCEEDED/);
		assert.deepEqual(await flow.history(), []);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('persisted workflow rejects undeclared top-level and step content without rewriting evidence', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-record-schema-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const id = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
		const digest = workflowDigest(canonical, proposedWorkflow('codex', 'Inspect fixture'));
		const key = (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex');
		const file = path.join(state, id + '.json');
		const baseline = {
			schemaVersion: 1, id, createdAt: new Date().toISOString(),
			projectKey: key, planDigest: digest, status: 'interrupted',
			steps: [{ id: 'plan', role: 'planner', provider: 'codex', status: 'passed' }]
		};
		const workflow = new NativeAgentWorkflow(canonical, state);
		for (const corrupted of [
			{ ...baseline, providerOutput: 'UNTRUSTED_RAW_MODEL_OUTPUT' },
			{ ...baseline, steps: [{ ...baseline.steps[0], prompt: 'UNTRUSTED_PRIVATE_PROMPT' }] },
			{ ...baseline, verification: 'succeeded-without-checks' },
			{ ...baseline, endedAt: 'not-a-date' },
			{ ...baseline, steps: [{ ...baseline.steps[0], durationMs: -100 }] },
			{ ...baseline, steps: [{ ...baseline.steps[0], exitCode: 'SUCCESS' }] }
		]) {
			const raw = JSON.stringify(corrupted);
			await fs.writeFile(file, raw);
			await assert.rejects(workflow.history(), /HARNESS_WORKFLOW_INVALID_STATE/);
			assert.equal(await fs.readFile(file, 'utf8'), raw);
		}
		await fs.writeFile(file, JSON.stringify(baseline));
		const history = await workflow.history();
		assert.equal(history.length, 1);
		assert.equal(history[0].status, 'interrupted');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reconciliation preserves stale lock when persisted history is corrupt', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-reconcile-invalid-history-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const lockFile = path.join(state, 'execution.lock');
		const lock = JSON.stringify({ pid: 99999999 });
		await fs.writeFile(lockFile, lock);
		const corrupt = path.join(state, 'dddddddd-dddd-4ddd-dddd-dddddddddddd.json');
		await fs.writeFile(corrupt, JSON.stringify({ schemaVersion: 1, prompt: 'NEVER_PERSIST' }));
		const workflow = new NativeAgentWorkflow(canonical, state);
		await assert.rejects(workflow.reconcile(), /HARNESS_WORKFLOW_INVALID_STATE/);
		assert.equal(await fs.readFile(lockFile, 'utf8'), lock);
		await assert.rejects(workflow.history(), /HARNESS_WORKFLOW_INVALID_STATE/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reconciliation scans older running workflows beyond the 40-record UI window', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-reconcile-full-history-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const plan = proposedWorkflow('codex', 'Inspect recovery fixture');
		const digest = workflowDigest(canonical, plan);
		const projectKey = (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex');
		const olderId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
		const base = Date.now() - 100_000;
		for (let index = 0; index < 41; index++) {
			const id = index === 0 ? olderId : 'ffffffff-ffff-4fff-8fff-' + index.toString(16).padStart(12, '0');
			await fs.writeFile(path.join(state, id + '.json'), JSON.stringify({
				schemaVersion: 1, id, createdAt: new Date(base + index * 1000).toISOString(),
				projectKey, planDigest: digest, status: index === 0 ? 'running' : 'passed',
				steps: [{ id: 'plan', role: 'planner', provider: 'codex', status: index === 0 ? 'running' : 'passed' }]
			}));
		}
		const workflow = new NativeAgentWorkflow(canonical, state);
		assert.equal((await workflow.history()).length, 40);
		assert.equal((await workflow.history()).some(record => record.id === olderId), false);
		assert.equal(await workflow.reconcile(), 1);
		const recovered = JSON.parse(await fs.readFile(path.join(state, olderId + '.json'), 'utf8'));
		assert.equal(recovered.status, 'interrupted');
		assert.equal(recovered.steps[0].status, 'interrupted');
		assert.equal((await workflow.history()).length, 40);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reconciliation releases stale execution lock only after successful state recovery', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-reconcile-lock-completion-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const lockFile = path.join(state, 'execution.lock');
		await fs.writeFile(lockFile, JSON.stringify({ pid: 99999999 }));
		const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef';
		const plan = proposedWorkflow('codex', 'Inspect stale recovery');
		const digest = workflowDigest(canonical, plan);
		const projectKey = (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex');
		await fs.writeFile(path.join(state, id + '.json'), JSON.stringify({
			schemaVersion: 1, id, createdAt: new Date().toISOString(),
			projectKey, planDigest: digest, status: 'running',
			steps: [{ id: 'plan', role: 'planner', provider: 'codex', status: 'running' }]
		}));
		const workflow = new NativeAgentWorkflow(canonical, state);
		assert.equal(await workflow.reconcile(), 1);
		await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
		const recovered = (await workflow.history())[0];
		assert.equal(recovered.status, 'interrupted');
		assert.equal(recovered.steps[0].status, 'interrupted');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failed final state persistence keeps the execution lock for explicit repair', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-terminal-failure-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		const workflow = new NativeAgentWorkflow(canonical, state);
		const plan = proposedWorkflow('codex', 'Inspect fixture without running an agent');
		const unsubscribe = workflow.onEvent(event => {
			if (event.kind !== 'workflow-started') { return; }
			const recordFile = path.join(state, event.workflowId + '.json');
			// Simulate an external filesystem fault after the initial durable write:
			// replacing the record with a directory makes subsequent atomic renames fail.
			fsSync.rmSync(recordFile);
			fsSync.mkdirSync(recordFile);
		});
		try {
			const run = await workflow.start(plan, workflowDigest(canonical, plan), () => true);
			await assert.rejects(run.result);
			const lock = JSON.parse(await fs.readFile(path.join(state, 'execution.lock'), 'utf8'));
			assert.equal(lock.id, run.id);
			await assert.rejects(workflow.start(plan, workflowDigest(canonical, plan), () => true),
				/HARNESS_WORKFLOW_RECONCILIATION_REQUIRED/);
		} finally { unsubscribe(); }
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('history rejects mismatched file identity without overwriting another workflow', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-file-identity-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const filenameId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
		const plan = proposedWorkflow('codex', 'Inspect file identity');
		const record = {
			schemaVersion: 1, id, createdAt: new Date().toISOString(),
			projectKey: (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex'),
			planDigest: workflowDigest(canonical, plan), status: 'running', steps: []
		};
		const file = path.join(state, filenameId + '.json');
		const raw = JSON.stringify(record);
		await fs.writeFile(file, raw);
		const workflow = new NativeAgentWorkflow(canonical, state);
		await assert.rejects(workflow.history(), /HARNESS_WORKFLOW_INVALID_STATE/);
		await assert.rejects(workflow.reconcile(), /HARNESS_WORKFLOW_INVALID_STATE/);
		assert.equal(await fs.readFile(file, 'utf8'), raw);
		await assert.rejects(fs.stat(path.join(state, id + '.json')), { code: 'ENOENT' });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reconciliation refuses workflow records from another project without removing lock', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-foreign-state-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
		const plan = proposedWorkflow('codex', 'Inspect own root');
		const lockFile = path.join(state, 'execution.lock');
		const lock = JSON.stringify({ pid: 99999999 });
		await fs.writeFile(lockFile, lock);
		await fs.writeFile(path.join(state, id + '.json'), JSON.stringify({
			schemaVersion: 1, id, createdAt: new Date().toISOString(),
			projectKey: 'a'.repeat(64), planDigest: workflowDigest(canonical, plan),
			status: 'running', steps: []
		}));
		const flow = new NativeAgentWorkflow(canonical, state);
		await assert.rejects(flow.reconcile(), /HARNESS_WORKFLOW_FOREIGN_PROJECT_STATE/);
		assert.equal(await fs.readFile(lockFile, 'utf8'), lock);
		assert.equal((await flow.history())[0].status, 'running');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('restart locates old interrupted records outside 40 most recent UI entries', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-resume-old-state-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const plan = proposedWorkflow('codex', 'Inspect old execution');
		const digest = workflowDigest(canonical, plan);
		const key = (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex');
		const oldId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
		const base = Date.now() - 100_000;
		for (let index = 0; index < 41; index++) {
			const id = index === 0 ? oldId : 'dddddddd-dddd-4ddd-8ddd-' + index.toString(16).padStart(12, '0');
			await fs.writeFile(path.join(state, id + '.json'), JSON.stringify({
				schemaVersion: 1, id, createdAt: new Date(base + index * 1000).toISOString(),
				projectKey: key, planDigest: digest,
				status: index === 0 ? 'interrupted' : 'passed',
				steps: index === 0 ? [{ id: 'implement', role: 'implementer', provider: 'codex', status: 'interrupted' }] : []
			}));
		}
		const flow = new NativeAgentWorkflow(canonical, state);
		assert.equal((await flow.history()).some(record => record.id === oldId), false);
		await assert.rejects(flow.restartInterrupted(oldId, plan, digest, () => true),
			/HARNESS_RESUME_WRITE_UNCERTAIN/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('workflow storage refuses a symlink to an unrelated directory', async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-storage-link-'));
	try {
		const canonical = await fs.realpath(root);
		const target = path.join(root, 'other-state');
		const linked = path.join(root, 'private');
		await fs.mkdir(target);
		try { await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
		catch (error) {
			if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) {
				t.skip('Creating directory links requires OS privileges');
				return;
			}
			throw error;
		}
		const flow = new NativeAgentWorkflow(canonical, linked);
		await assert.rejects(flow.history(), /HARNESS_WORKFLOW_UNSAFE_STORAGE/);
		await assert.rejects(flow.reconcile(), /HARNESS_WORKFLOW_UNSAFE_STORAGE/);
		const plan = proposedWorkflow('codex', 'Inspect linked state');
		await assert.rejects(flow.start(plan, workflowDigest(canonical, plan), () => true),
			/HARNESS_WORKFLOW_UNSAFE_STORAGE/);
		assert.deepEqual(await fs.readdir(target), []);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('workflow state path refuses an ordinary file before writing a lock', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-storage-file-'));
	try {
		const canonical = await fs.realpath(root);
		const storage = path.join(root, 'private');
		await fs.writeFile(storage, 'USER_EVIDENCE');
		const plan = proposedWorkflow('codex', 'Inspect protected file');
		const flow = new NativeAgentWorkflow(canonical, storage);
		await assert.rejects(flow.history(), /HARNESS_WORKFLOW_UNSAFE_STORAGE/);
		await assert.rejects(flow.start(plan, workflowDigest(canonical, plan), () => true));
		assert.equal(await fs.readFile(storage, 'utf8'), 'USER_EVIDENCE');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('completed workflow does not unlink a lock replaced by another execution', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-lock-replaced-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		const flow = new NativeAgentWorkflow(canonical, state);
		const plan = proposedWorkflow('codex', 'Inspect without running providers');
		const foreignId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const unsubscribe = flow.onEvent(event => {
			if (event.kind !== 'workflow-started') { return; }
			fsSync.writeFileSync(path.join(state, 'execution.lock'),
				JSON.stringify({ id: foreignId, pid: process.pid }));
			flow.cancel();
		});
		try {
			const run = await flow.start(plan, workflowDigest(canonical, plan), () => true);
			await assert.rejects(run.result, /HARNESS_WORKFLOW_LOCK_CHANGED/);
			const lock = JSON.parse(await fs.readFile(path.join(state, 'execution.lock'), 'utf8'));
			assert.equal(lock.id, foreignId);
			await assert.rejects(flow.start(plan, workflowDigest(canonical, plan), () => true),
				/HARNESS_WORKFLOW_RECONCILIATION_REQUIRED/);
		} finally { unsubscribe(); }
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('exclusive recovery guard blocks a second reconciler and new provider execution', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-reconcile-guard-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const guard = path.join(state, 'reconcile.guard');
		const evidence = '{"pid":99999999,"owner":"external"}';
		await fs.writeFile(guard, evidence);
		const workflow = new NativeAgentWorkflow(canonical, state);
		await assert.rejects(workflow.reconcile(), /HARNESS_WORKFLOW_RECONCILIATION_ACTIVE/);
		const plan = proposedWorkflow('codex', 'Inspect without running providers');
		await assert.rejects(workflow.start(plan, workflowDigest(canonical, plan), () => true),
			/HARNESS_WORKFLOW_RECONCILIATION_ACTIVE/);
		assert.equal(await fs.readFile(guard, 'utf8'), evidence);
		await assert.rejects(fs.stat(path.join(state, 'execution.lock')), { code: 'ENOENT' });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('successful explicit reconciliation releases its own guard without touching foreign state', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-reconcile-guard-release-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		const workflow = new NativeAgentWorkflow(canonical, state);
		assert.equal(await workflow.reconcile(), 0);
		await assert.rejects(fs.stat(path.join(state, 'reconcile.guard')), { code: 'ENOENT' });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('recovery resolves only already committed workflow state intents without replaying providers', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-intent-commit-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
		const plan = proposedWorkflow('codex', 'Inspect recovery metadata without providers');
		const record = {
			schemaVersion: 1, id, createdAt: new Date().toISOString(),
			projectKey: (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex'),
			planDigest: workflowDigest(canonical, plan), status: 'running',
			steps: [{ id: 'plan', role: 'planner', provider: 'codex', status: 'running' }]
		};
		const bytes = JSON.stringify(record);
		await fs.writeFile(path.join(state, id + '.json'), bytes);
		const hash = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
		await fs.writeFile(path.join(state, id + '.json.intent'), JSON.stringify({
			schemaVersion: 1, id, before: null, after: hash, createdAt: new Date().toISOString()
		}));
		await fs.writeFile(path.join(state, 'execution.lock'), JSON.stringify({ pid: 99999999 }));
		const flow = new NativeAgentWorkflow(canonical, state);
		await assert.rejects(flow.history(), /HARNESS_WORKFLOW_PENDING_JOURNAL/);
		assert.equal(await flow.reconcile(), 1);
		await assert.rejects(fs.stat(path.join(state, id + '.json.intent')), { code: 'ENOENT' });
		assert.equal((await flow.history())[0].status, 'interrupted');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('uncommitted workflow intent preserves evidence and blocks execution and reconciliation', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-intent-pending-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddde';
		const plan = proposedWorkflow('codex', 'Inspect incomplete record');
		const record = {
			schemaVersion: 1, id, createdAt: new Date().toISOString(),
			projectKey: (await import('node:crypto')).createHash('sha256').update(canonical).digest('hex'),
			planDigest: workflowDigest(canonical, plan), status: 'running', steps: []
		};
		const raw = JSON.stringify(record);
		const file = path.join(state, id + '.json');
		const intent = path.join(state, id + '.json.intent');
		await fs.writeFile(file, raw);
		await fs.writeFile(intent, JSON.stringify({
			schemaVersion: 1, id, before: null,
			after: 'a'.repeat(64), createdAt: new Date().toISOString()
		}));
		await fs.writeFile(path.join(state, 'execution.lock'), JSON.stringify({ pid: 99999999 }));
		const flow = new NativeAgentWorkflow(canonical, state);
		assert.deepEqual(await flow.pendingJournalIds(), [id]);
		await assert.rejects(flow.history(), /HARNESS_WORKFLOW_PENDING_JOURNAL/);
		await assert.rejects(flow.reconcile(), /HARNESS_WORKFLOW_PENDING_JOURNAL/);
		assert.equal(await fs.readFile(file, 'utf8'), raw);
		assert.ok((await fs.readFile(intent, 'utf8')).includes('"after"'));
		await assert.rejects(flow.start(plan, workflowDigest(canonical, plan), () => true),
			/HARNESS_WORKFLOW_PENDING_JOURNAL/);
		await assert.rejects(fs.stat(path.join(state, 'reconcile.guard')), { code: 'ENOENT' });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('normal workflow journal lifecycle leaves no pending intent after fake provider execution', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-intent-clean-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		const plan = proposedWorkflow('codex', 'Inspect fake provider transitions');
		const workflow = new NativeAgentWorkflow(canonical, state);
		let approvals = 0;
		const run = await workflow.start(plan, workflowDigest(canonical, plan), () => ++approvals === 1);
		const outcome = await run.result;
		assert.equal(outcome.status, 'cancelled');
		assert.deepEqual((await fs.readdir(state)).filter(name => name.endsWith('.json.intent')), []);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reconciliation refuses a committed journal belonging to another project', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-intent-foreign-'));
	try {
		const canonical = await fs.realpath(root);
		const state = path.join(root, 'private');
		await fs.mkdir(state);
		const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeed';
		const plan = proposedWorkflow('codex', 'Inspect foreign state');
		const raw = JSON.stringify({
			schemaVersion: 1, id, createdAt: new Date().toISOString(),
			projectKey: 'f'.repeat(64), planDigest: workflowDigest(canonical, plan),
			status: 'running', steps: []
		});
		const file = path.join(state, id + '.json');
		const intent = path.join(state, id + '.json.intent');
		await fs.writeFile(file, raw);
		await fs.writeFile(intent, JSON.stringify({
			schemaVersion: 1, id, before: null,
			after: (await import('node:crypto')).createHash('sha256').update(raw).digest('hex'),
			createdAt: new Date().toISOString()
		}));
		const lockFile = path.join(state, 'execution.lock');
		await fs.writeFile(lockFile, JSON.stringify({ pid: 99999999 }));
		const flow = new NativeAgentWorkflow(canonical, state);
		await assert.rejects(flow.reconcile(), /HARNESS_WORKFLOW_UNSAFE_JOURNAL/);
		assert.equal(await fs.readFile(file, 'utf8'), raw);
		assert.ok((await fs.readFile(intent, 'utf8')).includes('"after"'));
		assert.ok((await fs.readFile(lockFile, 'utf8')).includes('99999999'));
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
