/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const { randomBytes } = require('node:crypto');

/** Dispatch explicit commands without an LLM, shell interpolation or arbitrary MCP tool names. */
function createHandler(vscode, controller, projects, mcp) {
	const t = (message, ...args) => vscode.l10n.t(message, ...args);
	const help = () => t('Comandos: estado, comandos, check [proyecto], verify [proyecto], test [proyecto], mcp, proyectos, proyecto CLAVE, tareas CLAVE, tarea CLAVE-123, tablero CLAVE, buscar texto, crear CLAVE t\u00edtulo, mover CLAVE-123 columnaId, comentar CLAVE-123 texto. Pod\u00e9s anteponer @harness o usar /comando.');
	return async function handle(input, token) {
		if (token?.isCancellationRequested) { return t('Consulta cancelada.'); }
		const text = input.trim().replace(/^@harness(?:\s+|$)/i, '').replace(/^\//, '');
		const [raw = '', ...words] = text.split(/\s+/);
		const action = raw.toLowerCase();
		if (action === 'ayuda' || !action) { return help(); }
		if (text.length > 10000) { return t('El mensaje es demasiado largo.'); }
		if (!vscode.workspace.isTrusted) { return t('Marc\u00e1 el workspace como confiable para consultar o ejecutar comandos.'); }
		try {
			if (action === 'comandos' && !words.length) {
				const all = await projects();
				const local = await controller.nativeProjects?.() || [];
				return [...all.map(({ profile }) => profile.name + ': ' + (profile.actions.join(', ') || t('Preparar una tarea con el Harness del proyecto'))), ...local.map(project => project.name + ': ' + t('Configurar, preparar y revisar verificaciones locales desde el panel del Harness'))].join('\n') || t('Abr\u00ed una carpeta para detectar su Harness o configurar el incluido en el IDE.');
			}
			if (action === 'estado' && !words.length) {
				await controller.refreshActivity();
				if (token?.isCancellationRequested) { return t('Consulta cancelada.'); }
				const labels = { running: t('En ejecuci\u00f3n'), passed: t('Completada'), failed: t('Fall\u00f3'), cancelled: t('Cancelada'), ended: t('Sin c\u00f3digo de salida'), unknown: t('Resultado desconocido'), stalled: t('Sin proceso activo'), completed: t('Completada') };
				const native = (controller.readHarnessProgress?.() || controller.progress).map(row => row.error ? t('No se pudo consultar el progreso del Harness.') : `${row.title || row.id} [${row.id}] (${row.project || ''}): ${labels[row.outcome || row.state] || row.outcome || row.state}${row.percent === undefined ? '' : ' (' + row.percent + '%)'}`);
				const jobs = controller.getHistory().slice(-20).reverse().map(job => `${job.action}: ${labels[job.state] || job.state} (${job.project})`);
				const local = await controller.nativeProjects?.() || [];
				const tasks = local.flatMap(project => project.tasks.map(task => `${project.name}: ${task.title} \u2014 ${task.reconciliationRequired ? t('Requiere reconciliaci\u00f3n') : labels[task.status] || task.status}`));
				return [...native, ...jobs, ...tasks].join('\n') || t('No hay ejecuciones registradas en este workspace.');
			}
			if (['check', 'verify', 'test'].includes(action) && words.length <= 1) {
				const all = await projects();
				const project = words.length ? all.find(({ profile }) => profile.id === words[0].toLowerCase()) : all.length === 1 ? all[0] : undefined;
				if (!project || !project.profile.actions.includes(action)) { return t('Indic\u00e1 un proyecto disponible: armotusitio o redevent. Consult\u00e1 sus comandos con @harness comandos.'); }
				const id = await controller.execute(project.folder.uri.toString(), action, token);
				return id ? t('Tarea iniciada. Pod\u00e9s seguir el resultado en la barra de estado y en el historial.') : t('No se inici\u00f3 una tarea nueva. Revis\u00e1 la confirmaci\u00f3n o si ya est\u00e1 activa.');
			}
			const localCommands = ['check', 'verify', 'test', 'mcp', 'proyectos', 'proyecto', 'tareas', 'tarea', 'tablero', 'buscar', 'crear', 'mover', 'comentar', 'estado', 'comandos'];
			if (controller.openTask && !localCommands.includes(action)) {
				await controller.openTask(text);
				return t('Abr\u00ed tu tarea en el panel del Harness. Revis\u00e1 el texto y eleg\u00ed \u00abPreparar tarea\u00bb para ver el plan antes de ejecutarlo.');
			}
			if (!mcp.enabled()) { return t('Work Management es opcional y est\u00e1 desactivado en este workspace. Pod\u00e9s preparar tareas y consultar su estado sin conectarlo. Para usar tarjetas y tableros, habilit\u00e1 ArmotuSitio Work Management en las opciones de este chat.'); }
			if (action === 'mcp' && !words.length) {
				const tools = await mcp.client.tools(token);
				return t('Conectado a ArmotuSitio Work Management. Herramientas disponibles para tu clave: {0}.', tools.map(tool => tool.name).join(', '));
			}
			const projectKey = /^[a-z0-9_-]{1,40}$/i;
			const issueKey = /^[a-z][a-z0-9-]*-\d+$/i;
			let name, args, mutation = false;
			if (action === 'proyectos' && !words.length) { name = 'list_projects'; args = {}; }
			if (['proyecto', 'tareas', 'tablero'].includes(action) && words.length === 1 && projectKey.test(words[0])) {
				name = { proyecto: 'get_project_context', tareas: 'list_issues', tablero: 'get_project_board' }[action]; args = { project: words[0] };
			}
			if (action === 'tarea' && words.length === 1 && issueKey.test(words[0])) { name = 'get_issue_context'; args = { issue_key: words[0].toUpperCase() }; }
			if (action === 'buscar' && words.join(' ').length >= 2) { name = 'search_issues'; args = { query: words.join(' '), limit: 20 }; }
			if (action === 'crear' && words.length >= 2 && projectKey.test(words[0])) { name = 'create_issue'; args = { project: words[0], title: words.slice(1).join(' ') }; mutation = true; }
			if (action === 'mover' && words.length === 2 && issueKey.test(words[0]) && /^\d+$/.test(words[1]) && Number.isSafeInteger(Number(words[1])) && Number(words[1]) > 0) { name = 'transition_issue'; args = { issue_key: words[0].toUpperCase(), board_column_id: Number(words[1]) }; mutation = true; }
			if (action === 'comentar' && words.length >= 2 && issueKey.test(words[0])) { name = 'add_issue_comment'; args = { issue_key: words[0].toUpperCase(), content: words.slice(1).join(' ') }; mutation = true; }
			if (!name) {
				return help();
			}
			if (mutation) {
				if (!(await mcp.client.tools(token)).some(tool => tool.name === name)) { return t('Tu clave MCP no tiene habilitada esa acci\u00f3n. Revis\u00e1 sus permisos en ArmotuSitio.'); }
				await mcp.client.call(args.issue_key ? 'get_issue_context' : 'get_project_context', args.issue_key ? { issue_key: args.issue_key } : { project: args.project }, token);
				if (token?.isCancellationRequested) { return t('Consulta cancelada.'); }
				const confirm = t('Confirmar cambio');
				const summary = action === 'crear' ? t('Crear una tarea en {0}:\n{1}', args.project, args.title)
					: action === 'mover' ? t('Mover {0} a la columna {1}.', args.issue_key, args.board_column_id)
						: t('Comentar en {0}:\n{1}', args.issue_key, args.content);
				if (await vscode.window.showWarningMessage(t('\u00bfConfirm\u00e1s este cambio en Work Management?\n{0}', summary), { modal: true }, confirm) !== confirm) { return t('Cambio cancelado.'); }
			}
			if (token?.isCancellationRequested || !mcp.enabled() || !vscode.workspace.isTrusted) { return t('Consulta cancelada.'); }
			const result = await mcp.client.call(name, args, token);
			const content = result.structuredContent ?? result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? result;
			const output = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
			return output.length > 30000 ? output.slice(0, 30000) + '\n' + t('Resultado recortado. Acot\u00e1 la consulta para ver m\u00e1s detalle.') : output;
		} catch (error) {
			if (token?.isCancellationRequested) { return t('Consulta cancelada.'); }
			return error.message === 'MCP_AUTH' ? t('Revis\u00e1 la clave MCP y sus permisos. Us\u00e1 ArmotuSitio: Configurar clave MCP o la variable ATS_MCP_TOKEN.') : t('No se pudo confirmar el resultado. Revis\u00e1 la conexi\u00f3n, los permisos y el estado actual antes de repetir una modificaci\u00f3n.');
		}
	};
}

/** Expose the same command handler in native chat and a standalone panel without an AI dependency. */
function registerChat(context, controller, projects, mcp, vscode) {
	const handle = createHandler(vscode, controller, projects, mcp);
	const updateCredential = async () => { if (panel && mcp.credentialState) { const status = await mcp.credentialState(); await panel?.webview.postMessage({ type: 'credential', ...status }); } };
	const t = message => vscode.l10n.t(message);
	let panel, active;
	if (vscode.window?.createStatusBarItem) {
		const shortcut = vscode.window.createStatusBarItem('atsHarness.chat', vscode.StatusBarAlignment.Left, 19);
		context.subscriptions.push(shortcut);
		shortcut.name = t('Chat del Harness'); shortcut.text = '$(comment-discussion) Chat Harness';
		shortcut.tooltip = t('Abrir el chat del Harness para preparar tareas y consultar su avance.'); shortcut.command = 'atsIde.chat';
		const update = () => vscode.workspace.getConfiguration('atsHarness').get('enabled', true) ? shortcut.show() : shortcut.hide();
		update();
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('atsHarness.enabled')) { update(); } }));
	}
	if (vscode.chat?.createChatParticipant) {
		const participant = vscode.chat.createChatParticipant('atsIde.harness', async (request, _context, stream, token) => {
			const output = await handle((request.command ? request.command + ' ' : '') + request.prompt, token);
			const markdown = new vscode.MarkdownString(); markdown.appendText(output); stream.markdown(markdown);
		});
		participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'logo.png');
		context.subscriptions.push(participant);
	}
	context.subscriptions.push(vscode.commands.registerCommand('atsIde.chat', () => {
		if (panel) { panel.reveal(); return; }
		const resources = vscode.Uri.joinPath(context.extensionUri, 'resources');
		panel = vscode.window.createWebviewPanel('atsIde.chat', t('Chat Harness'), vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [resources, vscode.Uri.joinPath(context.extensionUri, 'dist')] });
		const current = panel;
		const nonce = randomBytes(24).toString('base64');
		const uri = name => current.webview.asWebviewUri(vscode.Uri.joinPath(resources, name)).toString();
		current.webview.html = `<!doctype html><html lang="es-AR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${current.webview.cspSource}; style-src ${current.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri('home.css')}"><link rel="stylesheet" href="${uri('chat.css')}"><title>Chat Harness</title></head><body><main class="chat-workspace"><header class="workspace-header"><img src="${uri('logo.png')}" width="32" height="32" alt=""><div><h1>${t('Chat Harness')}</h1><p class="subtitle">${t('Prepar\u00e1 tareas y consult\u00e1 su avance desde el IDE.')}</p></div></header>
<p id="chat-help" class="muted">${t('Describ\u00ed una tarea para revisar su plan. La ejecuci\u00f3n usa las capacidades del Harness elegido y requiere tu aprobaci\u00f3n.')}</p>
<div class="actions chat-shortcuts" aria-label="${t('Accesos r\u00e1pidos')}"><button class="secondary" type="button" data-prompt="estado">${t('Ver estado')}</button><button class="secondary" type="button" data-prompt="comandos">${t('Qu\u00e9 puedo hacer')}</button><button class="secondary" type="button" id="home">${t('Abrir panel de tareas')}</button></div>
<div id="messages" role="log" aria-live="polite" aria-label="${t('Conversaci\u00f3n del Harness')}"></div>
<p id="chat-status" class="muted" role="status" aria-live="polite" data-pending="${t('Consultando\u2026')}"></p>
<form id="chat"><label for="prompt">${t('\u00bfQu\u00e9 necesit\u00e1s hacer?')}</label><textarea id="prompt" maxlength="10000" rows="3" required aria-describedby="chat-help chat-keyboard" placeholder="${t('Ejemplo: corregir la validaci\u00f3n del formulario de contacto')}"></textarea><p id="chat-keyboard" class="muted">${t('Enter para enviar \u00b7 Shift+Enter para una nueva l\u00ednea')}</p><div class="actions"><button id="send" type="submit">${t('Enviar')}</button><button id="cancel" class="secondary" type="button" disabled>${t('Cancelar consulta')}</button></div></form>
<details class="advanced"><summary>${t('ArmotuSitio Work Management \u00b7 opcional')}</summary><p class="muted">${t('Conectalo si este proyecto usa tarjetas o tableros de ArmotuSitio. Las tareas locales funcionan sin esta integraci\u00f3n.')}</p><p id="credential-status" class="muted" role="status" data-configured="${t('Clave configurada')}" data-missing="${t('No hay una clave configurada')}" data-disabled="${t('Integraci\u00f3n desactivada en este workspace')}"></p><div class="actions"><button id="configure" class="secondary" type="button" disabled>${t('Configurar clave')}</button><button id="enable-mcp" class="secondary" type="button" hidden>${t('Habilitar en este workspace')}</button><button id="change-key" class="secondary" type="button" hidden>${t('Cambiar clave')}</button></div><p class="muted">${t('Consultas disponibles: proyectos, tareas CLAVE, tarea CLAVE-123 o tablero CLAVE.')}</p></details>
</main><script nonce="${nonce}" src="${current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'chat.js'))}"></script></body></html>`;
		const subscriptions = [];
		subscriptions.push(current.webview.onDidReceiveMessage(async message => {
			if (message?.action === 'ready') { await updateCredential(); return; }
			if (message?.action === 'cancel') { active?.cancel(); return; }
			if (message?.action === 'home' && !active) { await vscode.commands.executeCommand('atsIde.home'); return; }
			if (['configure', 'changeKey', 'enableMcp'].includes(message?.action) && !active) { await vscode.commands.executeCommand(({ configure: 'atsIde.mcpConfigure', changeKey: 'atsIde.mcpChangeKey', enableMcp: 'atsIde.mcpEnable' })[message.action]); await updateCredential(); return; }
			if (message?.action !== 'send' || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 10000 || active) { return; }
			const source = new vscode.CancellationTokenSource(); active = source;
			try {
				const text = await handle(message.text, source.token);
				if (panel === current) { await current.webview.postMessage({ type: 'response', text }); }
			} finally { if (active === source) { active = undefined; } source.dispose(); }
		}));
		subscriptions.push(current.onDidDispose(() => { active?.cancel(); active = undefined; panel = undefined; subscriptions.forEach(item => item.dispose()); }));
	}));
	if (mcp.onDidChange) { context.subscriptions.push(mcp.onDidChange(() => { void updateCredential(); })); }
	context.subscriptions.push({ dispose() { active?.cancel(); panel?.dispose(); } });
}

module.exports = { createHandler, registerChat };
