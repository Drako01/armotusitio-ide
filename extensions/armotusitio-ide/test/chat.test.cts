/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, registerChat, probeMcpConnection, probeProvider } = require('../src/chat.ts');

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


test('free text in the command participant points to Chat Harness and never opens Home', async () => {
	const h = harness(); h.enable(false);
	h.controller.openTask = async text => { h.calls.push(['prepare', text]); };
	h.controller.nativeProjects = async () => [{ name: 'Generic', tasks: [{ title: 'Local verification', status: 'passed' }] }];
	assert.match(await h.handle('Corregir el formulario'), /Chat Harness/);
	assert.match(await h.handle('estado'), /Generic: Local verification.*Completada/);
	assert.match(await h.handle('comandos'), /Generic/);
	assert.match(await h.handle('proyectos'), /opcional/);
	assert.deepEqual(h.calls, []);
});

test('MCP indicator reports a real handshake, never a stored key alone, and resets failed sessions', async () => {
	const vscode = { workspace: { isTrusted: true } };
	let resets = 0;
	const mcp = (enabled, configured, tools) => ({ enabled: () => enabled, credentialState: async () => ({ configured }), client: { tools, reset: () => { resets++; } } });
	const states = [
		await probeMcpConnection({ workspace: { isTrusted: false } }, mcp(true, true, async () => [])),
		await probeMcpConnection(vscode, mcp(false, true, async () => [])),
		await probeMcpConnection(vscode, mcp(true, false, async () => [])),
		await probeMcpConnection(vscode, mcp(true, true, async () => [{ name: 'a' }, { name: 'b' }])),
		await probeMcpConnection(vscode, mcp(true, true, async () => { throw new Error('MCP_AUTH'); })),
		await probeMcpConnection(vscode, mcp(true, true, async () => { throw new Error('fetch failed: secret-token'); }))
	].map(({ checkedAt, ...rest }) => rest);
	assert.deepEqual(states, [
		{ state: 'disconnected', reason: 'untrusted' }, { state: 'disconnected', reason: 'disabled' }, { state: 'disconnected', reason: 'missing-key' },
		{ state: 'connected', tools: 2 }, { state: 'error', reason: 'auth' }, { state: 'error', reason: 'network' }
	]);
	assert.equal(resets, 2);
	assert.deepEqual(await Promise.all([
		probeProvider('claude', async () => ({ installed: true, version: '2.1.0', localSession: 'authenticated', commandCompatibility: 'verified' })),
		probeProvider('codex', async () => ({ installed: false, version: null })),
		probeProvider('codex', async () => ({ installed: true, version: '0.5.0', localSession: 'unauthenticated', commandCompatibility: 'verified' })),
		probeProvider('codex', async () => { throw new Error('boom'); })
	]), [{ status: 'ready', version: '2.1.0' }, { status: 'unavailable' }, { status: 'unauthenticated', version: '0.5.0' }, { status: 'unknown' }]);
});

test('Markdown renderer input is parsed into inert blocks', () => {
	const { parseMarkdown } = require('../resources/markdown.ts');
	const blocks = parseMarkdown('## Plan\n\nUsar **Prisma** y `npm test` [docs](https://x.test)\n\n1. Modelo\n2. API\n\n```ts\n<script>alert(1)</script>\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
	assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'list', 'code', 'table']);
	assert.deepEqual(blocks[1].inlines.map(part => part.type), ['text', 'strong', 'text', 'code', 'text', 'link']);
	assert.equal(blocks[3].text, '<script>alert(1)</script>');
	assert.equal(blocks[2].items.length, 2);
});

