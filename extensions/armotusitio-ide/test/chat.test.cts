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
	const vscode = { l10n: { t: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) }, workspace: { get isTrusted() { return trusted; }, getConfiguration: () => ({ get: () => undefined }) }, window: { async showWarningMessage(text, options, choice) { confirmations.push({ text, options }); return typeof confirm === 'function' ? confirm(choice) : confirm ? choice : undefined; } } };
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
		l10n: { t: value => value }, workspace: { isTrusted: true, getConfiguration: () => ({ get: () => undefined }) },
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

/**
 * Real `registerChat` host and session with a scripted runtime: the only fake is the AI provider behind
 * the engine boundary. `state()` rebuilds what the webview sees, reusing the history when it is omitted.
 */
async function panelFixture(replies, providerStatus = { claude: 'authenticated', codex: 'unauthenticated' }, options = { folders: 1, confirm: undefined }) {
	const os = require('node:os'); const fsp = require('node:fs/promises'); const path = require('node:path');
	const storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'ats-chat-panel-'));
	const root = await fsp.realpath(storage);
	const posted = [], executed = [], calls = [], instructions = [], approvals = [];
	let receive;
	const noop = () => ({ dispose() { } });
	const panel = { reveal() { }, onDidDispose: noop, dispose() { }, webview: { cspSource: 'csp', asWebviewUri: value => value, onDidReceiveMessage: fn => { receive = fn; return noop(); }, postMessage: async value => { posted.push(JSON.parse(JSON.stringify(value))); return true; } } };
	const commands = new Map();
	const workspaceFolders = [];
	for (let index = 0; index < options.folders; index++) {
		const fsPath = index ? path.join(root, 'project-' + index) : root;
		await fsp.mkdir(fsPath, { recursive: true });
		workspaceFolders.push({ name: index ? 'proyecto-' + index : 'clientes', uri: { fsPath, toString: () => 'file:///' + (index ? 'proyecto-' + index : 'clientes') } });
	}
	const memento = new Map();
	const settings = new Map([['chatMode', 'ask']]);
	const vscode = {
		l10n: { t: (text, ...args) => text.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) }, ViewColumn: { One: 1 },
		Uri: { joinPath: (base, ...parts) => base + '/' + parts.join('/'), file: fsPath => ({ fsPath }) },
		workspace: { isTrusted: true, workspaceFolders, getConfiguration: () => ({ get: (key, fallback) => settings.get(key) ?? fallback, update: async (key, value) => { settings.set(key, value); } }) },
		window: { createWebviewPanel: () => panel, showWarningMessage: async (_text, _options, choice) => options.confirm ? choice : undefined, showErrorMessage: async () => undefined },
		commands: { registerCommand: (id, fn) => { commands.set(id, fn); return noop(); }, executeCommand: async (...args) => { executed.push(args); } },
		CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: noop }; cancel() { this.token.isCancellationRequested = true; } dispose() { } }
	};
	const answer = text => ({ status: 'passed', exitCode: 0, durationMs: 1, output: text, truncated: false });
	const controller = {
		nativeChatRuntime: folder => ({
			root: folder.uri.fsPath,
			async context() { return { root: this.root, writer: true, skills: [], guides: [], verification: { revision: 'c'.repeat(64), gates: [{ id: 'unit', command: 'npm test' }] } }; },
			async converse(provider, instruction, hooks) {
				calls.push(['converse', provider]); instructions.push(instruction); hooks.started(() => undefined); hooks.progress(8192); hooks.progress(16384);
				const reply = replies.shift();
				return typeof reply === 'string' ? answer(reply) : { ...answer(reply.text), usage: reply.usage, quota: reply.quota };
			},
			async discard(diff) { return { discarded: diff.files.map(file => file.path), skipped: [] }; },
			async implement(request, hooks) {
				calls.push(['implement', request.provider, request.plan.version]);
				hooks.started(() => undefined); hooks.stage('verifying'); hooks.gates([{ id: 'unit', status: 'running' }]);
				if (request.instruction.includes('pedir aprobacion')) { approvals.push(await hooks.approval({ kind: 'git_push', title: 'Push', detail: ['branch: feat/x'], rule: 'git_push' })); }
				return { agent: answer('Cre\u00e9 src/clients.ts'), verification: { status: 'passed', gates: [{ id: 'unit', status: 'passed' }] }, diff: { available: true, files: [{ path: 'src/clients.ts', change: 'added', preexisting: false }], count: 1 } };
			}
		})
	};
	const mcp = { enabled: () => true, credentialState: async () => ({ configured: true }), client: { tools: async () => [{ name: 'list_projects' }], reset() { } } };
	const context = { extensionUri: 'ext', subscriptions: [], globalStorageUri: { fsPath: process.platform === 'win32' ? path.join(storage, 'private').replace(/^[A-Z]:/, drive => drive.toLowerCase()) : path.join(storage, 'private') }, workspaceState: { get: key => memento.get(key), update: async (key, value) => { memento.set(key, value); } } };
	const diagnose = async provider => providerStatus[provider] === 'missing' ? { installed: false, version: null } : ({ installed: true, version: '1.0.0', localSession: providerStatus[provider], commandCompatibility: 'verified' });
	const listModels = async provider => provider === 'claude' ? { defaultModel: 'opus', options: [{ id: 'sonnet', label: 'Sonnet' }] } : { options: [] };
	registerChat(context, controller, async () => [], mcp, vscode, { diagnose, listModels });
	await commands.get('atsIde.chat')();
	await receive({ action: 'ready' });
	await new Promise(resolve => setTimeout(resolve, 50));
	const state = () => {
		let messages = [];
		const states = posted.filter(item => item.type === 'state');
		for (const item of states) { if (item.chat?.messages) { messages = item.chat.messages; } }
		const last = states.at(-1);
		return { ...last, chat: last.chat && { ...last.chat, messages: last.chat.messages ?? messages } };
	};
	const cleanup = async () => { context.subscriptions.forEach(item => item.dispose()); await fsp.rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };
	return { receive, state, posted, calls, executed, instructions, approvals, root, settings, cleanup };
}

