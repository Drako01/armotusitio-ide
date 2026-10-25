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

function harness(secrets = undefined, storage = '/private', roots = ['/repo']) {
	const calls = [], errors = [], choices = [], notices = [], commands = [], documents = [], subscriptions = [], state = new Map();
	let trusted = true, custom = false, confirm, entries = [], settings = {}, errorChoice, inputValue, workflowOptions, outputShown = false;
	let native = () => ({ code: 0, output: '[]', error: 'No active task; pass a <task-id>' });
	const vscode = {
		l10n: { t: text => text },
		Uri: { file: fsPath => ({ fsPath }) },
		commands: { executeCommand: async (...args) => { commands.push(args); } },
		workspace: { get isTrusted() { return trusted; }, getConfiguration: (_, uri) => ({ get: (key, fallback) => settings[uri?.fsPath]?.[key] ?? fallback }), workspaceFolders: roots.map(fsPath => ({ uri: { scheme: 'file', fsPath } })), openTextDocument: async value => { documents.push(value); return value; } },
		window: {
			createOutputChannel: () => ({ append() { }, show() { outputShown = true; }, dispose() { } }),
			showErrorMessage: (text, ...options) => { errors.push(text); choices.push(options); return errorChoice?.(options); },
			showInformationMessage: async (text, choice) => { notices.push(text); return choice; },
			showTextDocument: async () => { },
			showInputBox: async () => inputValue,
			showQuickPick: async items => items[0],
			async showWarningMessage(_, __, choice) { return typeof confirm === 'function' ? confirm(choice) : confirm ? choice : undefined; }
		}
	};
	class Workflow {
		busy = new Set();
		children = new Map();
		constructor(options) { workflowOptions = options; }
		all() { return entries; }
		view(entry) { return entry; }
		async prepare(...args) { calls.push(['prepare', ...args]); }
		async start(...args) { calls.push(['start', ...args]); }
		async resume(...args) { calls.push(['resume', ...args]); }
		async stop(...args) { calls.push(['stop', ...args]); }
		async observe(profile, id) { calls.push(['observe', profile.root, id]); }
		async refresh(id) { calls.push(['refresh', id]); }
		dispose() { }
	}
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/workspace.ts'), 'utf8'), { module, process, require: name => name === './adapter.ts' || name === './src/adapter.ts' ? require('../src/adapter.ts') : name === './evidence.ts' ? require('../src/evidence.ts') : name === 'vscode' ? vscode : name === './workflow.ts' ? { HarnessWorkflow: Workflow, redact: require('../src/workflow.ts').redact, nativeRun: async (profile, args) => { calls.push(['native', ...args]); return native(profile, args); } } : name === './catalog.ts' ? { toolArgs } : require(name) });
	const profiles = roots.map(root => ({ id: 'redevent', root, workflow: true, tools }));
	const controller = { progress: [], refresh() { }, async getProvider() { return { custom }; } };
	const workspaceState = { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => { state.set(key, value); } };
	const bridge = module.exports.createWorkspace({ subscriptions, secrets, workspaceState, globalStorageUri: { fsPath: storage } }, controller, async () => profiles.map(profile => ({ profile })));
	return {
		bridge, controller, calls, errors, choices, notices, commands, documents, state, profile: profiles[0],
		changed: () => workflowOptions.changed(), outputShown: () => outputShown,
		entries: value => { entries = value; }, trust: value => { trusted = value; }, custom: value => { custom = value; }, confirm: value => { confirm = value; },
		settings: value => { settings = value; }, native: value => { native = value; }, errorChoice: value => { errorChoice = value; }, input: value => { inputValue = value; }
	};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
// Values created inside the VM context have different prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

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

test('terminal notices open the exact task once per attempt and follow per-project and focus preferences', async () => {
	const h = harness(undefined, '/private', ['/repo', '/other']);
	h.settings({ '/repo': { notifications: 'always' } });
	const task = { id: 'task', nativeId: 'native-task', title: 'Tarea propia', project: '/repo', phase: 'running', origin: 'ide', progress: { attempt: 1 } };
	const other = { id: 'other', nativeId: 'native-other', title: 'Otro proyecto', project: '/other', phase: 'running', origin: 'ide' };
	const external = { id: 'external', nativeId: 'native-external', title: 'Externa', project: '/repo', phase: 'running', origin: 'external' };
	const finish = async (entry, phase, attempt = undefined) => { if (attempt) { entry.phase = 'running'; entry.progress.attempt = attempt; h.changed(); } entry.phase = phase; h.changed(); h.changed(); await tick(); };
	h.entries([task, other, external]); h.changed();
	await finish(task, 'completed');
	await finish(other, 'completed');
	await finish(external, 'failed');
	await h.bridge.receive({ action: 'preferences', value: { focus: true } });
	await finish(task, 'completed', 2);
	await finish(task, 'failed', 3);
	assert.deepEqual(plain({ notices: h.notices, errors: h.errors, commands: h.commands }), {
		notices: ['Tarea completada: Tarea propia'],
		errors: ['La tarea fall\u00f3: Tarea propia'],
		commands: [['atsIde.home', { task: 'native-task', root: '/repo' }]]
	});
});

test('operation errors offer diagnosis and redacted details as concrete next steps', async () => {
	const h = harness();
	h.errorChoice(options => options[0]);
	await h.bridge.receive({ action: 'stopTask', root: '/repo', id: 'missing' }); await tick();
	h.errorChoice(options => options.at(-1));
	await h.bridge.receive({ action: 'stopTask', root: '/repo', id: 'missing' }); await tick();
	assert.deepEqual({ choices: h.choices, diagnosed: h.calls.filter(call => call[0] === 'native'), documents: h.documents.length, output: h.outputShown() }, {
		choices: [['Diagn\u00f3stico', 'Ver detalles'], ['Diagn\u00f3stico', 'Ver detalles']],
		diagnosed: [['native', 'progress', '--json']],
		documents: 1,
		output: true
	});
});

test('tasks started outside the IDE are discovered from the native list and followed by ID', async () => {
	const h = harness();
	h.native((_, args) => args[0] === 'list' ? { code: 0, value: [{ id: 'external-1', status: 'active' }, { id: 'done-1', status: 'active' }, { id: '../escape', status: 'active' }, { id: 'old-1', status: 'completed' }] } : { code: 0, error: 'No active task; pass a <task-id>' });
	h.entries([{ id: 'known', nativeId: 'done-1', project: '/repo', phase: 'completed', checkedAt: Date.now() }]);
	await h.bridge.refresh(true);
	assert.deepEqual(h.calls.filter(call => ['observe', 'refresh'].includes(call[0])), [['observe', '/repo', 'external-1'], ['refresh', 'known'], ['refresh', 'known']]);
});

test('several open projects keep their observations and connection state per root', async () => {
	const h = harness(undefined, '/private', ['/repo', '/other']);
	h.native((profile, args) => args[0] !== 'progress' ? { code: 0, value: [] } : profile.root === '/repo' ? { code: 0, value: { id: 'repo-task' } } : { code: 1, error: 'boom' });
	await h.bridge.refresh(true);
	assert.deepEqual({ observed: h.calls.filter(call => call[0] === 'observe'), repo: h.controller.getHarnessConnection('/repo').observationError, other: h.controller.getHarnessConnection('/other').observationError }, { observed: [['observe', '/repo', 'repo-task']], repo: undefined, other: 'HARNESS_PROGRESS' });
});

test('workspace preferences are sanitized, persisted and restored without other workspaces', async () => {
	const h = harness();
	await h.bridge.receive({ action: 'preferences', value: { compact: true, focus: 'yes', filterState: 'running', filterHost: 'shell', since: '2026-10-25', search: 'token=abc123', expanded: ['active/logs', 42], injected: '<script>' } });
	const { redact } = require('../src/workflow.ts');
	const expected = { filterProject: '', filterState: 'running', filterHost: '', since: '2026-10-25', compact: true, focus: false, pin: '', project: '', search: redact('token=abc123'), expanded: ['active/logs'] };
	assert.deepEqual(plain({ stored: h.state.get('atsHarness.ui.v1'), current: h.controller.getHarnessPreferences() }), { stored: expected, current: expected });
});

test('local templates are saved only on request, reject credentials and reopen as a new draft', async () => {
	const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ats-templates-'));
	try {
		const h = harness(undefined, directory); const opened = [];
		h.controller.openTask = async text => { opened.push(text); };
		h.input('Revisi\u00f3n de API');
		await h.bridge.receive({ action: 'saveTemplate', root: '/repo', text: 'api_key=secret-value' });
		await h.bridge.receive({ action: 'saveTemplate', root: '/repo', text: 'Revisar los contratos de la API' });
		await h.bridge.receive({ action: 'useTemplate', root: '/repo' });
		assert.deepEqual(plain({ names: h.state.get('atsHarness.templates.v1').map(row => row.name), opened, errors: h.errors.length, native: h.calls.filter(call => call[0] !== 'native') }), { names: ['Revisi\u00f3n de API'], opened: ['Revisar los contratos de la API'], errors: 1, native: [] });
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('drafts of several projects survive a reload separately and never create native work', async () => {
	let secret; const storage = { get: async () => secret, store: async (_, value) => { secret = value; } };
	const first = harness(storage, '/private', ['/repo', '/other']);
	await first.bridge.receive({ action: 'saveDraft', root: '/repo', text: 'Borrador del repo' });
	await first.bridge.receive({ action: 'saveDraft', root: '/other', text: 'Borrador del otro proyecto' });
	const second = harness(storage, '/private', ['/repo', '/other']); const restored = [];
	second.controller.restoreHarnessDraft = (root, text) => { restored.push([root, text]); };
	await second.bridge.receive({ action: 'loadDraft', root: '/repo' });
	await second.bridge.receive({ action: 'loadDraft', root: '/other' });
	assert.deepEqual({ restored, calls: [...first.calls, ...second.calls] }, { restored: [['/repo', 'Borrador del repo'], ['/other', 'Borrador del otro proyecto']], calls: [] });
});
