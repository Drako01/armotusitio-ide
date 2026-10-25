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
const { stripTypeScriptTypes } = require('node:module');

function harness(trusted = true, notifications = 'errors') {
	let controller, executed = 0, confirm = 'Run';
	let enabled = true, selection, rejectNotification = false;
	let available = true, actions = ['check'], failStart = false;
	let now = 100000;
	let provider = { supported: true, host: 'codex' };
	const processOptions = [];
	const clock = class extends Date { static now() { return now; } };
	const notices = [], commands = [];
	const notify = async (kind, message, button) => { if (rejectNotification) { throw new Error('Notification unavailable'); } notices.push({ kind, message, button }); return selection; };
	const disposable = { dispose() { } };
	const noopEvent = () => disposable;
	const execution = { terminate() { this.terminated = true; } };
	const vscode = {
		EventEmitter: class { constructor() { this.event = noopEvent; } fire() { } dispose() { } },
		l10n: { t: (text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => String(values[index])) },
		Uri: { file: fsPath => ({ fsPath }) },
		workspace: {
			isTrusted: trusted, getConfiguration: () => ({ get: (key, fallback) => key === 'showWelcome' ? false : key === 'notifications' ? notifications : key === 'enabled' ? enabled : fallback }),
			workspaceFolders: [{ uri: { fsPath: '/repo', toString: () => 'file:///repo' } }],
			onDidChangeConfiguration: noopEvent, onDidChangeWorkspaceFolders: noopEvent,
			createFileSystemWatcher: () => ({ dispose() { }, onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent })
		},
		window: {
			registerTreeDataProvider(_, value) { controller = value; return disposable; },
			showWarningMessage: async (message, options) => options?.modal ? confirm : notify('warning', message, options),
			showQuickPick: async entries => entries[0],
			showInformationMessage: (message, button) => notify('info', message, button),
			showErrorMessage: (message, button) => notify('error', message, button)
		},
		commands: { registerCommand: () => disposable, executeCommand: async id => { commands.push(id); } },
		TreeItem: class { constructor(label) { this.label = label; } }, TreeItemCollapsibleState: { Expanded: 2 }, ThemeIcon: class { },
		Task: class { }, ProcessExecution: class { constructor(_file, _args, options) { processOptions.push(options); } }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { New: 1 },
		tasks: { async executeTask() { executed++; if (failStart) { throw new Error('Cannot start task'); } return execution; }, onDidEndTaskProcess: noopEvent, onDidEndTask: noopEvent }
	};
	const module = { exports: {} };
	const core = { detect: () => available ? ({ root: '/repo', name: 'RedEvent', id: 'redevent', actions }) : null, command: (_, action) => ({ executable: 'pnpm', args: ['harness:' + action], cwd: '/repo' }) };
	vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../extension.ts'), 'utf8')), { module, Date: clock, require: n => n === './src/adapter.ts' ? require('../src/adapter.ts') : n === 'vscode' ? vscode : n === './src/core.ts' ? core : n === './src/provider.ts' ? { readProvider: async () => provider, selectProvider: async () => { } } : n === './src/home.ts' ? { registerHome() { } } : n === './src/mcp.ts' ? { registerMcp() { } } : n === './src/chat.ts' ? { registerChat() { } } : n === './src/activity.ts' ? { History: require('../src/activity.ts').History, registerActivity() { } } : { register() { } } });
	module.exports.activate({ subscriptions: [], workspaceState: { get: () => [], update: async () => { } } });
	return { controller, execution, notices, commands, processOptions, provider: value => { provider = value; }, executed: () => executed, advance: milliseconds => { now += milliseconds; }, confirm: value => { confirm = value; }, mode: value => { notifications = value; }, disable: () => { enabled = false; }, select: value => { selection = value; }, rejectNotification: () => { rejectNotification = true; }, trust: value => { vscode.workspace.isTrusted = value; }, available: value => { available = value; }, actions: value => { actions = value; }, failStart: value => { failStart = value; } };
}

test('generic harness command selects an action and never executes in an untrusted workspace', async () => {
	const trusted = harness();
	await trusted.controller.execute();
	const untrusted = harness(false);
	await untrusted.controller.execute();
	assert.deepEqual([trusted.executed(), untrusted.executed(), [...trusted.controller.jobs.values()][0].action], [1, 0, 'check']);
});