test('Chat Harness panel: converse, revise, approve and follow execution without leaving the chat', async () => {
	const f = await panelFixture([
		'\u00bfQu\u00e9 datos guard\u00e1s de cada cliente?',
		'Listo.\n```harness-plan\n{"title":"CRUD de clientes","summary":"API REST","steps":["Modelo","Endpoints"],"files":["src/clients.ts"]}\n```',
		'Sumo paginaci\u00f3n.\n```harness-plan\n{"title":"CRUD de clientes","summary":"API REST","steps":["Modelo","Endpoints","Paginaci\u00f3n"]}\n```'
	]);
	try {
		const { receive, state, posted, calls, executed } = f;
		assert.ok(posted.some(item => item.type === 'init' && item.labels.approve === 'Aprobar y ejecutar' && item.labels.plan === 'Plan v{0}' && item.labels.executing === 'Ejecutando plan v{0} con {1}'));
		assert.deepEqual({ claude: state().providers.claude.status, codex: state().providers.codex.status, mcp: state().mcp.state, tools: state().mcp.tools, host: state().mcp.endpoint },
			{ claude: 'ready', codex: 'unauthenticated', mcp: 'connected', tools: 1, host: 'armotusitio.com.ar' });
		assert.equal(JSON.stringify(posted).includes('X-ATS-Agent-Key'), false);
		// The model is a validated user setting: a flag-like value is ignored, a listed model is stored.
		await receive({ action: 'model', provider: 'claude', model: '--dangerously-skip-permissions' });
		await receive({ action: 'model', provider: 'claude', model: 'sonnet' });
		assert.deepEqual(state().models, { claude: { defaultModel: 'opus', options: [{ id: 'sonnet', label: 'Sonnet' }], selected: 'sonnet' }, codex: { options: [], selected: '' } });
		await receive({ action: 'effort', provider: 'claude', effort: '--unsafe' });
		assert.equal(state().efforts.claude, '');
		await receive({ action: 'effort', provider: 'claude', effort: 'medium' });
		assert.equal(state().efforts.claude, 'medium');
		await receive({ action: 'effort', provider: 'codex', effort: 'max' });
		assert.equal(state().efforts.codex, '');
		await receive({ action: 'effort', provider: 'codex', effort: 'low' });
		assert.equal(state().efforts.codex, 'low');
		await receive({ action: 'provider', provider: 'codex' });
		assert.equal(state().efforts.claude, 'medium');
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
	} finally { await f.cleanup(); }
});

