/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, registerChat } = require('../src/chat.ts');

function harness() {
	let trusted = true, enabled = true, confirm = false;
	const calls = [], confirmations = [];
	const names = ['list_projects', 'list_issues', 'get_issue_context', 'get_project_context', 'create_issue', 'transition_issue', 'add_issue_comment'];
	const vscode = { l10n: { t: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) }, workspace: { get isTrusted() { return trusted; } }, window: { async showWarningMessage(text, options, choice) { confirmations.push({ text, options }); return typeof confirm === 'function' ? confirm(choice) : confirm ? choice : undefined; } } };
	const controller = { progress: [{ id: 'RED-1', state: 'running', percent: 42 }], getHistory: () => [], async refreshActivity() { }, async execute(...args) { calls.push(['execute', ...args]); return 'started'; } };
	const client = { tools: async () => names.map(name => ({ name })), async call(...args) { calls.push(args); return { structuredContent: { ok: true } }; } };
	const projects = async () => [{ profile: { name: 'RedEvent', id: 'redevent', root: '/repo', actions: ['check'] }, folder: { uri: { toString: () => 'file:///repo' } } }];
	return { controller, handle: createHandler(vscode, controller, projects, { client, enabled: () => enabled }), calls, confirmations, names, client, trust: value => { trusted = value; }, enable: value => { enabled = value; }, confirm: value => { confirm = value; } };
}

test('chat uses actual progress and controller tasks without executing arbitrary instructions', async () => {
	const h = harness();
	assert.match(await h.handle('@harness estado'), /RED-1.*42%/);
	assert.match(await h.handle('/comandos'), /RedEvent: check/);
	assert.match(await h.handle('@harness check'), /iniciada/);
	assert.deepEqual(h.calls[0], ['execute', 'file:///repo', 'check', undefined]);
	await h.handle('@harness check && del files'); await h.handle('run'); await h.handle('@harnesscheck');
	assert.equal(h.calls.length, 1);
	h.trust(false); await h.handle('check'); await h.handle('proyectos'); assert.equal(h.calls.length, 1);
});

test('chat maps Work Management queries to fixed MCP tools and validated arguments', async () => {
	const h = harness();
	await h.handle('proyectos'); await h.handle('tareas RED'); await h.handle('tarea RED-001-219');
	assert.deepEqual(h.calls.map(call => call.slice(0, 2)), [
		['list_projects', {}], ['list_issues', { project: 'RED' }], ['get_issue_context', { issue_key: 'RED-001-219' }]
	]);
	h.enable(false); await h.handle('proyectos'); assert.equal(h.calls.length, 3);
});

test('MCP mutations require allowed tools, current context and explicit reviewable confirmation', async () => {
	for (const [prompt, tool, args, context] of [
		['crear RED Nueva tarea', 'create_issue', { project: 'RED', title: 'Nueva tarea' }, 'get_project_context'],
		['mover RED-219 7', 'transition_issue', { issue_key: 'RED-219', board_column_id: 7 }, 'get_issue_context'],
		['comentar RED-219 Revisar esto', 'add_issue_comment', { issue_key: 'RED-219', content: 'Revisar esto' }, 'get_issue_context']
	]) {
		const h = harness();
		await h.handle(prompt); assert.deepEqual(h.calls.map(call => call[0]), [context]);
		assert.equal(h.confirmations[0].options.modal, true); assert.match(h.confirmations[0].text, /RED/);
		h.confirm(true); await h.handle(prompt);
		assert.equal(h.calls.at(-2)[0], context); assert.equal(h.calls.at(-1)[0], tool); assert.deepEqual(h.calls.at(-1)[1], args);
		const denied = harness(); denied.names.splice(denied.names.indexOf(tool), 1); denied.confirm(true);
		await denied.handle(prompt); assert.deepEqual(denied.calls, []); assert.deepEqual(denied.confirmations, []);
	}
});

test('cancellation, malformed mutations and MCP errors cannot bypass confirmation or disclose raw errors', async () => {
	const h = harness(); h.confirm(true);
	await h.handle('mover RED-1 -1'); await h.handle('mover RED-1 9007199254740992');
	await h.handle('proyectos', { isCancellationRequested: true }); assert.deepEqual(h.calls, []);
	h.client.call = async () => { throw new Error('private response token'); };
	assert.doesNotMatch(await h.handle('proyectos'), /private response token/);
	await h.handle('comentar RED-1 Hola'); assert.equal(h.confirmations.length, 0);
});

test('cancelling during confirmation prevents a Work Management mutation', async () => {
	const h = harness(); const token = { isCancellationRequested: false };
	h.confirm(choice => { token.isCancellationRequested = true; return choice; });
	await h.handle('mover RED-1 7', token);
	assert.deepEqual(h.calls.map(call => call[0]), ['get_issue_context']); assert.equal(h.confirmations.length, 1);
});

test('native chat participant dispatches explicit slash commands as escaped text without a model API', async () => {
	let handler, response;
	const noop = () => ({ dispose() { } });
	const vscode = {
		l10n: { t: value => value }, workspace: { isTrusted: true },
		chat: { createChatParticipant(id, fn) { assert.equal(id, 'atsIde.harness'); handler = fn; return noop(); } },
		Uri: { joinPath: (base, ...parts) => base + '/' + parts.join('/') }, commands: { registerCommand: noop },
		MarkdownString: class { value = ''; appendText(value) { this.value += value; } }
	};
	const projects = async () => [{ profile: { name: '<untrusted>', actions: ['check'] } }];
	const context = { extensionUri: 'extension', subscriptions: [] };
	registerChat(context, {}, projects, { enabled: () => false }, vscode);
	await handler({ command: 'comandos', prompt: '' }, {}, { markdown: value => { response = value; } }, { isCancellationRequested: false });
	assert.equal(response.value, '<untrusted>: check');
	assert.equal(response.isTrusted, undefined);
	context.subscriptions.forEach(item => item.dispose());
});


test('task preparation and local status work without optional Work Management', async () => {
	const h = harness(); h.enable(false);
	h.controller.openTask = async text => { h.calls.push(['prepare', text]); };
	h.controller.nativeProjects = async () => [{ name: 'Generic', tasks: [{ title: 'Local verification', status: 'passed' }] }];
	assert.match(await h.handle('Corregir el formulario'), /Preparar tarea/);
	assert.match(await h.handle('estado'), /Generic: Local verification.*Completada/);
	assert.match(await h.handle('comandos'), /Generic/);
	assert.match(await h.handle('proyectos'), /opcional/);
	assert.deepEqual(h.calls, [['prepare', 'Corregir el formulario']]);
});