/** End-to-end panel flow with a scripted runtime: the only fake is the AI provider behind the engine boundary. */
test('Chat Harness panel: converse, revise, approve and follow execution without leaving the chat', async () => {
	const os = require('node:os'); const fsp = require('node:fs/promises'); const path = require('node:path');
	const storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'ats-chat-panel-'));
	const root = await fsp.realpath(storage);
	const posted = [], executed = [], calls = [];
	let receive;
	const noop = () => ({ dispose() { } });
	const panel = { reveal() { }, onDidDispose: noop, dispose() { }, webview: { cspSource: 'csp', asWebviewUri: value => value, onDidReceiveMessage: fn => { receive = fn; return noop(); }, postMessage: async value => { posted.push(JSON.parse(JSON.stringify(value))); return true; } } };
	const commands = new Map();
	const folder = { name: 'clientes', uri: { fsPath: root, toString: () => 'file:///clientes' } };
	const vscode = {
		l10n: { t: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) }, ViewColumn: { One: 1 },
		Uri: { joinPath: (base, ...parts) => base + '/' + parts.join('/') },
		workspace: { isTrusted: true, workspaceFolders: [folder], getConfiguration: () => ({ get: (_, fallback) => fallback }) },
		window: { createWebviewPanel: () => panel, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
		commands: { registerCommand: (id, fn) => { commands.set(id, fn); return noop(); }, executeCommand: async (...args) => { executed.push(args); } },
		CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: noop }; cancel() { this.token.isCancellationRequested = true; } dispose() { } }
	};
	const answer = text => ({ status: 'passed', exitCode: 0, durationMs: 1, output: text, truncated: false });
	const replies = [
		'\u00bfQu\u00e9 datos guard\u00e1s de cada cliente?',
		'Listo.\n```harness-plan\n{"title":"CRUD de clientes","summary":"API REST","steps":["Modelo","Endpoints"],"files":["src/clients.ts"]}\n```',
		'Sumo paginaci\u00f3n.\n```harness-plan\n{"title":"CRUD de clientes","summary":"API REST","steps":["Modelo","Endpoints","Paginaci\u00f3n"]}\n```'
	];
	const controller = {
		nativeChatRuntime: () => ({
			async context() { return { root, writer: true, skills: [], guides: [], verification: { revision: 'c'.repeat(64), gates: [{ id: 'unit', command: 'npm test' }] } }; },
			async converse(provider, instruction, hooks) { calls.push(['converse', provider]); hooks.started(() => undefined); return answer(replies.shift()); },
			async implement(request, hooks) {
				calls.push(['implement', request.provider, request.plan.version]);
				hooks.started(() => undefined); hooks.stage('verifying'); hooks.gates([{ id: 'unit', status: 'running' }]);
				return { agent: answer('Cre\u00e9 src/clients.ts'), verification: { status: 'passed', gates: [{ id: 'unit', status: 'passed' }] } };
			}
		})
	};
	const mcp = { enabled: () => true, credentialState: async () => ({ configured: true }), client: { tools: async () => [{ name: 'list_projects' }], reset() { } } };
	const context = { extensionUri: 'ext', subscriptions: [], globalStorageUri: { fsPath: path.join(storage, 'private') }, workspaceState: { get: () => undefined, update: async () => undefined } };
	const diagnose = async provider => ({ installed: true, version: '1.0.0', localSession: provider === 'claude' ? 'authenticated' : 'unauthenticated', commandCompatibility: 'verified' });
	try {
		registerChat(context, controller, async () => [], mcp, vscode, { diagnose });
		await commands.get('atsIde.chat')();
		await receive({ action: 'ready' });
		await new Promise(resolve => setTimeout(resolve, 50));
		const state = () => posted.filter(item => item.type === 'state').at(-1);
		assert.ok(posted.some(item => item.type === 'init' && item.labels.approve === 'Aprobar y ejecutar' && item.labels.plan === 'Plan v{0}' && item.labels.executing === 'Ejecutando plan v{0} con {1}'));
		assert.deepEqual({ claude: state().providers.claude.status, codex: state().providers.codex.status, mcp: state().mcp.state, tools: state().mcp.tools, host: state().mcp.endpoint },
			{ claude: 'ready', codex: 'unauthenticated', mcp: 'connected', tools: 1, host: 'armotusitio.com.ar' });
		assert.equal(JSON.stringify(posted).includes('X-ATS-Agent-Key'), false);
		await receive({ action: 'provider', provider: 'codex' });
		await receive({ action: 'send', text: 'Quiero agregar un CRUD de clientes' });
		await receive({ action: 'send', text: 'Nombre, email y CUIT' });
		const v1 = state().chat.plan;
		await receive({ action: 'send', text: 'Cambios al plan: agreg\u00e1 paginaci\u00f3n' });
		const v2 = state().chat.plan;
		assert.deepEqual({ v1: v1.version, v2: v2.version, approvable: v2.approvable, verification: state().chat.verification }, { v1: 1, v2: 2, approvable: true, verification: [{ id: 'unit', command: 'npm test' }] });
		await receive({ action: 'approve', digest: v1.digest });
		assert.equal(calls.filter(call => call[0] === 'implement').length, 0);
		await receive({ action: 'approve', digest: v2.digest });
		const messages = state().chat.messages;
		assert.deepEqual(calls, [['converse', 'codex'], ['converse', 'codex'], ['converse', 'codex'], ['implement', 'codex', 2]]);
		assert.deepEqual({ last: messages.at(-1).role, status: messages.at(-1).run.status, gates: messages.at(-1).run.verification.gates.map(gate => gate.status) }, { last: 'run', status: 'passed', gates: ['passed'] });
		assert.ok(posted.some(item => item.type === 'state' && item.chat?.activity?.stage === 'verifying'));
		// Slash commands stay inside the conversation as local results.
		await receive({ action: 'send', text: '/ayuda' });
		assert.match(state().chat.messages.at(-1).text, /Comandos:/);
		// Nothing in the flow navigates to Home.
		assert.deepEqual(executed.filter(args => args[0] === 'atsIde.home'), []);
	} finally {
		context.subscriptions.forEach(item => item.dispose());
		await fsp.rm(storage, { recursive: true, force: true });
	}
});