test('progress updates omit the unchanged history, and a webview reload gets it again', async () => {
	const f = await panelFixture(['respuesta']);
	try {
		await f.receive({ action: 'send', text: 'hola' });
		const progress = f.posted.filter(item => item.type === 'state' && item.chat?.activity?.observedBytes === 16384);
		assert.ok(progress.length > 0 && progress.every(item => item.chat.messages === undefined));
		const before = f.posted.length;
		await f.receive({ action: 'ready' });
		const reloaded = f.posted.slice(before).find(item => item.type === 'state' && item.chat);
		assert.deepEqual(reloaded.chat.messages.map(message => message.role), ['user', 'assistant']);
	} finally { await f.cleanup(); }
});

test('a provider that is not installed is reported before spending a turn, keeping the user text', async () => {
	const f = await panelFixture(['nunca'], { claude: 'missing', codex: 'authenticated' });
	try {
		await f.receive({ action: 'provider', provider: 'claude' });
		await f.receive({ action: 'send', text: 'Explicame el proyecto' });
		const last = f.state().chat.messages.at(-1);
		assert.deepEqual({ calls: f.calls.length, role: last.role, kept: last.text.includes('Explicame el proyecto'), named: last.text.includes('Claude Code') }, { calls: 0, role: 'notice', kept: true, named: true });
	} finally { await f.cleanup(); }
});

test('each project keeps its own conversation; switching never mixes or leaks history', async () => {
	const f = await panelFixture(['respuesta para clientes', 'respuesta para proyecto-1'], undefined, { folders: 2, confirm: true });
	try {
		await f.receive({ action: 'send', text: 'mensaje de clientes' });
		await f.receive({ action: 'project', id: 'file:///proyecto-1' });
		assert.deepEqual({ project: f.state().project.name, messages: f.state().chat.messages.length }, { project: 'proyecto-1', messages: 0 });
		await f.receive({ action: 'send', text: 'mensaje de proyecto-1' });
		await f.receive({ action: 'project', id: 'file:///clientes' });
		assert.deepEqual(f.state().chat.messages.map(message => message.text), ['mensaje de clientes', 'respuesta para clientes']);
		// An unknown project id from the webview is ignored, never created.
		await f.receive({ action: 'project', id: 'file:///otro' });
		assert.equal(f.state().project.name, 'clientes');
		// A confirmed reset clears only the selected project.
		await f.receive({ action: 'reset' });
		assert.equal(f.state().chat.messages.length, 0);
		await f.receive({ action: 'project', id: 'file:///proyecto-1' });
		assert.deepEqual(f.state().chat.messages.map(message => message.text), ['mensaje de proyecto-1', 'respuesta para proyecto-1']);
	} finally { await f.cleanup(); }
});

