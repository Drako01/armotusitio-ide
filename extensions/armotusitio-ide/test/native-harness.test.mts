/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeHarness, approvalDigest, validateNativePlan, selectNativeWave } from '../src/native-harness.ts';

async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-native-test-'));
	const project = path.join(dir, 'project'); await fs.mkdir(project);
	return { project, engine: new NativeHarness(project, path.join(dir, 'state')), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}
test('plan rejects cycles and invalid commands', () => {
	assert.throws(() => validateNativePlan({ schemaVersion: 1, gates: [{ id: 'a', executable: 'node', args: [], dependsOn: ['b'] }, { id: 'b', executable: 'node', args: [], dependsOn: ['a'] }] }), /HARNESS_CYCLE/);
	assert.throws(() => validateNativePlan({ schemaVersion: 1, gates: [{ id: 'a', executable: '/bin/sh', args: [] }] }), /HARNESS_INVALID_COMMAND/);
});
test('local task passes without Git or AI and tracks attempts', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'ok', executable: 'node', args: ['-e', 'process.stdout.write("hello")'] }] };
		const t = await f.engine.create('check', plan);
		assert.equal((await f.engine.list()).length, 1);
		await assert.rejects(f.engine.execute(t.id, 'wrong', () => true), /HARNESS_APPROVAL_EXPIRED/);
		const root = await fs.realpath(f.project);
		const done = await f.engine.execute(t.id, approvalDigest(plan, root), () => true);
		assert.equal(done.attempts[0].status, 'passed'); assert.equal(done.attempts[0].results[0].output, 'hello');
		assert.equal((await f.engine.status(t.id)).active, false);
	} finally { await f.cleanup(); }
});
test('untrusted execution and escaped cwd fail closed', async () => {
	const f = await fixture(); try {
		await assert.rejects(f.engine.create('no', { schemaVersion: 1, gates: [{ id: 'g', executable: 'node', args: [], cwd: '..' }] }), /HARNESS_PATH_ESCAPE/);
		const p = { schemaVersion: 1 as const, gates: [{ id: 'ok', executable: 'node', args: ['--version'] }] };
		const t = await f.engine.create('ok', p);
		await assert.rejects(f.engine.execute(t.id, approvalDigest(p, await fs.realpath(f.project)), () => false), /HARNESS_UNTRUSTED_WORKSPACE/);
	} finally { await f.cleanup(); }
});
test('explicit stale-lock reconciliation marks uncertain attempt interrupted', async () => {
	const f = await fixture(); try {
		await fs.mkdir(path.dirname(path.join(f.project, '../state/execution.lock')), { recursive: true });
		const state = path.join(path.dirname(f.project), 'state');
		await fs.mkdir(state, { recursive: true });
		await fs.writeFile(path.join(state, 'execution.lock'), JSON.stringify({ pid: 999999999, hostname: os.hostname() }));
		assert.equal((await f.engine.diagnose()).lock, 'stale');
		assert.equal(await f.engine.reconcile(), true);
		assert.equal((await f.engine.diagnose()).lock, 'none');
	} finally { await f.cleanup(); }
});

