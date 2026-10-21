/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function harness() {
	const commands = new Map();
	const calls = [];
	let receiver, onDispose, update;
	const disposable = { dispose() { } };
	const panel = {
		reveal() { calls.push('reveal'); }, dispose() { onDispose(); }, onDidDispose(fn) { onDispose = fn; return disposable; }, webview: {
			cspSource: 'file:', asWebviewUri(uri) { return uri; }, postMessage(state) { calls.push(state); },
			onDidReceiveMessage(fn) { receiver = fn; return disposable; }
		}
	};
	const vscode = {
		l10n: { t: text => text }, ViewColumn: { One: 1 }, Uri: { joinPath: (base, ...parts) => base + '/' + parts.join('/') },
		workspace: { isTrusted: true, onDidGrantWorkspaceTrust() { return disposable; }, workspaceFolders: [], updateWorkspaceFolders(...args) { calls.push(args); } },
		commands: { registerCommand(id, fn) { commands.set(id, fn); return disposable; }, async executeCommand(id) { calls.push(id); } },
		window: { createWebviewPanel() { return panel; }, async showOpenDialog() { return [{ path: '/chosen' }]; } }
	};
	const controller = { async getProvider() { return { label: 'Codex', supported: true }; }, jobs: new Map(), progress: [], canRepeat(job) { return ['check', 'verify', 'test'].includes(job.action) && ['passed', 'failed', 'cancelled', 'ended'].includes(job.state); }, isBusy() { return false; }, async repeat(id) { calls.push(['repeat', id]); }, getHistory() { return [...this.jobs.values()]; }, onDidChangeTreeData(fn) { update = fn; return disposable; }, refresh() { update(); }, async refreshActivity() { }, async execute(...args) { calls.push(args); } };
	const projects = [{ profile: { name: 'RedEvent', root: '/repo', actions: ['check'] }, folder: { uri: { toString: () => 'file:///repo' } } }];
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/home.ts'), 'utf8'), { module, require: name => name === 'vscode' ? vscode : require(name) });
	const context = { extensionUri: 'file:///extension', subscriptions: [] };
	module.exports.registerHome(context, controller, () => projects);
	commands.get('atsIde.home')();
	return { commands, calls, panel, controller, context, vscode, receive: message => receiver(message) };
}

test('home routes only declared project actions and fixed commands', async () => {
	const h = harness();
	await h.receive({ action: 'execute', root: '/repo', command: 'check' });
	await h.receive({ action: 'execute', root: '/repo', command: 'deploy' });
	await h.receive({ action: 'execute', root: '/other', command: 'check' });
	await h.receive({ action: 'workbench.action.terminal.new' });
	await h.receive({ action: 'github' });
	assert.deepEqual(h.calls, [['file:///repo', 'check'], 'atsIde.github']);
});

test('provider selector routes only an existing project URI to the fixed command', async () => {
	const h = harness();
	await h.receive({ action: 'provider', root: '/repo' });
	await h.receive({ action: 'provider', root: '/other' });
	assert.deepEqual(h.calls, ['atsHarness.selectProvider']);
});

test('home publishes actual session state, reuses one panel and excludes arbitrary HTML data', async () => {
	const h = harness();
	h.controller.jobs.set('task', { id: 'task', action: 'check', state: 'cancelled', project: '/repo', startedAt: 1000, endedAt: 2000 });
	await h.receive({ action: 'ready' });
	const state = h.calls[0];
	assert.deepEqual(JSON.parse(JSON.stringify({ ...state, labels: undefined })), { type: 'state', trusted: true, projects: [{ name: 'RedEvent', root: '/repo', actions: ['check'], provider: 'Codex', providerSupported: true }], jobs: [{ id: 'task', action: 'check', state: 'cancelled', project: '/repo', startedAt: 1000, endedAt: 2000, repeatable: true, repeatBlocked: false }], progress: [] });
	assert.match(h.panel.webview.html, /default-src 'none'/);
	assert.doesNotMatch(h.panel.webview.html, /unsafe-inline|command:|\/repo/);
	h.commands.get('atsIde.home')();
	assert.equal(h.calls[1], 'reveal');
});

test('home adds a selected folder without replacing existing workspace folders', async () => {
	const h = harness();
	h.vscode.workspace.workspaceFolders = [{}, {}];
	await h.receive({ action: 'open' });
	assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [[2, 0, { uri: { path: '/chosen' } }]]);
});

test('home routes repeat by history identity and rejects malformed identity messages', async () => {
	const h = harness();
	await h.receive({ action: 'repeat', id: 'task', root: '/other', command: 'run' });
	await h.receive({ action: 'repeat', id: { command: 'run' } });
	await h.receive({ action: 'repeat' });
	assert.deepEqual(h.calls, [['repeat', 'task']]);
});

test('repeat is blocked in the view when an equivalent task is busy or its project is absent', async () => {
	const h = harness(); h.controller.isBusy = () => true;
	h.controller.jobs.set('task', { id: 'task', action: 'check', state: 'passed', project: '/repo', startedAt: 1000 });
	await h.receive({ action: 'ready' }); assert.equal(h.calls.at(-1).jobs[0].repeatBlocked, true);
	h.controller.isBusy = () => false;
	h.controller.jobs.get('task').project = '/removed';
	await h.receive({ action: 'ready' }); assert.equal(h.calls.at(-1).jobs[0].repeatBlocked, true);
});
