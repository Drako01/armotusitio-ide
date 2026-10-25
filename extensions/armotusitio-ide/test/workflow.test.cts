/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HarnessWorkflow, nativeRun, answerArgs, progressView, redact } = require('../src/workflow.ts');
const { toolArgs } = require('../src/catalog.ts');

async function harness(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-workflow-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	await fs.mkdir(path.join(directory, '.harness'));
	const profile = { id: 'redevent', root: directory };
	const calls = [];
	let trusted = true, saved = [], live = false, ready = true, questions = [], state = 'completed';
	const run = async (project, args, options) => {
		calls.push({ project, args, options });
		if (args[0] === 'progress') { return args[1] === '--json' ? { code: 1, error: live ? '' : 'No active task; pass a <task-id>', value: live ? { live: true } : undefined, ...(!live && { error: 'No active task; pass a <task-id>' }) } : { code: 0, value: { id: args[1], state, live: false, percent: state === 'completed' ? 100 : 45 } }; }
		if (args[0] === 'preflight') { return { code: ready ? 0 : 1, value: { ready, questions, plan: [{ domain: 'repo', dag: [{ id: 'review', agent: 'reviewer' }] }], warnings: [], mode: 'harness' } }; }
		if (args[0] === 'run') { return { code: 0, value: { id: '20261024-test' } }; }
		return { code: 0 };
	};
	const options = { directory, storage: { get: () => saved, update: async (_, rows) => { saved = rows; } }, allowed: () => trusted, changed() { }, run };
	const workflow = new HarnessWorkflow(options);
	return { workflow, profile, calls, options, storage: () => saved, trust: value => { trusted = value; }, live: value => { live = value; }, preflight: (value, pending = []) => { ready = value; questions = pending; }, state: value => { state = value; } };
}

test('freeform preparation never creates or executes before explicit plan confirmation', async t => {
	const h = await harness(t);
	const id = await h.workflow.prepare(h.profile, 'Implement a bounded change', 'codex');
	assert.equal(h.workflow.entries.get(id).phase, 'review');
	assert.deepEqual(h.calls.map(call => call.args[0]), ['progress', 'preflight']);
	const entry = h.workflow.entries.get(id);
	assert.equal(await fs.readFile(entry.file, 'utf8'), 'Implement a bounded change');
	assert.equal(h.calls[1].options.host, 'codex');
	assert.doesNotMatch(JSON.stringify(h.workflow.view(entry)), /request-.*txt|knownQuestions|answers/);
	await h.workflow.start(id, h.profile);
	assert.equal(entry.phase, 'completed');
	assert.equal(entry.progress.percent, 100);
	assert.deepEqual(h.calls.map(call => call.args[0]), ['progress', 'preflight', 'preflight', 'run', 'execute', 'progress']);
	assert.equal(h.calls.find(call => call.args[0] === 'execute').options.timeout, 0);
	assert.equal(entry.file, undefined);
	await h.workflow.persist;
	assert.doesNotMatch(JSON.stringify(h.storage()), /Implement|answers|request-/);
});

test('live native work and revoked workspace trust block task creation', async t => {
	const h = await harness(t); h.live(true);
	await assert.rejects(h.workflow.prepare(h.profile, 'Task', 'project'), /HARNESS_BUSY/);
	assert.equal(h.calls.length, 1);
	h.trust(false);
	await assert.rejects(h.workflow.prepare(h.profile, 'Task', 'project'), /HARNESS_REQUEST/);
	assert.equal(h.calls.length, 1);
});

test('questions must be answered through native preflight and cannot inject another answer', async t => {
	const h = await harness(t); h.preflight(false, [{ id: 'scope', question: 'Which scope?' }]);
	const id = await h.workflow.prepare(h.profile, 'Task', 'project');
	assert.equal(h.workflow.entries.get(id).phase, 'questions');
	await assert.rejects(h.workflow.answer(id, h.profile, { other: 'yes' }), /HARNESS_ANSWERS/);
	await assert.rejects(h.workflow.answer(id, h.profile, { scope: 'repo,override=yes' }), /HARNESS_ANSWERS/);
	h.preflight(true);
	await h.workflow.answer(id, h.profile, { scope: 'repo' });
	assert.equal(h.workflow.entries.get(id).phase, 'review');
	assert.deepEqual(h.calls.at(-1).args.slice(-2), ['--answer', 'scope=repo']);
});