test('review #7: switching away before a project loads and back again keeps the visible history', async () => {
	const f = await panelFixture(['respuesta A'], undefined, { folders: 2, confirm: false });
	try {
		await f.receive({ action: 'send', text: 'mensaje A' });
		// The second project starts loading; the user returns before it finishes.
		const away = f.receive({ action: 'project', id: 'file:///proyecto-1' });
		const back = f.receive({ action: 'project', id: 'file:///clientes' });
		await Promise.all([away, back]);
		assert.deepEqual({ project: f.state().project.name, messages: f.state().chat.messages.map(message => message.text) },
			{ project: 'clientes', messages: ['mensaje A', 'respuesta A'] });
	} finally { await f.cleanup(); }
});

test('the chat mode is a user setting: Act sends a direct run, Ask only converses', async () => {
	const f = await panelFixture(['Es una pregunta.']);
	try {
		assert.equal(f.state().chatMode, 'ask');
		await f.receive({ action: 'mode', mode: 'bogus' });
		assert.equal(f.state().chatMode, 'ask');
		await f.receive({ action: 'send', text: 'Una pregunta' });
		await f.receive({ action: 'mode', mode: 'act' });
		assert.equal(f.state().chatMode, 'act');
		await f.receive({ action: 'send', text: 'Correg\u00ed el foco del modal' });
		assert.deepEqual(f.calls.map(call => call[0]), ['converse', 'implement']);
		assert.equal(f.calls[1][2], 0);
	} finally { await f.cleanup(); }
});

test('slash commands: /ayuda is generated from the command table and the new commands are all listed', async () => {
	const f = await panelFixture([]);
	try {
		const { chatCommands } = require('../src/native-chat-commands.ts');
		await f.receive({ action: 'send', text: '/ayuda' });
		const help = f.state().chat.messages.at(-1).text;
		const names = chatCommands(text => text).map(command => command.name);
		for (const name of ['ayuda', 'permisos', 'modo', 'deshacer', 'doctor', 'auditoria', 'costo', 'estado', 'comentar']) { assert.ok(names.includes(name), name); }
		for (const name of names) { assert.ok(help.includes('/' + name), name); }
		// The autocomplete in the composer receives the same table.
		assert.deepEqual(f.posted.find(item => item.type === 'init').labels.commandList.map(command => command.name), names);
	} finally { await f.cleanup(); }
});

test('/modo shows and changes the chat mode in user settings', async () => {
	const f = await panelFixture([]);
	try {
		const last = () => f.state().chat.messages.at(-1).text;
		await f.receive({ action: 'send', text: '/modo' });
		assert.match(last(), /Modo actual: Preguntar/);
		await f.receive({ action: 'send', text: '/modo actuar' });
		assert.match(last(), /Modo cambiado a Actuar/);
		assert.equal(f.settings.get('chatMode'), 'act');
		assert.equal(f.state().chatMode, 'act');
		await f.receive({ action: 'send', text: '/modo volando' });
		assert.match(last(), /Uso: \/modo/);
		assert.equal(f.settings.get('chatMode'), 'act');
	} finally { await f.cleanup(); }
});

test('/costo reports only what the provider reported, and says so when it did not', async () => {
	const f = await panelFixture(['sin uso', { text: 'con uso', usage: { inputTokens: 1200, outputTokens: 340, cachedInputTokens: 900 } }]);
	try {
		const last = () => f.state().chat.messages.at(-1).text;
		await f.receive({ action: 'send', text: '/costo' });
		assert.match(last(), /no inform\u00f3/);
		await f.receive({ action: 'send', text: 'hola' });
		await f.receive({ action: 'send', text: '/costo' });
		assert.match(last(), /no inform\u00f3/);
		await f.receive({ action: 'send', text: 'otra' });
		await f.receive({ action: 'send', text: '/costo' });
		assert.match(last(), /Entrada: 1200 tokens[\s\S]*Salida: 340 tokens[\s\S]*cach\u00e9: 900 tokens/);
		assert.ok(!/Costo estimado/.test(last()));
	} finally { await f.cleanup(); }
});

