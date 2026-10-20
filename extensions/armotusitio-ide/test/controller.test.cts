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

function harness(trusted = true) {
	let controller, executed = 0, confirm = 'Run';
	const disposable = { dispose() { } };
	const noopEvent = () => disposable;
	const execution = { terminate() { this.terminated = true; } };
	const vscode = {
		EventEmitter: class { constructor() { this.event = noopEvent; } fire() { } dispose() { } },
		l10n: { t: text => text },
		workspace: {
			isTrusted: trusted, getConfiguration: () => ({ get: (key, fallback) => key === 'showWelcome' ? false : fallback }),
			workspaceFolders: [{ uri: { fsPath: '/repo', toString: () => 'file:///repo' } }],
			onDidChangeConfiguration: noopEvent, onDidChangeWorkspaceFolders: noopEvent,
			createFileSystemWatcher: () => ({ dispose() { }, onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent })
		},
		window: {
			registerTreeDataProvider(_, value) { controller = value; return disposable; },
			showWarningMessage: async () => confirm, showQuickPick: async entries => entries[0], showInformationMessage() { }
		},
		commands: { registerCommand: () => disposable },
		Task: class { }, ProcessExecution: class { }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { New: 1 },
		tasks: { async executeTask() { executed++; return execution; }, onDidEndTaskProcess: noopEvent, onDidEndTask: noopEvent }
	};
	const module = { exports: {} };
	const core = { detect: () => ({ root: '/repo', name: 'RedEvent', id: 'redevent', actions: ['check'] }), command: () => ({ executable: 'pnpm', args: ['harness:check'], cwd: '/repo' }) };
	vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../extension.ts'), 'utf8')), { module, require: n => n === 'vscode' ? vscode : n === './src/core.ts' ? core : n === './src/home.ts' ? { registerHome() { } } : n === './src/activity.ts' ? { History: require('../src/activity.ts').History, registerActivity() { } } : { register() { } } });
	module.exports.activate({ subscriptions: [], workspaceState: { get: () => [], update: async () => { } } });
	return { controller, execution, executed: () => executed, confirm: value => { confirm = value; } };
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