test('fresh preflight can block a previously reviewed plan', async t => {
	const h = await harness(t);
	const id = await h.workflow.prepare(h.profile, 'Task', 'project');
	h.preflight(false);
	await h.workflow.start(id, h.profile);
	assert.equal(h.workflow.entries.get(id).phase, 'blocked');
	assert.equal(h.calls.some(call => call.args[0] === 'run'), false);
});

test('observing and restoring interrupted tasks never resumes or aborts them', async t => {
	const h = await harness(t); h.state('stalled');
	const id = await h.workflow.observe(h.profile, '20261024-old');
	assert.equal(h.workflow.entries.get(id).phase, 'interrupted');
	await assert.rejects(h.workflow.stop(id, h.profile), /HARNESS_NOT_OWNED/);
	await h.workflow.persist;
	const restored = new HarnessWorkflow(h.options);
	assert.equal(restored.all()[0].nativeId, '20261024-old');
	assert.equal(h.calls.every(call => call.args[0] === 'progress'), true);
	await h.workflow.resume(id, h.profile);
	assert.deepEqual(h.calls.filter(call => call.args[0] !== 'progress').map(call => call.args[0]), ['resume']);
});

test('multi-domain progress exposes native child units and rejects invalid values', () => {
	const progress = progressView({ id: 'task', state: 'running', live: true, percent: 24, children: [{ nodes: [{ id: 'review', agent: 'reviewer', status: 'running' }] }] });
	assert.equal(progress.nodes[0].agent, 'reviewer');
	assert.equal(progress.percent, 24);
	assert.throws(() => progressView({ id: '<script>', state: 'running' }));
	assert.equal(progressView({ id: 'task', state: 'running', percent: 101 }).percent, undefined);
	assert.throws(() => answerArgs([], { unknown: 'value' }));
	assert.doesNotMatch(redact('api_key=private Bearer credential'), /private|credential/);
	assert.deepEqual(JSON.parse(redact('{"api_key":"private value","count":2}')), { api_key: '[redacted]', count: 2 });
});

test('native subprocess receives literal arguments and the selected provider without a shell', async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-native-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	await fs.mkdir(path.join(directory, '.harness'));
	await fs.writeFile(path.join(directory, '.harness', 'core.mjs'), 'console.log(JSON.stringify({id:"fixture",args:process.argv.slice(2),host:process.env.HARNESS_HOST}));');
	const literal = 'status & echo shell; $(do-not-run)';
	const result = await nativeRun({ id: 'redevent', root: directory }, [literal], { host: 'claude', timeout: 5000 });
	assert.equal(result.code, 0);
	assert.deepEqual(result.value.args, [literal]);
	assert.equal(result.value.host, 'claude');
	await assert.rejects(nativeRun({ id: 'armotusitio', root: directory }, []), /HARNESS_UNSUPPORTED/);
	await assert.rejects(nativeRun({ id: 'redevent', root: directory }, [], { authorize: () => false }), /HARNESS_WORKSPACE/);
});

test('editing a prepared request removes its superseded private input without creating a native task', async t => {
	const h = await harness(t);
	const id = await h.workflow.prepare(h.profile, 'Revise this request', 'project');
	const file = h.workflow.entries.get(id).file;
	assert.equal(await h.workflow.edit(id, h.profile), 'Revise this request');
	assert.equal(h.workflow.entries.has(id), false);
	await assert.rejects(fs.stat(file), { code: 'ENOENT' });
	assert.equal(h.calls.some(call => call.args[0] === 'run'), false);
});

