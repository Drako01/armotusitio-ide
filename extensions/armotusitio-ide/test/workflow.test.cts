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