test('foreign or malformed lock is not silently removed', async () => {
	const f = await fixture(); try {
		const state = path.join(path.dirname(f.project), 'state'); await fs.mkdir(state, { recursive: true });
		await fs.writeFile(path.join(state, 'execution.lock'), JSON.stringify({ pid: 888888888, hostname: 'unverified-other-host' }));
		assert.equal((await f.engine.diagnose()).lock, 'unknown');
		assert.equal(await f.engine.reconcile(), false);
		assert.ok(await fs.stat(path.join(state, 'execution.lock')));
	} finally { await f.cleanup(); }
});
test('changed plan revision is rejected before execution', async () => {
	const f = await fixture(); try {
		const p = { schemaVersion: 1 as const, gates: [{ id: 'x', executable: 'node', args: ['--version'] }] };
		const task = await f.engine.create('immutable', p);
		const file = path.join(path.dirname(f.project), 'state', 'tasks', `${task.id}.json`);
		const stored = JSON.parse(await fs.readFile(file, 'utf8'));
		stored.plan.gates[0].args = ['--help']; await fs.writeFile(file, JSON.stringify(stored));
		await assert.rejects(f.engine.execute(task.id, approvalDigest(p, await fs.realpath(f.project)), () => true), /HARNESS_PLAN_CHANGED/);
	} finally { await f.cleanup(); }
});
test('escaped symlink cwd is rejected', async () => {
	const f = await fixture(); try {
		const outside = path.join(path.dirname(f.project), 'outside'); await fs.mkdir(outside);
		await fs.symlink(outside, path.join(f.project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
		await assert.rejects(f.engine.create('escape', { schemaVersion: 1, gates: [{ id: 'x', executable: 'node', args: [], cwd: 'escape' }] }), /HARNESS_PATH_ESCAPE/);
	} finally { await f.cleanup(); }
});
test('cancelled execution never marks the task passed', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'slow', executable: 'node', args: ['-e', 'setTimeout(() => {}, 15000)'], timeoutMs: 30000 }] };
		const task = await f.engine.create('cancel', plan);
		const signal = new AbortController();
		const execution = f.engine.execute(task.id, approvalDigest(plan, await fs.realpath(f.project)), () => true, signal.signal);
		setTimeout(() => signal.abort(), 150);
		const done = await execution;
		assert.equal(done.attempts.at(-1)?.status, 'cancelled');
	} finally { await f.cleanup(); }
});
test('zero-step plan is rejected', () => {
	assert.throws(() => validateNativePlan({ schemaVersion: 1, gates: [] }), /HARNESS_PLAN_SCHEMA/);
});
test('corrupted persisted attempts fail closed before execution', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'ok', executable: 'node', args: ['--version'] }] };
		const task = await f.engine.create('validation', plan);
		const file = path.join(path.dirname(f.project), 'state', 'tasks', `${task.id}.json`);
		const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
		persisted.attempts = [{ status: 'ghost', results: null }];
		await fs.writeFile(file, JSON.stringify(persisted));
		await assert.rejects(f.engine.execute(task.id, approvalDigest(plan, await fs.realpath(f.project)), () => true), /HARNESS_INVALID_TASK_STATE/);
	} finally { await f.cleanup(); }
});
test('concurrent attempts cannot both obtain execution lock', async () => {
	const f = await fixture();
	try {
		// Keep the first gate alive until cancellation. A fixed 2s timer can finish
		// before the second attempt is rejected on busy Windows CI workers.
		const plan = {
			schemaVersion: 1 as const,
			gates: [{
				id: 'slow', executable: 'node',
				args: ['-e', 'require("node:fs").writeFileSync("gate-started.flag","ready"); setInterval(()=>{},1000)'],
				timeoutMs: 30000
			}]
		};
		const t = await f.engine.create('locking', plan);
		const digest = approvalDigest(plan, await fs.realpath(f.project));
		const first = f.engine.execute(t.id, digest, () => true);
		const started = path.join(f.project, 'gate-started.flag');
		try {
			// Do not assert contention until the subprocess really holds the lock.
			let ready = false;
			for (let i = 0; i < 500; i++) {
				if (await fs.stat(started).catch(() => undefined)) { ready = true; break; }
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			assert.equal(ready, true, 'The first gate must start before contention is tested');
			await assert.rejects(f.engine.execute(t.id, digest, () => true),
				/HARNESS_ALREADY_RUNNING|HARNESS_LOCKED_REQUIRES_RECONCILIATION|HARNESS_RECONCILIATION_REQUIRED/);
		} finally {
			// Always stop and drain the child even when an assertion fails.
			f.engine.cancel();
			const result = await first;
			assert.equal(result.attempts.at(-1)?.status, 'cancelled');
		}
	} finally { await f.cleanup(); }
});
test('already-aborted signal does not start a task or persist an attempt', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'not-run', executable: 'node', args: ['--version'] }] };
		const task = await f.engine.create('abort beforehand', plan);
		const controller = new AbortController(); controller.abort();
		await assert.rejects(f.engine.execute(task.id, approvalDigest(plan, await fs.realpath(f.project)), () => true, controller.signal), /HARNESS_CANCELLED_BEFORE_START/);
		assert.equal((await f.engine.get(task.id)).attempts.length, 0);
	} finally { await f.cleanup(); }
});
test('independent gates run concurrently and dependent gate waits for both', async () => {
	const f = await fixture(); try {
		const plan = {
			schemaVersion: 1 as const, gates: [
				{ id: 'a', executable: 'node', args: ['-e', 'setTimeout(()=>console.log("a"),350)'] },
				{ id: 'b', executable: 'node', args: ['-e', 'setTimeout(()=>console.log("b"),350)'] },
				{ id: 'c', executable: 'node', args: ['-e', 'console.log("c")'], dependsOn: ['a', 'b'] }
			]
		};
		const task = await f.engine.create('parallel DAG', plan);
		const result = await f.engine.execute(task.id, approvalDigest(plan, await fs.realpath(f.project)), () => true);
		const attempt = result.attempts.at(-1)!;
		assert.equal(attempt.status, 'passed');
		assert.deepEqual(attempt.results.map(r => r.id), ['a', 'b', 'c']);
		assert.ok(Date.parse(attempt.results[0].startedAt) <= Date.parse(attempt.results[1].endedAt));
		assert.ok(Date.parse(attempt.results[2].startedAt) >= Date.parse(attempt.results[1].endedAt));
	} finally { await f.cleanup(); }
});
test('failed wave does not start dependent gates', async () => {
	const f = await fixture(); try {
		const plan = {
			schemaVersion: 1 as const, gates: [
				{ id: 'bad', executable: 'node', args: ['-e', 'process.exit(2)'] },
				{ id: 'other', executable: 'node', args: ['-e', 'console.log("ok")'] },
				{ id: 'dependent', executable: 'node', args: ['--version'], dependsOn: ['bad'] }
			]
		};
		const task = await f.engine.create('failed parallel', plan);
		const result = await f.engine.execute(task.id, approvalDigest(plan, await fs.realpath(f.project)), () => true);
		assert.equal(result.attempts.at(-1)?.status, 'failed');
		assert.deepEqual(result.attempts.at(-1)?.results.map(r => r.id), ['bad', 'other']);
	} finally { await f.cleanup(); }
});