test('overlapping progress reads are coalesced and a malformed reading is marked stale', async t => {
	const h = await harness(t);
	const id = await h.workflow.observe(h.profile, '20261024-observed');
	let reads = 0, resolve;
	h.workflow.run = async () => { reads++; return new Promise(done => { resolve = done; }); };
	const first = h.workflow.refresh(id, h.profile), second = h.workflow.refresh(id, h.profile);
	assert.equal(reads, 1);
	resolve({ code: 0, value: { id: '20261024-observed', state: 'running', live: true, percent: 39 } });
	await Promise.all([first, second]);
	assert.equal(h.workflow.entries.get(id).progress.percent, 39);
	h.workflow.run = async () => ({ code: 0, value: { id: '<invalid>', state: 'running' } });
	await h.workflow.refresh(id, h.profile);
	assert.equal(h.workflow.entries.get(id).progressError, true);
	assert.equal(h.workflow.entries.get(id).progress.percent, 39);
});

test('tool arguments are fixed, task IDs are literal and provider tests require a known host', () => {
	assert.deepEqual(toolArgs('status', '20261024-task'), ['status', '20261024-task']);
	assert.deepEqual(toolArgs('migrations'), ['migrations', 'next']);
	assert.deepEqual(toolArgs('cache'), ['cache', 'status']);
	assert.deepEqual(toolArgs('smoke-host', undefined, 'codex'), ['smoke-host', 'codex']);
	assert.throws(() => toolArgs('status', '../secret'), /HARNESS_TASK/);
	assert.throws(() => toolArgs('status', '--no-preflight'), /HARNESS_TASK/);
	assert.throws(() => toolArgs('smoke-host', undefined, 'codex && command'), /HARNESS_PROVIDER/);
	assert.throws(() => toolArgs('arbitrary-command'), /HARNESS_TOOL/);
});

test('changed reviewed plan requires another explicit approval before creation', async t => {
	const h = await harness(t);
	const id = await h.workflow.prepare(h.profile, 'Task', 'project');
	const run = h.workflow.run;
	h.workflow.run = async (...args) => { const result = await run(...args); if (args[1][0] === 'preflight') { result.value.plan[0].dag.push({ id: 'new-check', agent: 'verifier' }); } return result; };
	await h.workflow.start(id, h.profile);
	assert.deepEqual([h.workflow.entries.get(id).phase, h.workflow.entries.get(id).error, h.calls.some(call => call.args[0] === 'run')], ['review', 'HARNESS_PLAN_CHANGED', false]);
	await h.workflow.start(id, h.profile);
	assert.equal(h.workflow.entries.get(id).phase, 'completed');
});

test('cancelled native outcome and native terminal time survive refresh and reload', async t => {
	const h = await harness(t);
	h.workflow.run = async (_, args) => ({ code: 0, value: { id: args[1], state: 'failed', outcome: 'cancelled', live: false, finishedAt: '2026-10-25T12:00:00Z', attempt: { number: 2 } } });
	const id = await h.workflow.observe(h.profile, 'cancelled-task');
	await h.workflow.refresh(id, h.profile); await h.workflow.persist;
	const restored = new HarnessWorkflow(h.options);
	assert.deepEqual([h.workflow.entries.get(id).phase, h.workflow.entries.get(id).endedAt, restored.all()[0].phase], ['cancelled', Date.parse('2026-10-25T12:00:00Z'), 'cancelled']);
});

test('ArmotuSitio forces project gates, passes reviewed digest and confirms cooperative abort', async t => {
	const h = await harness(t); h.profile.id = 'armotusitio';
	await assert.rejects(h.workflow.prepare(h.profile, 'Task', 'codex'), /HARNESS_REQUEST/);
	const run = h.workflow.run;
	let outcome = 'running';
	h.workflow.run = async (...args) => {
		if (args[1][0] === 'progress' && args[1][1] !== '--json') { return { code: 0, value: { id: args[1][1], state: outcome === 'cancelled' ? 'failed' : 'running', live: outcome === 'running', outcome } }; }
		if (args[1][0] === 'abort') { outcome = 'cancelled'; return { code: 3, value: { pending: true } }; }
		const result = await run(...args); if (args[1][0] === 'preflight') { result.value.planDigest = 'a'.repeat(64); } return result;
	};
	const id = await h.workflow.prepare(h.profile, 'Task', 'project');
	await h.workflow.start(id, h.profile);
	assert.deepEqual(h.calls.find(call => call.args[0] === 'run').args.slice(-2), ['--plan-digest', 'a'.repeat(64)]);
	await h.workflow.stop(id, h.profile);
	assert.equal(h.workflow.entries.get(id).phase, 'cancelled');
});