test('/deshacer discards the last direct run when it can and explains why when it cannot', async () => {
	const f = await panelFixture([], undefined, { folders: 1, confirm: true });
	try {
		const last = () => f.state().chat.messages.at(-1).text;
		await f.receive({ action: 'send', text: '/deshacer' });
		assert.match(last(), /Todav\u00eda no hay ninguna ejecuci\u00f3n/);
		await f.receive({ action: 'send', text: '/modo actuar' });
		await f.receive({ action: 'send', text: 'agrega un archivo' });
		assert.equal(f.state().chat.messages.at(-1).role, 'run');
		await f.receive({ action: 'send', text: '/deshacer' });
		assert.ok(f.state().chat.messages.some(message => /Se descartaron 1 archivos/.test(message.text)));
		assert.ok(f.state().chat.messages.at(-1).text.includes('descart\u00e9 los cambios'));
		await f.receive({ action: 'send', text: '/deshacer' });
		assert.match(last(), /ya se descartaron/);
	} finally { await f.cleanup(); }
	const declined = await panelFixture([], undefined, { folders: 1, confirm: false });
	try {
		await declined.receive({ action: 'send', text: '/modo actuar' });
		await declined.receive({ action: 'send', text: 'agrega un archivo' });
		await declined.receive({ action: 'send', text: '/deshacer' });
		assert.match(declined.state().chat.messages.at(-1).text, /cancelado/);
		assert.ok(!declined.state().chat.messages.some(message => /Se descartaron/.test(message.text)));
	} finally { await declined.cleanup(); }
});

test('/permisos shows the effective rules and creates then opens the JSON files without overwriting', async () => {
	const os = require('node:os'); const fsp = require('node:fs/promises'); const path = require('node:path');
	const f = await panelFixture([]);
	try {
		const last = () => f.state().chat.messages.at(-1).text;
		await f.receive({ action: 'send', text: '/permisos' });
		assert.match(last(), /Permisos efectivos:[\s\S]*preset dev[\s\S]*Archivos:[\s\S]*\.armotusitio\/permissions\.json \u2014 no existe/);
		const file = path.join(f.root, '.armotusitio', 'permissions.json');
		await f.receive({ action: 'send', text: '/permisos proyecto' });
		assert.match(last(), /Cre\u00e9 \.armotusitio\/permissions\.json/);
		assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), { version: 1, allow: [], ask: [], deny: [] });
		assert.deepEqual(f.executed.at(-1).slice(0, 1), ['vscode.open']);
		assert.equal(f.executed.at(-1)[1].fsPath, file);
		await fsp.writeFile(file, JSON.stringify({ version: 1, deny: ['run:rm *'] }));
		await f.receive({ action: 'send', text: '/permisos proyecto' });
		assert.match(last(), /^`\/permisos proyecto`[\s\S]*Abr\u00ed/);
		assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).deny[0], 'run:rm *');
		await f.receive({ action: 'send', text: '/permisos' });
		assert.match(last(), /deny: run:rm \*/);
		await f.receive({ action: 'send', text: '/permisos otro' });
		assert.match(last(), /Uso: \/permisos/);
	} finally { await f.cleanup(); }
});

test('@file mentions reach the model as bounded data and refusals are reported in the chat', async () => {
	const fsp = require('node:fs/promises'); const path = require('node:path');
	const f = await panelFixture(['listo']);
	try {
		await fsp.mkdir(path.join(f.root, 'src'), { recursive: true });
		await fsp.writeFile(path.join(f.root, 'src', 'a.ts'), 'export const a = 1;');
		await fsp.writeFile(path.join(f.root, '.env'), 'SECRET=hunter2');
		await f.receive({ action: 'send', text: 'revisa @src/a.ts y @.env y @../fuera.txt' });
		const messages = f.state().chat.messages;
		assert.deepEqual(messages.map(message => message.role), ['user', 'notice', 'assistant']);
		assert.equal(messages[0].text, 'revisa @src/a.ts y @.env y @../fuera.txt');
		assert.match(messages[1].text, /Adjunt\u00e9 como contexto: src\/a\.ts\.\nNo adjunt\u00e9 @\.env: es un archivo sensible[\s\S]*@\.\.\/fuera\.txt: est\u00e1 fuera del proyecto/);
		assert.match(f.instructions[0], /<mention path="src\/a\.ts">\nexport const a = 1;\n<\/mention>/);
		assert.ok(!f.instructions[0].includes('hunter2'));
		// The file content is not stored in the history.
		assert.ok(!messages.some(message => message.text.includes('export const a')));
	} finally { await f.cleanup(); }
});

