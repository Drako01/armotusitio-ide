/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tools, toolArgs } = require('../src/catalog.ts');

function harness(secrets = undefined) {
	const calls = [], errors = [], subscriptions = [];
	let trusted = true, custom = false, confirm, entries = [];
	const vscode = {
		l10n: { t: text => text },
		workspace: { get isTrusted() { return trusted; }, getConfiguration: () => ({ get: () => true }), workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/repo' } }] },
		window: { createOutputChannel: () => ({ append() { }, show() { }, dispose() { } }), showErrorMessage: text => errors.push(text), async showWarningMessage(_, __, choice) { return typeof confirm === 'function' ? confirm(choice) : confirm ? choice : undefined; } }
	};
	class Workflow {
		busy = new Set();
		children = new Map();
		all() { return entries; }
		view(entry) { return entry; }
		async prepare(...args) { calls.push(['prepare', ...args]); }
		async start(...args) { calls.push(['start', ...args]); }
		async resume(...args) { calls.push(['resume', ...args]); }
		async stop(...args) { calls.push(['stop', ...args]); }
		async refresh(id) { calls.push(['refresh', id]); }
		dispose() { }
	}
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/workspace.ts'), 'utf8'), { module, require: name => name === './adapter.ts' || name === './src/adapter.ts' ? require('../src/adapter.ts') : name === './evidence.ts' ? require('../src/evidence.ts') : name === 'vscode' ? vscode : name === './workflow.ts' ? { HarnessWorkflow: Workflow, redact: require('../src/workflow.ts').redact, nativeRun: async (_, args) => { calls.push(['native', ...args]); return { code: 0, output: '[]', error: 'No active task; pass a <task-id>' }; } } : name === './catalog.ts' ? { toolArgs } : require(name) });
	const profile = { id: 'redevent', root: '/repo', workflow: true, tools };
	const controller = { progress: [], refresh() { }, async getProvider() { return { custom }; } };
	const bridge = module.exports.createWorkspace({ subscriptions, secrets, workspaceState: { get: (_, fallback) => fallback, update: async () => {} }, globalStorageUri: { fsPath: '/private' } }, controller, async () => [{ profile }]);
	return { bridge, controller, calls, errors, profile, entries: value => { entries = value; }, trust: value => { trusted = value; }, custom: value => { custom = value; }, confirm: value => { confirm = value; } };
}

test('bridge resolves the current trusted project and rejects outside roots and arbitrary tool names', async () => {
	const h = harness();
	await h.bridge.receive({ action: 'invokeTool', root: '/repo', tool: 'list' });
	assert.deepEqual(h.calls, [['native', 'list']]);
	await h.bridge.receive({ action: 'invokeTool', root: '/outside', tool: 'list' });
	await h.bridge.receive({ action: 'invokeTool', root: '/repo', tool: 'arbitrary-command' });
	h.trust(false); await h.bridge.receive({ action: 'invokeTool', root: '/repo', tool: 'list' });
	assert.equal(h.calls.length, 1);
	assert.equal(h.errors.length, 3);
	assert.equal(await h.bridge.receive({ action: 'arbitrary-command' }), false);
});

test('tools with effects require confirmation and recheck workspace trust after the dialog', async () => {
	const h = harness();
	await h.bridge.receive({ action: 'invokeTool', root: '/repo', tool: 'verify' });
	assert.equal(h.calls.length, 0);
	h.confirm(choice => { h.trust(false); return choice; });
	await h.bridge.receive({ action: 'invokeTool', root: '/repo', tool: 'verify' });
	assert.equal(h.calls.length, 0);
	h.trust(true); h.confirm(true);
	await h.bridge.receive({ action: 'invokeTool', root: '/repo', tool: 'verify' });
	assert.deepEqual(h.calls, [['native', 'verify']]);
});

test('custom agent commands cannot silently override a provider explicitly selected in the UI', async () => {
	const h = harness(); h.custom(true);
	await h.bridge.receive({ action: 'prepareTask', root: '/repo', host: 'codex', text: 'Task' });
	assert.equal(h.calls.length, 0);
	await h.bridge.receive({ action: 'prepareTask', root: '/repo', host: 'project', text: 'Task' });
	assert.equal(h.calls[0][0], 'prepare');
	assert.equal(h.calls[0][3], 'project');
});

test('resume and cancellation are explicit confirmed lifecycle actions', async () => {
	const h = harness(); h.entries([{ id: 'task', project: '/repo', phase: 'interrupted' }]);
	await h.bridge.receive({ action: 'resumeTask', root: '/repo', id: 'task' });
	assert.equal(h.calls.length, 0);
	h.confirm(true);
	await h.bridge.receive({ action: 'resumeTask', root: '/repo', id: 'task' });
	await h.bridge.receive({ action: 'stopTask', root: '/repo', id: 'task' });
	assert.deepEqual(h.calls.map(call => call[0]), ['resume', 'stop']);
});

test('background refresh never drops the active task behind newer stale records; manual refresh reads all references', async () => {
	const h = harness();
	h.entries([{ id: 'current', nativeId: '20261024-current', project: '/repo', phase: 'running' }, ...Array.from({ length: 6 }, (_, i) => ({ id: 'old-' + i, nativeId: 'native-old-' + i, project: '/repo', phase: 'interrupted' }))]);
	await h.bridge.refresh();
	assert.equal(h.calls.some(call => call[0] === 'refresh' && call[1] === 'current'), true);
	assert.equal(h.calls.filter(call => call[0] === 'refresh').length, 5);
	await h.bridge.refresh();
	assert.equal(h.calls.some(call => call[0] === 'refresh' && call[1] === 'old-5'), true);
	h.calls.length = 0;
	await h.bridge.refresh(true);
	assert.equal(h.calls.filter(call => call[0] === 'refresh').length, 7);
});


test('drafts are serialized in secret storage and never create native work', async () => {
	let secret; const storage = { get: async () => secret, store: async (_, value) => { secret = value; } };
	const h = harness(storage); let restored;
	h.controller.restoreHarnessDraft = (root, text) => { restored = {root,text}; };
	await Promise.all([h.bridge.receive({action:'saveDraft',root:'/repo',text:'First draft'}),h.bridge.receive({action:'saveDraft',root:'/repo',text:'Latest draft'})]);
	await h.bridge.receive({action:'loadDraft',root:'/repo'});
	assert.deepEqual(restored,{root:'/repo',text:'Latest draft'});
	assert.equal(h.calls.length,0);
	h.trust(false); await h.bridge.receive({action:'loadDraft',root:'/repo'});
	assert.equal(h.errors.length,1);
});

test('an attempt changing during confirmation cannot cancel a newer execution', async () => {
	const h = harness();
	const entry = { id: 'task', nativeId: 'native-task', project: '/repo', phase: 'running', progress: { attempt: 1 } };
	h.entries([entry]);
	h.confirm(choice => { entry.progress.attempt = 2; return choice; });
	await h.bridge.receive({ action: 'stopTask', root: '/repo', id: 'task', attempt: 1 });
	assert.equal(h.calls.some(call => call[0] === 'stop'), false);
	assert.match(h.errors[0], /El intento cambi\u00f3/);
});