test('task outcomes distinguish success, failure, missing exit code and confirmed cancellation', async () => {
	const states = [];
	for (const code of [0, 1, undefined]) {
		const h = harness();
		await h.controller.execute(undefined, 'check');
		h.controller.finish(h.execution, code);
		states.push(h.controller.jobs.get(h.execution).state);
		h.controller.finish(h.execution, undefined);
		assert.equal(h.controller.jobs.get(h.execution).state, states.at(-1));
		assert.ok(h.controller.getHistory()[0].endedAt >= h.controller.getHistory()[0].startedAt);
	}
	const h = harness();
	await h.controller.execute(undefined, 'check');
	h.confirm('Terminate');
	await h.controller.terminate();
	h.controller.finish(h.execution, 1);
	states.push(h.controller.jobs.get(h.execution).state);
	assert.deepEqual([states, h.execution.terminated], [['passed', 'failed', 'ended', 'cancelled'], true]);
});

test('clearing confirmed history preserves active tasks and their later outcome', async () => {
	const h = harness();
	await h.controller.execute(undefined, 'check');
	h.confirm('Borrar historial'); await h.controller.clearHistory();
	assert.equal(h.controller.history.rows.length, 0);
	assert.equal(h.controller.getHistory()[0].state, 'running');
	assert.notEqual(h.execution.terminated, true);
	h.controller.finish(h.execution, 0);
	assert.equal(h.controller.getHistory()[0].state, 'passed');
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test('completion notices respect all modes and distinguish errors, unknown exit codes and cancellations', async () => {
	for (const mode of ['always', 'errors', 'never']) {
		for (const outcome of [
			{ code: 0, kind: 'info', error: false },
			{ code: 1, kind: 'error', error: true },
			{ code: undefined, kind: 'warning', error: true },
			{ code: 1, cancelled: true, kind: 'info', error: false }
		]) {
			const h = harness(true, mode);
			await h.controller.execute(undefined, 'check');
			assert.equal(h.notices.length, 0, 'no notice before completion');
			if (outcome.cancelled) { h.confirm('Terminate'); await h.controller.terminate(); }
			h.advance(65000);
			h.controller.finish(h.execution, outcome.code);
			h.controller.finish(h.execution, outcome.code);
			await tick();
			const expected = mode === 'always' || (mode === 'errors' && outcome.error);
			assert.equal(h.notices.length, expected ? 1 : 0, mode + ' / ' + outcome.kind);
			if (expected) {
				assert.equal(h.notices[0].kind, outcome.kind);
				assert.match(h.notices[0].message, /check en RedEvent.*\(65 s\)/);
				assert.equal(h.notices[0].button, 'Ver historial');
				assert.doesNotMatch(h.notices[0].message, /\/repo|pnpm/);
			}
		}
	}
});

test('history opens only when the completion notice action is selected', async () => {
	for (const selection of [undefined, 'Ver historial']) {
		const h = harness(); h.select(selection);
		await h.controller.execute(undefined, 'check'); h.controller.finish(h.execution, 1); await tick();
		assert.deepEqual(h.commands, selection ? ['atsHarness.history'] : []);
	}
});

test('completion uses current settings and ignores unrelated task end events', async () => {
	for (const change of [h => h.mode('never'), h => h.disable()]) {
		const h = harness(true, 'always');
		await h.controller.execute(undefined, 'check'); change(h);
		h.controller.finish({}, 1); h.controller.finish(h.execution, 1); await tick();
		assert.equal(h.notices.length, 0);
		assert.equal(h.controller.getHistory()[0].state, 'failed');
	}
});

test('notification API failures do not alter the persisted outcome or reject completion', async () => {
	const h = harness(); h.rejectNotification();
	await h.controller.execute(undefined, 'check'); h.controller.finish(h.execution, 1); await tick();
	assert.equal(h.controller.getHistory()[0].state, 'failed');
	assert.deepEqual(h.commands, []);
});

test('repeat only launches eligible completed history records as a new confirmed execution', async () => {
	for (const action of ['check', 'verify', 'test']) {
		const h = harness(); h.actions([action]);
		await h.controller.execute(undefined, action); h.controller.finish(h.execution, 0);
		const old = h.controller.getHistory()[0];
		await h.controller.repeat(old.id);
		assert.equal(h.executed(), 2);
		assert.equal(h.controller.getHistory().length, 2);
		assert.equal(old.state, 'passed');
		assert.notEqual(h.controller.jobs.get(h.execution).id, old.id);
		assert.equal(h.controller.jobs.get(h.execution).action, action);
	}
	for (const [action, state] of [['run', 'passed'], ['dispatch', 'failed'], ['abort', 'cancelled'], ['check', 'unknown'], ['check', 'running']]) {
		const h = harness();
		h.controller.history.put({ id: 'old', project: '/repo', action, state, startedAt: 0 });
		await h.controller.repeat('old'); await h.controller.repeat('missing');
		assert.equal(h.executed(), 0);
	}
});

test('repeat respects trust, project availability, removed commands and declined confirmation', async () => {
	for (const change of [h => h.trust(false), h => h.available(false), h => h.actions([]), h => h.confirm(undefined)]) {
		const h = harness();
		await h.controller.execute(undefined, 'check'); h.controller.finish(h.execution, 0);
		change(h); await h.controller.repeat(h.controller.getHistory()[0].id);
		assert.equal(h.executed(), 1);
		assert.equal(h.controller.launching.size, 0);
	}
});

test('repeat blocks concurrent confirmation, active tasks and bypass through the regular command', async () => {
	const h = harness(); await h.controller.execute(undefined, 'check'); h.controller.finish(h.execution, 0);
	const id = h.controller.getHistory()[0].id;
	let confirm;
	h.confirm(new Promise(resolve => { confirm = resolve; }));
	const pending = h.controller.repeat(id); await tick();
	await h.controller.repeat(id); await h.controller.execute(undefined, 'check');
	assert.equal(h.executed(), 1);
	confirm('Run'); await pending;
	await h.controller.repeat(id); assert.equal(h.executed(), 2);
	assert.equal(h.controller.launching.size, 0);
});

test('repeat releases its launch lock after a startup error and rechecks trust after confirmation', async () => {
	const h = harness(); await h.controller.execute(undefined, 'check'); h.controller.finish(h.execution, 0);
	const id = h.controller.getHistory()[0].id;
	h.failStart(true); await assert.rejects(h.controller.repeat(id), /Cannot start task/);
	assert.equal(h.controller.launching.size, 0);
	h.failStart(false); await h.controller.repeat(id); assert.equal(h.executed(), 3);
	h.controller.finish(h.execution, 0);
	let confirm;
	h.confirm(new Promise(resolve => { confirm = resolve; }));
	const pending = h.controller.repeat(id); await tick(); h.trust(false); confirm('Run'); await pending;
	assert.equal(h.executed(), 3); assert.equal(h.controller.launching.size, 0);
});

test('cancelled chat requests do not launch tasks before or after the confirmation dialog', async () => {
	const h = harness(); const token = { isCancellationRequested: true };
	await h.controller.execute(undefined, 'check', token); assert.equal(h.executed(), 0);
	token.isCancellationRequested = false;
	let confirm;
	h.confirm(new Promise(resolve => { confirm = resolve; }));
	const pending = h.controller.execute(undefined, 'check', token); await tick(); token.isCancellationRequested = true; confirm('Run');
	await pending; assert.equal(h.executed(), 0); assert.equal(h.controller.launching.size, 0);
});

test('new tasks capture the selected host while existing history and active jobs keep their original host', async () => {
	const h = harness();
	await h.controller.execute(undefined, 'check');
	const first = h.controller.getHistory()[0];
	assert.equal(first.host, 'codex'); assert.equal(h.processOptions[0].env.HARNESS_HOST, 'codex');
	h.provider({ supported: true, host: 'claude' });
	assert.equal(h.controller.getHistory()[0].host, 'codex');
	h.controller.finish(h.execution, 0); h.advance(1000);
	await h.controller.execute(undefined, 'check');
	assert.deepEqual([...h.controller.getHistory()].map(row => row.host), ['codex', 'claude']);
	assert.equal(h.processOptions[1].env.HARNESS_HOST, 'claude');
	h.controller.finish(h.execution, 0); h.actions(['test']);
	await h.controller.execute(undefined, 'test');
	assert.equal(h.processOptions[2].env, undefined, 'test isolation must not inherit the project host');
});

test('Harness tree exposes a provider selector with project-scoped command arguments', async () => {
	const h = harness();
	const roots = await h.controller.getChildren();
	assert.equal(roots[0].description, 'Codex');
	const primary = await h.controller.getChildren(roots[0]);
	assert.equal(primary[0].label, 'Nueva tarea');
	assert.equal(primary[1].label, 'Progreso y resultados');
	const nodes = await h.controller.getChildren(primary[2]);
	assert.equal(nodes[0].label, 'IA: Codex');
	assert.equal(nodes[0].command.command, 'atsHarness.selectProvider');
	assert.equal(nodes[0].command.arguments[0], 'file:///repo');
	h.provider({ supported: true, custom: true });
	const custom = await h.controller.getChildren(primary[2]);
	assert.equal(custom[0].label, 'IA: Comando personalizado');
});