test('symbolic task files fail closed', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'ok', executable: 'node', args: ['--version'] }] };
		const t = await f.engine.create('link test', plan);
		const state = path.join(path.dirname(f.project), 'state', 'tasks', `${t.id}.json`);
		const moved = state + '.original';
		await fs.rename(state, moved); await fs.symlink(moved, state, 'file');
		await assert.rejects(f.engine.get(t.id), /HARNESS_INVALID_TASK_FILE/);
	} finally { await f.cleanup(); }
});


test('configuration changes expire approval before any attempt starts', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'verify', executable: 'node', args: ['--version'] }] };
		const task = await f.engine.create('config approval', plan);
		await fs.writeFile(path.join(f.project, '.ats-harness.json'), '{}');
		const reviewed = await f.engine.reviewDigest(plan);
		await fs.writeFile(path.join(f.project, '.ats-harness.json'), '{"changed":true}');
		await assert.rejects(f.engine.execute(task.id, reviewed, () => true), /HARNESS_APPROVAL_EXPIRED/);
		assert.equal((await f.engine.get(task.id)).attempts.length, 0);
	} finally { await f.cleanup(); }
});

test('project Harness introduced after task creation prevents bundled execution', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'verify', executable: 'node', args: ['--version'] }] };
		const task = await f.engine.create('priority', plan);
		await fs.mkdir(path.join(f.project, '.harness'));
		await assert.rejects(f.engine.execute(task.id, await f.engine.reviewDigest(plan), () => true), /HARNESS_PROJECT_AUTHORITY/);
		await assert.rejects(f.engine.create('duplicate', plan), /HARNESS_PROJECT_AUTHORITY/);
		assert.equal((await f.engine.get(task.id)).attempts.length, 0);
	} finally { await f.cleanup(); }
});

test('execution records evidence and invalidates it when declared inputs change', async () => {
	const f = await fixture(); try {
		await fs.writeFile(path.join(f.project, 'input.txt'), 'first');
		const plan = { schemaVersion: 1 as const, inputs: ['input.txt'], gates: [{ id: 'verify', executable: 'node', args: ['--version'] }] };
		const task = await f.engine.create('evidence', plan);
		const result = await f.engine.execute(task.id, await f.engine.reviewDigest(plan), () => true);
		assert.equal(result.attempts.at(-1)?.evidence?.state, 'recorded');
		assert.equal((await f.engine.evidenceStatus(task.id))[0].state, 'current-declared-inputs');
		await fs.writeFile(path.join(f.project, 'input.txt'), 'second');
		assert.equal((await f.engine.evidenceStatus(task.id))[0].state, 'changed');
		await assert.rejects(f.engine.execute(task.id, 'bad-approval', () => true), /HARNESS_APPROVAL_EXPIRED/);
	} finally { await f.cleanup(); }
});