test('@ autocomplete answers with project files, never credentials, and ignores stale or malformed requests', async () => {
	const fsp = require('node:fs/promises'); const path = require('node:path');
	const f = await panelFixture([]);
	try {
		await fsp.mkdir(path.join(f.root, 'src'), { recursive: true });
		await fsp.writeFile(path.join(f.root, 'src', 'app.ts'), 'x');
		await fsp.writeFile(path.join(f.root, '.env'), 'x');
		await f.receive({ action: 'complete', kind: 'mention', query: 'app', seq: 7 });
		await f.receive({ action: 'complete', kind: 'mention', query: 'env', seq: 8 });
		await f.receive({ action: 'complete', kind: 'mention', query: 'x'.repeat(301), seq: 9 });
		await f.receive({ action: 'complete', kind: 'mention', query: 'app', seq: 'nope' });
		assert.deepEqual(f.posted.filter(item => item.type === 'completions').map(({ seq, items }) => ({ seq, items })), [{ seq: 7, items: ['src/app.ts'] }, { seq: 8, items: [] }]);
	} finally { await f.cleanup(); }
});

test('an approval card reaches the webview and only a well-formed answer from it resolves the pending request', async () => {
	const f = await panelFixture([]);
	try {
		await f.receive({ action: 'mode', mode: 'act' });
		const running = f.receive({ action: 'send', text: 'pedir aprobacion' });
		while (!f.state().chat?.approvals) { await new Promise(resolve => setTimeout(resolve, 5)); }
		const [card] = f.state().chat.approvals;
		// Malformed answers (unknown value, oversized id, wrong type) never resolve anything.
		await f.receive({ action: 'approval', id: card.id, answer: 'maybe' });
		await f.receive({ action: 'approval', id: 'x'.repeat(65), answer: 'once' });
		await f.receive({ action: 'approval', id: 7, answer: 'once' });
		const stillPending = f.state().chat.approvals.length;
		await f.receive({ action: 'approval', id: card.id, answer: 'once' });
		await running;
		assert.deepEqual({ card: { title: card.title, detail: card.detail, rule: card.rule }, stillPending, answers: f.approvals, left: f.state().chat.approvals }, {
			card: { title: 'Hacer push', detail: ['branch: feat/x'], rule: 'git_push' }, stillPending: 1, answers: ['once'], left: undefined
		});
	} finally { await f.cleanup(); }
});

