/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomBytes, createHash } = require('node:crypto');
const { ChatStore, harnessErrorCode, MAX_USER_MESSAGE_CHARS } = require('./native-chat.ts');
const { HarnessChatSession, describeFailure, chatActivityItems } = require('./native-chat-session.ts');
import type { ActivityFeed } from './native-activity-feed.ts';
const { diagnoseProvider } = require('./native-provider-diagnostics.ts');
const { listProviderModels } = require('./native-provider-models.ts');
const { validModel, validEffort } = require('./native-providers.ts');
const { endpoint } = require('./mcp.ts');

/** Dispatch explicit slash commands without an LLM, shell interpolation or arbitrary MCP tool names. */
function createHandler(vscode, controller, projects, mcp) {
	const t = (message, ...args) => vscode.l10n.t(message, ...args);
	const help = () => t('Comandos: estado, comandos, check [proyecto], verify [proyecto], test [proyecto], mcp, proyectos, proyecto CLAVE, tareas CLAVE, tarea CLAVE-123, tablero CLAVE, buscar texto, crear CLAVE t\u00edtulo, mover CLAVE-123 columnaId, comentar CLAVE-123 texto. Pod\u00e9s anteponer @harness o usar /comando.');
	return async function handle(input, token) {
		if (token?.isCancellationRequested) { return t('Consulta cancelada.'); }
		const text = input.trim().replace(/^@harness(?:\s+|$)/i, '').replace(/^\//, '');
		const [raw = '', ...words] = text.split(/\s+/);
		const action = raw.toLowerCase();
		if (action === 'ayuda' || !action) { return help(); }
		if (text.length > MAX_USER_MESSAGE_CHARS) { return t('El mensaje es demasiado largo.'); }
		if (!vscode.workspace.isTrusted) { return t('Marc\u00e1 el workspace como confiable para consultar o ejecutar comandos.'); }
		try {
			if (action === 'comandos' && !words.length) {
				const all = await projects();
				const local = await controller.nativeProjects?.() || [];
				return [...all.map(({ profile }) => profile.name + ': ' + (profile.actions.join(', ') || t('Preparar una tarea con el Harness del proyecto'))), ...local.map(project => project.name + ': ' + t('Conversar, planificar y ejecutar con aprobaci\u00f3n desde Chat Harness'))].join('\n') || t('Abr\u00ed una carpeta para detectar su Harness o configurar el incluido en el IDE.');
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
			// Free text is a conversation with the selected AI; only Chat Harness hosts that flow.
			if (!localCommands.includes(action)) { return t('Para conversar con la IA, planificar y ejecutar cambios abr\u00ed Chat Harness (ArmoTuSitio: Chat Harness). Ac\u00e1 solo se aceptan comandos.') + '\n' + help(); }
			if (!mcp.enabled()) { return t('Work Management es opcional y est\u00e1 desactivado en este workspace. Pod\u00e9s conversar y ejecutar tareas sin conectarlo. Para usar tarjetas y tableros, habilit\u00e1 ArmotuSitio MCP desde el indicador del chat.'); }
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

/**
 * Real MCP handshake: `initialize` plus `tools/list` against the existing endpoint. A stored key alone is
 * never reported as connected. The result carries no secret, only state, reason and tool count.
 */
async function probeMcpConnection(vscode, mcp, token = undefined) {
	const checkedAt = new Date().toISOString();
	if (!vscode.workspace.isTrusted) { return { state: 'disconnected', reason: 'untrusted', checkedAt }; }
	if (!mcp.enabled()) { return { state: 'disconnected', reason: 'disabled', checkedAt }; }
	const credential = await mcp.credentialState?.();
	if (credential && !credential.configured) { return { state: 'disconnected', reason: 'missing-key', checkedAt }; }
	try {
		const tools = await mcp.client.tools(token);
		return { state: 'connected', tools: tools.length, checkedAt };
	} catch (error) {
		// Force a full initialize on the next check instead of trusting a cached session.
		mcp.client.reset?.();
		const reason = { MCP_AUTH: 'auth', MCP_HTTP: 'http', MCP_RESPONSE: 'protocol', MCP_SIZE: 'protocol', MCP_CANCELLED: 'cancelled' }[error?.message] || 'network';
		return { state: 'error', reason, checkedAt };
	}
}

/** Local CLI evidence only: installed, version and local login. No prompt is sent to a model. */
async function probeProvider(provider, diagnose = diagnoseProvider) {
	try {
		const result = await diagnose(provider);
		if (!result.installed || !result.version) { return { status: 'unavailable' }; }
		if (result.commandCompatibility === 'unsupported') { return { status: 'incompatible', version: result.version }; }
		return { status: result.localSession === 'authenticated' ? 'ready' : result.localSession === 'unauthenticated' ? 'unauthenticated' : 'unknown', version: result.version };
	} catch { return { status: 'unknown' }; }
}

/** Webview copy. Templates pass their own placeholders so the webview fills them with live values. */
function labels(t) {
	return {
		title: t('Chat Harness'), project: t('Proyecto'), provider: t('IA'), codex: 'Codex', claude: 'Claude Code',
		model: t('Modelo de {0}', '{0}'), modelDefault: t('Predeterminado: {0}', '{0}'), modelCliDefault: t('Predeterminado del CLI'),
		effort: t('Razonamiento de {0}', '{0}'), effortShort: t('Esfuerzo'), effortDefault: t('Esfuerzo: predeterminado'), effortLevels: { low: t('Bajo'), medium: t('Medio'), high: t('Alto'), xhigh: t('Extra alto'), max: t('M\u00e1ximo') },
		effortHint: t('La disponibilidad del nivel depende del modelo y del CLI instalado.'),
		providerStatus: { ready: t('Autenticado'), unauthenticated: t('Sin sesi\u00f3n iniciada'), unavailable: t('No instalado'), incompatible: t('Versi\u00f3n incompatible'), unknown: t('Estado desconocido'), checking: t('Verificando\u2026') },
		mcp: t('ArmotuSitio MCP'), mcpState: { connected: t('Conectado'), disconnected: t('Desconectado'), checking: t('Verificando'), error: t('Error') },
		mcpReason: { untrusted: t('El workspace no es confiable.'), disabled: t('La integraci\u00f3n est\u00e1 desactivada en este workspace.'), 'missing-key': t('No hay una clave configurada.'), auth: t('La clave fue rechazada o no tiene permisos.'), http: t('El servidor respondi\u00f3 con un error.'), protocol: t('La respuesta no cumple el protocolo MCP.'), network: t('No se pudo establecer la conexi\u00f3n.'), cancelled: t('Verificaci\u00f3n cancelada.') },
		mcpTools: t('{0} disponibles para tu clave', '{0}'), toolsTerm: t('Herramientas'), mcpEndpoint: t('Servidor'), mcpChecked: t('\u00daltima verificaci\u00f3n'), mcpOptional: t('Opcional: la conversaci\u00f3n y la ejecuci\u00f3n funcionan sin MCP.'),
		mcpCheck: t('Verificar ahora'), mcpConfigure: t('Configurar clave'), mcpEnable: t('Habilitar en este workspace'), mcpChangeKey: t('Cambiar clave'), mcpSettings: t('Abrir configuraci\u00f3n'),
		emptyTitle: t('\u00bfEn qu\u00e9 trabajamos hoy?'), emptyBody: t('Convers\u00e1 con la IA sobre tu proyecto. Cuando haya un plan concreto, vas a poder revisarlo y aprobarlo ac\u00e1 mismo. Enviar nunca modifica c\u00f3digo.'),
		suggestions: [t('Quiero agregar un CRUD de clientes'), t('Explicame la arquitectura de este proyecto'), t('\u00bfQu\u00e9 pruebas faltan?')],
		placeholder: t('Escrib\u00ed tu mensaje\u2026 (/ para comandos)'), keyboard: t('Enter env\u00eda \u00b7 Shift+Enter nueva l\u00ednea \u00b7 Enviar solo conversa'), send: t('Enviar'), cancel: t('Detener'),
		you: t('Vos'), notice: t('Harness'), thinking: t('{0} est\u00e1 pensando\u2026', '{0}'), executing: t('Ejecutando plan v{0} con {1}', '{0}', '{1}'),
		stage: { preparing: t('Preparando ejecuci\u00f3n segura'), agent: t('Agente implementador trabajando'), verifying: t('Ejecutando verificaciones') },
		observed: t('{0} KB de actividad', '{0}'), elapsed: t('Tiempo'),
		plan: t('Plan v{0}', '{0}'), planSteps: t('Pasos'), planFiles: t('Archivos'), planRisks: t('Riesgos'), planSkills: t('Skills del proyecto'), planVerification: t('Verificaciones autom\u00e1ticas'), planNoVerification: t('Sin verificaciones configuradas. Pod\u00e9s configurarlas con \u00abConfigurar Harness nativo del proyecto\u00bb.'),
		approve: t('Aprobar y ejecutar'), requestChanges: t('Pedir cambios'), requestPrefix: t('Cambios al plan: '), superseded: t('Reemplazado por una versi\u00f3n m\u00e1s nueva'), approveHint: t('Al aprobar, el agente modifica archivos del proyecto con permisos de escritura acotados y luego corren las verificaciones.'),
		run: { passed: t('Ejecuci\u00f3n completada'), failed: t('La ejecuci\u00f3n fall\u00f3'), cancelled: t('Ejecuci\u00f3n cancelada'), timeout: t('Tiempo agotado') },
		outcome: { completed: t('Completada'), partial: t('Parcial'), blocked: t('Bloqueada'), unchanged: t('Sin cambios'), failed: t('Fallida') },
		outcomeHint: {
			'max-turns': t('Us\u00f3 todos sus turnos antes de terminar. Continuar retoma desde donde qued\u00f3, sin volver a aprobar.'),
			timeout: t('Lleg\u00f3 al tope de 30 minutos. Continuar retoma desde donde qued\u00f3, sin volver a aprobar.'),
			cancelled: t('Se detuvo antes de terminar. Pod\u00e9s continuar desde donde qued\u00f3.'),
			verification: t('Las verificaciones fallaron. Pod\u00e9s reintentar o pedir cambios al plan.'),
			provider: t('El proveedor no complet\u00f3 la ejecuci\u00f3n. Pod\u00e9s reintentar o elegir el otro proveedor.'),
			unchanged: t('Termin\u00f3 sin modificar archivos. El plan sigue aprobable: reintent\u00e1 o ped\u00ed cambios.'),
			blocked: t('El agente necesita algo que no puede resolver solo: {0}', '{0}'),
			'web-search-secret': t('Una b\u00fasqueda web inclu\u00eda un secreto y la ejecuci\u00f3n se cort\u00f3. La consulta ya lleg\u00f3 al buscador del proveedor: rot\u00e1 ese secreto.')
		},
		searches: t('B\u00fasquedas web de esta ejecuci\u00f3n ({0})', '{0}'),
		needs: { service: t('un servicio'), credential: t('una credencial'), policy: t('un permiso'), decision: t('una decisi\u00f3n tuya'), toolchain: t('una herramienta'), disk: t('espacio en disco') },
		changedFiles: t('Archivos que cambi\u00f3 esta ejecuci\u00f3n ({0})', '{0}'), changedMore: t('y {0} m\u00e1s', '{0}'), preexisting: t('ya ten\u00eda cambios tuyos'),
		change: { added: t('nuevo'), modified: t('modificado'), deleted: t('borrado') },
		continueRun: t('Continuar'), retry: t('Reintentar'), continuedRun: t('Continuaci\u00f3n'), maxMessageChars: MAX_USER_MESSAGE_CHARS,
		discardRun: t('Descartar cambios de esta ejecuci\u00f3n'), openHome: t('Ver en Inicio'),
		gate: { pending: t('Pendiente'), running: t('En curso'), passed: t('Pas\u00f3'), failed: t('Fall\u00f3'), cancelled: t('Cancelada') },
		verification: t('Verificaciones'), verificationSkipped: t('Sin verificaciones configuradas'), duration: t('Duraci\u00f3n'), copy: t('Copiar'), copied: t('Copiado'),
		copyMessage: t('Copiar respuesta'), partial: t('Respuesta en curso'), copyCode: t('Copiar c\u00f3digo'), activity: t('Actividad en curso'), idle: t('Sin actividad en curso'), cancelling: t('Deteniendo\u2026'),
		menu: t('M\u00e1s opciones'), newChat: t('Nueva conversaci\u00f3n'), openTasks: t('Abrir panel de tareas'), refreshProviders: t('Verificar proveedores'), commands: t('Ver comandos'),
		noProject: t('Abr\u00ed una carpeta para empezar a conversar sobre su c\u00f3digo.'), untrusted: t('Este workspace no es confiable. Marcalo como confiable para conversar y ejecutar.'), hybrid: t('Este proyecto tiene su propio Harness: pod\u00e9s conversar y planificar, pero la ejecuci\u00f3n con escritura requiere habilitar \u00abatsHarness.coordinatedProjectWriters\u00bb y un motor con lease de escritura.'),
		isolation: t('Aislamiento de escritura: {0}.', '{0}'),
		isolationLevel: { 'os-kernel': t('kernel del sistema'), 'provider-sandbox': t('sandbox del proveedor; las lecturas fuera del proyecto no est\u00e1n confinadas'), 'tool-allowlist': t('solo permisos de herramientas del proveedor, sin sandbox del sistema operativo'), none: t('sin aislamiento') },
		log: t('Conversaci\u00f3n')
	};
}

/**
 * Standalone conversational panel plus the native chat participant for explicit commands.
 * `options.diagnose` and `options.listModels` are test seams for local CLI diagnostics and model discovery.
 */
function registerChat(context, controller, projects, mcp, vscode, options: { diagnose?: typeof diagnoseProvider; listModels?: typeof listProviderModels; feed?: ActivityFeed } = {}) {
	const handle = createHandler(vscode, controller, projects, mcp);
	const t = (message, ...args) => vscode.l10n.t(message, ...args);
	const diagnose = options.diagnose || diagnoseProvider;
	const listModels = options.listModels || listProviderModels;
	const sessions = new Map();
	const providers = { codex: { status: 'checking' }, claude: { status: 'checking' } };
	// Discovered from each CLI's own configuration; the choice itself lives in `atsHarness.<provider>Model`.
	const models = { codex: { options: [] }, claude: { options: [] } };
	const modelSetting = provider => provider + 'Model';
	const effortSetting = provider => provider + 'Effort';
	const chosenEfforts = () => Object.fromEntries(['codex', 'claude'].map(provider => [provider, vscode.workspace.getConfiguration('atsHarness').get(effortSetting(provider), '')]));
	const chosenModels = () => Object.fromEntries(Object.entries(models).map(([provider, found]) => [provider, { ...found, selected: vscode.workspace.getConfiguration('atsHarness').get(modelSetting(provider), '') }]));
	let mcpStatus: { state: string; reason?: string; tools?: number; checkedAt?: string } = { state: 'checking' };
	let panel, mcpCheck;
	if (vscode.window?.createStatusBarItem) {
		const shortcut = vscode.window.createStatusBarItem('atsHarness.chat', vscode.StatusBarAlignment.Left, 19);
		context.subscriptions.push(shortcut);
		shortcut.name = t('Chat del Harness'); shortcut.text = '$(comment-discussion) Chat Harness';
		shortcut.tooltip = t('Conversar con la IA, planificar y ejecutar cambios con aprobaci\u00f3n.'); shortcut.command = 'atsIde.chat';
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
	const folders = () => vscode.workspace.workspaceFolders || [];
	/** Short, colon-free key of a folder for feed item ids (`chat:<key>:<suffix>`). */
	const feedKeyOf = (uri: string): string => createHash('sha256').update(uri).digest('hex').slice(0, 16);
	const selectedFolder = () => {
		const saved = context.workspaceState?.get('atsChat.folder');
		return folders().find(folder => folder.uri.toString() === saved) || folders()[0];
	};
	const post = message => { void panel?.webview.postMessage(message); };
	// Progress events are frequent; the history is resent only when it changed or the webview lost it.
	let posted = { key: undefined, revision: -1 };
	const publish = (folder = selectedFolder()) => {
		const key = folder?.uri.toString();
		const session = key && sessions.get(key);
		let chat = session?.loaded ? session.snapshot() : null;
		if (chat && posted.key === key && posted.revision === chat.revision) { chat = { ...chat, messages: undefined }; }
		// The webview drops its history whenever it receives no chat, so the next one must be complete.
		else { posted = chat ? { key, revision: chat.revision } : { key: undefined, revision: -1 }; }
		post({
			type: 'state', trusted: !!vscode.workspace.isTrusted, providers, models: chosenModels(), efforts: chosenEfforts(), mcp: { ...mcpStatus, endpoint: new URL(endpoint).host, enabled: !!mcp.enabled?.() },
			project: folder ? { name: folder.name, id: key } : null,
			projects: folders().map(item => ({ name: item.name, id: item.uri.toString() })),
			chat
		});
	};
	/** A load that finishes after the user switched projects must not replace the visible one. */
	const publishIfSelected = folder => { if (selectedFolder()?.uri.toString() === folder.uri.toString()) { publish(folder); } };
	/** One session per folder survives panel close, so a running execution keeps reporting when reopened. */
	const sessionFor = folder => {
		const key = folder.uri.toString();
		let entry = sessions.get(key);
		if (!entry) {
			entry = { loaded: false, session: undefined, snapshot: () => entry.session.snapshot() };
			entry.ready = (async () => {
				const root = await fs.realpath(folder.uri.fsPath);
				const directory = path.join(context.globalStorageUri.fsPath, 'native-harness', createHash('sha256').update(root).digest('hex'), 'chat');
				const runtime = controller.nativeChatRuntime?.(folder);
				if (!runtime) { throw Error('HARNESS_CHAT_UNAVAILABLE'); }
				const preferred = providers.claude.status === 'ready' || providers.codex.status !== 'ready' ? 'claude' : 'codex';
				const feedKey = feedKeyOf(key);
				entry.session = new HarnessChatSession(new ChatStore(directory), runtime, snapshot => {
					if (selectedFolder()?.uri.toString() === key) { publish(folder); }
					if (options.feed) {
						const items = chatActivityItems(snapshot, { key: feedKey, name: folder.name }, t);
						const ids = new Set(items.map(item => item.id));
						options.feed.retain(item => !item.id.startsWith('chat:' + feedKey + ':') || ids.has(item.id));
						for (const item of items) { options.feed.publish(item); }
					}
				}, t, preferred);
				await entry.session.open();
				entry.loaded = true;
				return entry;
			})();
			sessions.set(key, entry);
			// A failed load is retried on the next interaction instead of caching the failure.
			entry.ready.catch(() => { if (sessions.get(key) === entry) { sessions.delete(key); } });
		}
		return entry.ready;
	};
	const refreshProviders = async () => {
		providers.codex = { status: 'checking' }; providers.claude = { status: 'checking' }; publish();
		// Model discovery is display-only: an unreadable CLI configuration leaves just the CLI default.
		const discover = provider => listModels(provider).catch(() => ({ options: [] }));
		const [codex, claude, codexModels, claudeModels] = await Promise.all([probeProvider('codex', diagnose), probeProvider('claude', diagnose), discover('codex'), discover('claude')]);
		providers.codex = codex; providers.claude = claude; models.codex = codexModels; models.claude = claudeModels; publish();
	};
	const refreshMcp = async () => {
		mcpCheck?.cancel();
		const source = new vscode.CancellationTokenSource(); mcpCheck = source;
		mcpStatus = { state: 'checking' }; publish();
		try {
			const result = await probeMcpConnection(vscode, mcp, source.token);
			if (mcpCheck === source) { mcpStatus = result; publish(); }
		} finally { if (mcpCheck === source) { mcpCheck = undefined; } source.dispose(); }
	};
	const report = (folder, error) => {
		const entry = folder && sessions.get(folder.uri.toString());
		if (entry?.loaded) { void entry.session.note(describeFailure(t, error), 'error').catch(() => undefined); }
		else { void vscode.window.showErrorMessage(t('Chat Harness: {0}', harnessErrorCode(error))); }
	};
	const receive = async message => {
		const folder = selectedFolder();
		const action = message?.action;
		if (action === 'ready') {
			posted = { key: undefined, revision: -1 };
			post({ type: 'init', labels: labels(t) });
			publish();
			if (folder && vscode.workspace.isTrusted) { await sessionFor(folder).then(() => publishIfSelected(folder), error => report(folder, error)); }
			return;
		}
		if (action === 'project' && typeof message.id === 'string') {
			const target = folders().find(item => item.uri.toString() === message.id);
			if (!target) { return; }
			await context.workspaceState?.update('atsChat.folder', target.uri.toString());
			publish(target);
			if (vscode.workspace.isTrusted) { await sessionFor(target).then(() => publishIfSelected(target), error => report(target, error)); }
			return;
		}
		if (action === 'mcpCheck') { await refreshMcp(); return; }
		if (action === 'providerCheck') { await refreshProviders(); return; }
		if (['mcpConfigure', 'mcpChangeKey', 'mcpEnable'].includes(action)) {
			await vscode.commands.executeCommand({ mcpConfigure: 'atsIde.mcpConfigure', mcpChangeKey: 'atsIde.mcpChangeKey', mcpEnable: 'atsIde.mcpEnable' }[action]);
			await refreshMcp(); return;
		}
		if (action === 'mcpSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'atsHarness.mcp'); return; }
		if (action === 'openTasks') { await vscode.commands.executeCommand('atsIde.home'); return; }
		if (!folder) { return; }
		if (!vscode.workspace.isTrusted) { publish(folder); return; }
		const entry = await sessionFor(folder).catch(error => { report(folder, error); return undefined; });
		if (!entry) { return; }
		const { session } = entry;
		try {
			if (action === 'send' && typeof message.text === 'string') {
				const text = message.text.trim();
				if (!text) { return; }
				if (text.length > MAX_USER_MESSAGE_CHARS) {
					await session.note(t('El mensaje tiene {0} caracteres y el m\u00e1ximo es {1}: sobran {2}. Guard\u00e1 el detalle en un archivo del proyecto y mencion\u00e1 su ruta.', String(text.length), String(MAX_USER_MESSAGE_CHARS), String(text.length - MAX_USER_MESSAGE_CHARS)), 'error');
					return;
				}
				if (text.startsWith('/')) {
					const source = new vscode.CancellationTokenSource();
					// A four-backtick fence keeps triple backticks inside command output inert.
					try { await session.note('`' + text.slice(0, 200).replace(/`/g, '') + '`\n\n````text\n' + await handle(text, source.token) + '\n````'); }
					finally { source.dispose(); }
					return;
				}
				const selected = session.snapshot().provider;
				if (providers[selected].status === 'unavailable') {
					// Fail before spending a turn: the message stays visible so the user can resend it.
					await session.note(t('{0} no est\u00e1 instalado en este equipo. Eleg\u00ed el otro proveedor y reenvi\u00e1 tu mensaje: {1}', selected === 'claude' ? 'Claude Code' : 'Codex', '\u00ab' + text.slice(0, 500) + '\u00bb'), 'error');
					return;
				}
				await session.send(text);
			}
			if (action === 'approve' && typeof message.digest === 'string' && /^[a-f0-9]{64}$/.test(message.digest)) { await session.approve(message.digest); }
			if (action === 'continue' && typeof message.messageId === 'string' && message.messageId.length <= 64) { await session.continueRun(message.messageId); }
			if (action === 'discard' && typeof message.messageId === 'string' && message.messageId.length <= 64) {
				const confirm = t('Descartar cambios');
				if (await vscode.window.showWarningMessage(t('\u00bfDescartar los archivos que cambi\u00f3 esta ejecuci\u00f3n? Los que ten\u00edan cambios tuyos no se tocan.'), { modal: true }, confirm) === confirm) { await session.discardRun(message.messageId); }
			}
			if (action === 'openHome') { await vscode.commands.executeCommand('atsIde.home'); }
			if (action === 'cancel') { session.cancel(); }
			if (action === 'provider' && ['codex', 'claude'].includes(message.provider)) { await session.selectProvider(message.provider); }
			if (action === 'model' && ['codex', 'claude'].includes(message.provider) && (message.model === '' || validModel(message.model))) {
				// `true` targets user settings: the model is a personal choice, not a project policy.
				await vscode.workspace.getConfiguration('atsHarness').update(modelSetting(message.provider), message.model, true);
				publish(folder);
			}
			if (action === 'effort' && ['codex', 'claude'].includes(message.provider) && (message.effort === '' || validEffort(message.provider, message.effort))) {
				await vscode.workspace.getConfiguration('atsHarness').update(effortSetting(message.provider), message.effort, true);
				publish(folder);
			}
			if (action === 'reset' && !session.busy) {
				const confirm = t('Empezar de nuevo');
				if (await vscode.window.showWarningMessage(t('\u00bfEmpezar una conversaci\u00f3n nueva? El historial actual de este proyecto se borra.'), { modal: true }, confirm) === confirm) { await session.reset(); }
			}
		} catch (error) { report(folder, error); }
	};
	context.subscriptions.push(vscode.commands.registerCommand('atsIde.chat', () => {
		if (panel) { panel.reveal(); return; }
		const resources = vscode.Uri.joinPath(context.extensionUri, 'resources');
		panel = vscode.window.createWebviewPanel('atsIde.chat', t('Chat Harness'), vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [resources, vscode.Uri.joinPath(context.extensionUri, 'dist')] });
		const current = panel;
		const nonce = randomBytes(24).toString('base64');
		const uri = name => current.webview.asWebviewUri(vscode.Uri.joinPath(resources, name)).toString();
		current.webview.html = `<!doctype html><html lang="es-AR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${current.webview.cspSource}; style-src ${current.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri('chat.css')}"><title>Chat Harness</title></head><body><div id="app" class="chat-app" data-logo="${uri('logo.png')}"></div><script nonce="${nonce}" src="${current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'chat.js'))}"></script></body></html>`;
		const subscriptions = [current.webview.onDidReceiveMessage(message => receive(message).catch(error => report(selectedFolder(), error)))];
		// A status older than five minutes is re-verified when the panel becomes visible again.
		subscriptions.push(current.onDidChangeViewState?.(event => {
			const age = mcpStatus.checkedAt ? Date.now() - Date.parse(mcpStatus.checkedAt) : Infinity;
			if (event.webviewPanel.visible && mcpStatus.state !== 'checking' && age > 5 * 60 * 1000) { void refreshMcp(); }
		}) ?? { dispose() { } });
		subscriptions.push(current.onDidDispose(() => { mcpCheck?.cancel(); panel = undefined; subscriptions.forEach(item => item.dispose()); }));
		void refreshProviders();
		void refreshMcp();
	}));
	if (vscode.workspace.onDidChangeConfiguration) {
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (panel && ['codex', 'claude'].some(provider => event.affectsConfiguration('atsHarness.' + modelSetting(provider)) || event.affectsConfiguration('atsHarness.' + effortSetting(provider)))) { publish(); }
			// Writer settings apply immediately: the plan card re-reads the project facts instead of asking for a reload.
			if (['atsHarness.coordinatedProjectWriters', 'atsHarness.writerIsolation', 'atsHarness.promptBudgetKiB'].some(setting => event.affectsConfiguration(setting))) {
				for (const entry of sessions.values()) { if (entry.loaded) { void entry.session.refreshContext(); } }
			}
		}));
	}
	if (mcp.onDidChange) { context.subscriptions.push(mcp.onDidChange(() => { if (panel) { void refreshMcp(); } })); }
	if (vscode.workspace.onDidGrantWorkspaceTrust) { context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { publish(); void receive({ action: 'ready' }); })); }
	context.subscriptions.push({ dispose() { for (const entry of sessions.values()) { entry.session?.cancel(); } mcpCheck?.cancel(); panel?.dispose(); } });
	/** Select a project in the chat and show it; Inicio uses this so both views share one conversation. */
	const focus = async folder => {
		await context.workspaceState?.update('atsChat.folder', folder.uri.toString());
		await vscode.commands.executeCommand('atsIde.chat');
		publish(folder);
	};
	/** Inicio's request field: the same circuit, limit and validation as typing in the chat. */
	const ask = async (folderUri: string, text: string) => {
		const folder = folders().find(item => item.uri.toString() === folderUri);
		if (!folder || typeof text !== 'string' || !text.trim()) { return; }
		await focus(folder);
		void receive({ action: 'send', text }).catch(error => report(folder, error));
	};
	/**
	 * Run a feed action on a chat item through the same session methods the chat buttons use. Idempotent: each action
	 * re-checks the session state first, so pressing it in Inicio and in the chat never runs twice.
	 */
	const act = async (itemId: string, action: string): Promise<boolean> => {
		const match = /^chat:(?<key>[0-9a-f]{16}):(?<suffix>[\w-]{1,64})$/.exec(itemId);
		const folder = match && folders().find(item => feedKeyOf(item.uri.toString()) === match.groups!.key);
		if (!folder) { return false; }
		if (action === 'open') { await focus(folder); return true; }
		const entry = await sessionFor(folder).catch(error => { report(folder, error); return undefined; });
		if (!entry) { return true; }
		const { session } = entry;
		const state = session.snapshot();
		const run = (work: Promise<void>) => { void work.catch(error => report(folder, error)); };
		if (action === 'stop') { session.cancel(); }
		if (action === 'approve' && state.plan?.approvable && !state.run) { run(session.approve(state.plan.digest)); }
		if (action === 'retry' && state.plan && state.run?.retryable) { run(session.approve(state.plan.digest)); }
		if (action === 'continue' && state.run?.continuable && state.run.messageId === match.groups!.suffix) { run(session.continueRun(state.run.messageId)); }
		return true;
	};
	return { receive, ask, act };
}

module.exports = { createHandler, registerChat, probeMcpConnection, probeProvider, labels };