test('evidence persistence failures preserve the actual gate outcome', async () => {
	const f = await fixture(); try {
		await fs.writeFile(path.join(f.project, 'input.txt'), 'safe');
		await fs.mkdir(path.join(path.dirname(f.project), 'state'), { recursive: true });
		await fs.writeFile(path.join(path.dirname(f.project), 'state', 'evidence'), 'collision');
		const plan = { schemaVersion: 1 as const, inputs: ['input.txt'], gates: [{ id: 'verify', executable: 'node', args: ['--version'] }] };
		const task = await f.engine.create('evidence failure', plan);
		const result = await f.engine.execute(task.id, await f.engine.reviewDigest(plan), () => true);
		assert.deepEqual({ status: result.attempts[0].status, evidence: result.attempts[0].evidence }, { status: 'passed', evidence: { state: 'unavailable', error: 'HARNESS_EVIDENCE_PERSISTENCE' } });
	} finally { await f.cleanup(); }
});

test('changed inputs during execution cannot become current evidence', async () => {
	const f = await fixture(); try {
		await fs.writeFile(path.join(f.project, 'input.txt'), 'before');
		const plan = { schemaVersion: 1 as const, inputs: ['input.txt'], gates: [{ id: 'mutate', executable: 'node', args: ['-e', 'require("node:fs").writeFileSync("input.txt", "after")'] }] };
		const task = await f.engine.create('mutated input', plan);
		const result = await f.engine.execute(task.id, await f.engine.reviewDigest(plan), () => true);
		assert.deepEqual({ status: result.attempts[0].status, evidence: result.attempts[0].evidence }, { status: 'passed', evidence: { state: 'changed' } });
	} finally { await f.cleanup(); }
});

test('secrets split across stdout chunks are redacted before persistence', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'redact', executable: 'node', args: ['-e', 'process.stdout.write("api_key=");setTimeout(()=>process.stdout.write("fixture-private-value"),50)'] }] };
		const task = await f.engine.create('redaction', plan);
		await f.engine.execute(task.id, await f.engine.reviewDigest(plan), () => true);
		const stored = await f.engine.get(task.id);
		assert.deepEqual(stored.attempts[0].results.map(result => result.output), ['api_key=[redacted]']);
	} finally { await f.cleanup(); }
});

test('missing tools fail with an actionable result and never leave an active lock', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'missing', executable: 'ats-tool-that-does-not-exist', args: [] }] };
		const task = await f.engine.create('missing tool', plan);
		const result = await f.engine.execute(task.id, await f.engine.reviewDigest(plan), () => true);
		assert.deepEqual({ status: result.attempts[0].status, output: result.attempts[0].results[0].output, lock: (await f.engine.diagnose()).lock }, { status: 'failed', output: 'HARNESS_EXECUTABLE_UNAVAILABLE', lock: 'none' });
	} finally { await f.cleanup(); }
});


test('explicit reconciliation recovers an uncertain attempt whose lock is missing', async () => {
	const f = await fixture(); try {
		const plan = { schemaVersion: 1 as const, gates: [{ id: 'verify', executable: 'node', args: ['--version'] }] };
		const task = await f.engine.create('missing lock', plan);
		const result = await f.engine.execute(task.id, await f.engine.reviewDigest(plan), () => true);
		result.attempts[0].status = 'running';
		await fs.writeFile(path.join(path.dirname(f.project), 'state', 'tasks', task.id + '.json'), JSON.stringify(result));
		assert.equal((await f.engine.status(task.id)).reconciliationRequired, true);
		assert.equal(await f.engine.reconcile(), true);
		assert.equal((await f.engine.get(task.id)).attempts[0].status, 'interrupted');
	} finally { await f.cleanup(); }
});


test('resource-aware gate scheduler caps concurrency and avoids shared resources', () => {
	const ready = [
		{ id: 'a', executable: 'node', args: [], parallelSafe: true, resources: ['db'] },
		{ id: 'b', executable: 'node', args: [], parallelSafe: true, resources: ['files'] },
		{ id: 'c', executable: 'node', args: [], parallelSafe: true, resources: ['db'] },
		{ id: 'd', executable: 'node', args: [], parallelSafe: true, resources: ['network'] },
		{ id: 'e', executable: 'node', args: [], parallelSafe: true, resources: ['cpu'] }
	];
	assert.deepEqual(selectNativeWave(ready, 8).map(x => x.id), ['a', 'b', 'd', 'e']);
	assert.deepEqual(selectNativeWave(ready, 2).map(x => x.id), ['a', 'b']);
	assert.deepEqual(selectNativeWave(ready.map(x => ({ ...x, parallelSafe: false })), 8).map(x => x.id), ['a', 'b']);
	assert.throws(() => validateNativePlan({ schemaVersion: 1, gates: [{ id: 'bad', executable: 'node', args: [], resources: ['../secret'] }] }), /HARNESS_INVALID_RESOURCES/);
});