test('per-file run actions only accept files the run changed; revert is confirmed and unqueue ignores unknown ids', async () => {
	const f = await panelFixture([], undefined, { folders: 1, confirm: true });
	try {
		await f.receive({ action: 'mode', mode: 'act' });
		await f.receive({ action: 'send', text: 'Cre\u00e1 el CRUD' });
		const run = f.state().chat.messages.at(-1);
		assert.equal(run.run.outcome.diff.files[0].path, 'src/clients.ts');
		const opened = () => f.executed.filter(args => args[0] === 'atsIde.openRunDiff');
		for (const path of ['../outside.txt', '/etc/passwd', 'C:\Windows\win.ini', 'src/other.ts', 'src/clients.ts\0', 42]) { await f.receive({ action: 'openDiff', messageId: run.id, path }); }
		await f.receive({ action: 'openDiff', messageId: 'nope', path: 'src/clients.ts' });
		assert.deepEqual(opened(), []);
		await f.receive({ action: 'openDiff', messageId: run.id, path: 'src/clients.ts' });
		assert.deepEqual(opened(), [['atsIde.openRunDiff', 'file:///clientes', 'src/clients.ts', 'added', false]]);
		await f.receive({ action: 'revertFile', messageId: run.id, path: '../outside.txt' });
		assert.equal(f.state().chat.messages.at(-1).role, 'run');
		await f.receive({ action: 'revertFile', messageId: run.id, path: 'src/clients.ts' });
		const notice = f.state().chat.messages.at(-1);
		assert.deepEqual({ role: notice.role, reverted: /Revertidos: src\/clients\.ts/.test(notice.text), stored: f.state().chat.messages.find(message => message.id === run.id).run.reverted }, { role: 'notice', reverted: true, stored: ['src/clients.ts'] });
		await f.receive({ action: 'unqueue', id: 'unknown' });
		assert.equal(f.state().chat.queue, undefined);
	} finally { await f.cleanup(); }
});

test('/costo adds the provider-reported limit windows with the age of the reading', async () => {
	const quota = { provider: 'claude', asOf: Date.now() - 3 * 60_000, source: 'stream', windows: [{ id: 'session', label: '5h', usedPercent: 72 }, { id: 'weekly', label: '7d', usedPercent: 94.4 }] };
	const f = await panelFixture([{ text: 'con cupo', quota }]);
	try {
		await f.receive({ action: 'send', text: 'hola' });
		await f.receive({ action: 'send', text: '/costo' });
		const text = f.state().chat.messages.at(-1).text;
		assert.match(text, /no inform\u00f3/);
		assert.match(text, /Cupo de Claude Code \(dato de hace 3 min\):\n {2}Sesi\u00f3n: 28% libre\n {2}Semanal: 6% libre/);
		assert.equal(f.state().chat.quota.claude.windows.length, 2);
	} finally { await f.cleanup(); }
});

test('the Codex full access switch asks before turning on, never turns on by itself and turns off without asking', async () => {
	const { codexSandbox, useCodexSandbox } = require('../src/native-codex-sandbox.ts');
	const declined = await panelFixture([]);
	try {
		assert.equal(declined.state().codexFullAccess, false);
		await declined.receive({ action: 'sandbox', full: true });
		await declined.receive({ action: 'sandbox', full: 'yes' });
		assert.deepEqual({ setting: declined.settings.get('codexSandbox'), shown: declined.state().codexFullAccess, mode: codexSandbox() }, { setting: undefined, shown: false, mode: 'workspace-write' });
	} finally { await declined.cleanup(); }
	const accepted = await panelFixture([], undefined, { folders: 1, confirm: true });
	try {
		await accepted.receive({ action: 'sandbox', full: true });
		assert.deepEqual({ setting: accepted.settings.get('codexSandbox'), shown: accepted.state().codexFullAccess, mode: codexSandbox() }, { setting: 'danger-full-access', shown: true, mode: 'danger-full-access' });
		await accepted.receive({ action: 'sandbox', full: false });
		assert.deepEqual({ setting: accepted.settings.get('codexSandbox'), shown: accepted.state().codexFullAccess, mode: codexSandbox() }, { setting: 'workspace-write', shown: false, mode: 'workspace-write' });
	} finally { useCodexSandbox('workspace-write'); await accepted.cleanup(); }
});

test('"Administrar cuentas..." of the selector opens the AI Accounts tab, never the folder-first palette command', async () => {
	const f = await panelFixture([], undefined, { folders: 2, confirm: undefined });
	try {
		await f.receive({ action: 'accounts' });
		assert.deepEqual(f.executed.map(call => call[0]).filter(id => String(id).startsWith('atsHarness.accounts')), ['atsHarness.accounts.open']);
	} finally { await f.cleanup(); }
});
