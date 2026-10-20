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
	let now = 100000;
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
		Task: class { }, ProcessExecution: class { }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { New: 1 },
		tasks: { async executeTask() { executed++; return execution; }, onDidEndTaskProcess: noopEvent, onDidEndTask: noopEvent }
	};
	const module = { exports: {} };
	const core = { detect: () => ({ root: '/repo', name: 'RedEvent', id: 'redevent', actions: ['check'] }), command: () => ({ executable: 'pnpm', args: ['harness:check'], cwd: '/repo' }) };
	vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../extension.ts'), 'utf8')), { module, Date: clock, require: n => n === 'vscode' ? vscode : n === './src/core.ts' ? core : n === './src/home.ts' ? { registerHome() { } } : n === './src/activity.ts' ? { History: require('../src/activity.ts').History, registerActivity() { } } : { register() { } } });
	module.exports.activate({ subscriptions: [], workspaceState: { get: () => [], update: async () => { } } });
	return { controller, execution, notices, commands, executed: () => executed, advance: milliseconds => { now += milliseconds; }, confirm: value => { confirm = value; }, mode: value => { notifications = value; }, disable: () => { enabled = false; }, select: value => { selection = value; }, rejectNotification: () => { rejectNotification = true; } };
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
