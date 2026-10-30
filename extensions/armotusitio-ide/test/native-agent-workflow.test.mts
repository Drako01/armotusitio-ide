/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
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