test('domain identity, final gates and attempt metadata are retained without raw commands', () => {
	const progress = progressView({ id: 'multi', state: 'running', outcome: 'running', children: [{ domain: 'api', nodes: [{ id: 'verify', status: 'running' }] }, { domain: 'ui', nodes: [{ id: 'verify', status: 'passed' }] }], finalGates: [{ id: 'integration', status: 'pending' }], attempt: { number: 3 }, currentGate: { id: 'verify', domain: 'api', elapsedMs: 13000 }, command: 'private' });
	assert.deepEqual([progress.nodes.map(node => node.domain), progress.finalGates[0].id, progress.attempt, progress.currentGate.elapsedMs], [['api', 'ui'], 'integration', 3, 13000]);
	assert.doesNotMatch(JSON.stringify(progress), /private|command/);
});

test('unchanged progress does not rewrite references and active references are not evicted', async t => {
	const h = await harness(t);
	let writes = 0;
	h.options.storage.update = async () => { writes++; };
	const id = await h.workflow.observe(h.profile, 'retained');
	await h.workflow.persist; const previous = writes;
	await h.workflow.refresh(id, h.profile); await h.workflow.persist;
	assert.equal(writes, previous);
	const rows = Array.from({ length: 60 }, (_, index) => ({ id: `entry-${index}`, project: h.profile.root, nativeId: `native-${index}`, host: 'project', startedAt: index, phase: 'running' }));
	const restored = new HarnessWorkflow({ ...h.options, storage: { get: () => rows, update: async () => {} } });
	assert.equal(restored.all().length, 60);
});

test('a late response after trust revocation cannot replace the last confirmed state', async t => {
	const h = await harness(t);
	const id = await h.workflow.observe(h.profile, 'late');
	let complete;
	h.workflow.run = () => new Promise(resolve => { complete = resolve; });
	const pending = h.workflow.refresh(id, h.profile); h.trust(false);
	complete({ code: 0, value: { id: 'late', state: 'running', live: true } }); await pending;
	assert.equal(h.workflow.entries.get(id).phase, 'completed');
});

test('uncertain creation blocks duplicate preparation across reload until explicitly reconciled', async t => {
	const h = await harness(t);
	const run = h.workflow.run;
	h.workflow.run = async (...args) => { if (args[1][0] === 'run') { throw new Error('HARNESS_TIMEOUT'); } return run(...args); };
	const id = await h.workflow.prepare(h.profile, 'Task', 'project');
	await h.workflow.start(id, h.profile); await h.workflow.persist;
	const restored = new HarnessWorkflow(h.options);
	assert.deepEqual([restored.all()[0].phase, restored.all()[0].creationUncertain], ['unknown', true]);
	await assert.rejects(restored.prepare(h.profile, 'Task', 'project'), /HARNESS_RECONCILE/);
	assert.equal(h.workflow.view(h.workflow.entries.get(id)).editable, false);
});

test('private provider command changes invalidate approval even when the host stays project', async t => {
	const h = await harness(t);
	await fs.mkdir(path.join(h.profile.root, '.harness'), { recursive: true });
	const file = path.join(h.profile.root, '.harness/.env');
	await fs.writeFile(file, 'HARNESS_AGENT_COMMAND=first-command\n');
	const id = await h.workflow.prepare(h.profile, 'Task', 'project');
	await fs.writeFile(file, 'HARNESS_AGENT_COMMAND=second-command\n');
	await h.workflow.start(id, h.profile);
	assert.equal(h.workflow.entries.get(id).error, 'HARNESS_PLAN_CHANGED');
	assert.equal(h.calls.some(call => call.args[0] === 'run'), false);
	assert.doesNotMatch(JSON.stringify(h.workflow.view(h.workflow.entries.get(id))), /first-command|second-command|providerRevision/);
});
