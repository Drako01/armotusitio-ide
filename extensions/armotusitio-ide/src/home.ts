/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { createWorkspace } = require('./workspace.ts');

/** Register a local operations overview backed by the existing harness controller. */
function registerHome(context, controller, projects) {
	let panel;
	let updateRevision = 0;
	let draft;
	let reveal;
	const t = message => vscode.l10n.t(message);
	const workspace = createWorkspace(context, controller, projects);
	controller.restoreHarnessDraft = (root, text) => panel?.webview.postMessage({ type: 'restoreDraft', root, text });
	controller.openTask = prompt => vscode.commands.executeCommand('atsIde.home', { prompt });
	async function update() {
		const revision = ++updateRevision;
		if (!panel) { return; }
		const all = await projects();
		const providers = await Promise.all(all.map(({ profile }) => controller.getProvider(profile)));
		if (!panel || revision !== updateRevision) { return; }
		void panel.webview.postMessage({
			type: 'state', preferences: controller.getHarnessPreferences?.(), draftPersistence: controller.canPersistHarnessDrafts === true, trusted: vscode.workspace.isTrusted,
			labels: {
				toolReady: t('Resultado disponible'), toolSearch: t('Buscar por tarea o \u00e1rea'), toolShowing: t('Tareas mostradas'), toolOpenTask: t('Ver progreso'), toolRegisteredActive: t('Activa en el registro \u00b7 consult\u00e1 el progreso para comprobar su ejecuci\u00f3n'),
				toolGroups: { tasks: t('Tareas'), quality: t('Calidad y diagn\u00f3stico'), context: t('Contexto y agentes'), performance: t('Rendimiento'), maintenance: t('Mantenimiento') },
				toolRaw: t('Ver salida t\u00e9cnica'),
				workflow: Object.fromEntries(Object.entries({ unknown: 'Estado no disponible', HARNESS_ATTEMPT_CHANGED: 'El intento cambi\u00f3 o no pudo verificarse. Actualiz\u00e1 la tarea y revis\u00e1 la acci\u00f3n antes de continuar.', HARNESS_RECONCILE: 'Hay una creaci\u00f3n sin confirmar. Revis\u00e1 el listado nativo antes de preparar otra tarea.', reconcile: 'Revisar creaci\u00f3n', result: 'Resultado registrado', requirement: 'Requisito pendiente', observedTimeline: 'observaciones del IDE', previousAttempt: 'Intento anterior', noAttribution: 'El Harness no entreg\u00f3 un manifiesto de cambios atribuibles a esta tarea. Revis\u00e1 la evidencia antes de compartir el resultado.', evidence: 'Abrir evidencia', diagnose: 'Diagn\u00f3stico', filters: 'Filtrar actividad', projectFilter: 'Todos los proyectos', stateFilter: 'Todos los estados', hostFilter: 'Todos los proveedores', since: 'Desde la fecha', newLines: 'l\u00edneas nuevas', draftPrivate: 'El borrador usa el almacenamiento seguro del IDE para este workspace.', draftSession: 'El borrador se conserva en esta vista.', gates: 'verificaciones', moreActions: 'M\u00e1s acciones', dependencies: 'Dependencias del plan', noDependencies: 'sin dependencias', slowGate: 'Esta verificaci\u00f3n tarda m\u00e1s de lo habitual', typicalGate: 'Duraci\u00f3n t\u00edpica', gateBasis: 'Mediana nativa de ejecuciones previas de esta tarea para el mismo gate; la duraci\u00f3n puede variar.', estimate: 'Tiempo restante estimado', estimateBasis: 'Estimaci\u00f3n del Harness basada en nodos completados y pesos del plan. Puede variar.', focus: 'Modo foco', saveTemplate: 'Guardar como plantilla', useTemplate: 'Usar plantilla', card: 'Vincular tarjeta', inspectCard: 'Abrir tarjeta', logSearch: 'Buscar en los detalles', follow: 'Seguir el final', noLogs: 'Todav\u00eda no hay salida capturada por este IDE para esta tarea. Consult\u00e1 las verificaciones nativas para ver su evidencia.', compact: 'Vista compacta', attention: 'Necesita atenci\u00f3n', search: 'Buscar por tarea, proyecto o estado', activeCount: 'en ejecuci\u00f3n', attentionCount: 'requieren atenci\u00f3n', pin: 'Fijar tarea', unpin: 'Dejar de fijar', pinned: 'Inspecci\u00f3n fijada \u00b7 la actividad actual sigue visible', configurationChanged: 'Cambi\u00f3 la configuraci\u00f3n o el contrato de ejecuci\u00f3n. Revis\u00e1 los requisitos antes de aprobar de nuevo.', planChanged: 'El plan cambi\u00f3. Revis\u00e1 las diferencias antes de confirmar otra vez.', planComparison: 'Cambios del plan', executionEngine: 'Ejecuci\u00f3n', projectEngine: 'Verificaciones del proyecto', agentEngine: 'IA para esta tarea', projectConfig: 'Configuraci\u00f3n del proyecto', projectGates: 'Esta tarea ejecuta verificaciones del proyecto. No inicia agentes de IA.', verifications: 'Verificaciones por dominio', attempt: 'Intento', attempts: 'Comparar intentos', timeline: 'L\u00ednea de tiempo', export: 'Exportar resumen', reuse: 'Preparar otra tarea', connectionError: 'No se pudo validar el contrato del Harness. Actualiz\u00e1 el estado para volver a intentar.', unknownHint: 'No se pudo comprobar si el ejecutor est\u00e1 activo. Revis\u00e1 el host y el entorno antes de recuperar esta tarea.', pending: 'Pendiente de ejecuci\u00f3n', HARNESS_CREATE_UNKNOWN: 'No se pudo confirmar si la tarea lleg\u00f3 a crearse. Actualiz\u00e1 el listado nativo antes de preparar otra.', HARNESS_PROVIDER: 'Cambi\u00f3 la configuraci\u00f3n de IA del proyecto. Revisala y volv\u00e9 a preparar la tarea.', HARNESS_PREFLIGHT: 'Hay requisitos pendientes. Revis\u00e1 los avisos antes de continuar.', HARNESS_CREATE: 'El Harness no pudo crear la tarea. Consult\u00e1 los detalles para ver el motivo.', HARNESS_PROGRESS: 'No se pudo leer el estado actual del Harness. Actualiz\u00e1 el estado antes de continuar.', HARNESS_TIMEOUT: 'La operaci\u00f3n super\u00f3 su tiempo m\u00e1ximo. Revis\u00e1 el estado y los detalles antes de reintentar.', HARNESS_STOP_PENDING: 'No se pudo confirmar que la ejecuci\u00f3n se detuvo. No inicies otra tarea hasta actualizar su estado.', edit: 'Editar tarea', environmentNotes: 'Revisiones del entorno', technical: 'Detalle t\u00e9cnico', 'orphan-worktrees': 'Hay espacios de trabajo de tareas anteriores que conviene revisar.', 'dead-locks': 'Quedaron registros de tareas interrumpidas. No hay que reiniciarlas para preparar esta tarea.', previousFailures: 'Hay ejecuciones anteriores que necesitan revisi\u00f3n.', 'dirty-tree': 'El proyecto tiene cambios locales anteriores a esta tarea. Revisalos para distinguirlos de los cambios nuevos.', 'context-manager': 'Preparar el contexto', architect: 'Dise\u00f1ar e implementar el cambio', logger: 'Registrar el resultado', backend: 'Implementaci\u00f3n de API', backoffice: 'Interfaz de administraci\u00f3n', infra: 'Infraestructura', documentation: 'Documentaci\u00f3n', tester: 'Pruebas', 'security-auditor': 'Revisi\u00f3n de seguridad', repo: 'Proyecto', docs: 'Documentaci\u00f3n', empty: 'Prepar\u00e1 una tarea para ver ac\u00e1 el plan, el avance y el resultado.', preparing: 'Revisando requisitos', questions: 'Falta tu respuesta', review: 'Plan listo para revisar', creating: 'Creando tarea', running: 'En ejecuci\u00f3n', stopping: 'Deteniendo tarea', completed: 'Completada', failed: 'Fall\u00f3', interrupted: 'Interrumpida \u00b7 sin proceso activo', blocked: 'Necesita atenci\u00f3n', cancelled: 'Cancelada', start: 'Ejecutar con Harness', answer: 'Continuar con estas respuestas', resume: 'Reanudar tarea', retry: 'Reintentar tarea', stop: 'Detener tarea', logs: 'Ver detalles', changes: 'Revisar cambios', stale: 'No se pudo actualizar el progreso. La \u00faltima lectura puede estar desactualizada.', checked: '\u00daltima actualizaci\u00f3n', noProjects: 'Abr\u00ed ArmotuSitio o RedEvent para preparar tareas con su Harness.', preparingHint: 'Revisando la tarea. Pod\u00e9s seguir trabajando mientras el Harness prepara el plan.', direct: 'El Harness considera que esta tarea puede resolverse directamente. Si confirm\u00e1s este plan, se ejecutar\u00e1 con el circuito completo de agentes y verificaciones.', blockedHint: 'Revis\u00e1 las preguntas, los avisos y los detalles antes de volver a preparar la tarea.', reviewHint: 'Revis\u00e1 los pasos. Al confirmar, el Harness puede modificar archivos y ejecutar verificaciones del proyecto.', observed: 'Revisar tarea detectada', passed: 'Completado', skipped: 'Omitido', developer: 'Implementaci\u00f3n', reviewer: 'Revisi\u00f3n de c\u00f3digo', verifier: 'Verificaci\u00f3n', planner: 'Planificaci\u00f3n', security: 'Revisi\u00f3n de seguridad' }).map(([key, value]) => [key, t(value)])),
				trusted: t('Workspace confiable \u00b7 Se solicita confirmaci\u00f3n antes de ejecutar tareas.'),
				restricted: t('Modo restringido \u00b7 Marc\u00e1 el workspace como confiable para ejecutar tareas.'),
				emptyProjects: t('Abr\u00ed ArmotuSitio 2.0 o RedEvent para detectar su harness y sus comandos disponibles.'),
				emptyJobs: t('Todav\u00eda no hay tareas del IDE guardadas en este workspace.'),
				emptyProgress: t('Sin progreso externo disponible. Abr\u00ed un proyecto compatible y marc\u00e1 el workspace como confiable.'),
				progressError: t('No se pudo consultar el progreso. Verific\u00e1 que Node y el harness est\u00e9n disponibles y volv\u00e9 a actualizar.'),
				duration: t('Duraci\u00f3n'),
				repeat: t('Repetir tarea'),
				states: { running: t('En ejecuci\u00f3n'), passed: t('Completada'), failed: t('Fall\u00f3'), cancelled: t('Cancelada'), ended: t('Finaliz\u00f3 sin c\u00f3digo de salida'), unknown: t('Resultado desconocido tras reiniciar el IDE'), completed: t('Completada'), stalled: t('Sin proceso activo'), active: t('Activa'), pending: t('Pendiente'), blocked: t('Bloqueada'), aborted: t('Abortada') }
			},
			projects: all.map(({ profile }, index) => ({ id: profile.id, name: profile.name, root: profile.root, connection: controller.getHarnessConnection?.(profile.root), actions: profile.actions, workflow: profile.workflow === true, tools: (profile.tools || []).filter(tool => profile.id !== 'armotusitio' || controller.getHarnessConnection?.(profile.root)?.value?.operations.includes(tool.id)).map(tool => ({ ...tool, title: t(tool.title), description: t(tool.description) })), provider: providers[index].label, customProvider: profile.id === 'armotusitio' || providers[index].custom === true, providerSupported: providers[index].supported === true && !providers[index].error })),
			workflows: workspace.views(), toolResult: workspace.toolResult(),
			jobs: controller.getHistory().map(job => ({ id: job.id, action: job.action, host: job.host, state: job.state, project: job.project, startedAt: job.startedAt, endedAt: job.endedAt, repeatable: controller.canRepeat(job), repeatBlocked: controller.isBusy(job.project, job.action) || !all.some(({ profile }) => profile.root === job.project && profile.actions.includes(job.action)) })),
			progress: controller.readHarnessProgress?.() || controller.progress
		});
	}
	context.subscriptions.push(vscode.commands.registerCommand('atsIde.home', (options = undefined) => {
		if (typeof options?.task === 'string' && typeof options?.root === 'string') { reveal = { type: 'reveal', id: options.task, project: options.root }; }
		if (typeof options?.prompt === 'string' && options.prompt.length <= 32000) { draft = options.prompt; }
		if (panel) { panel.reveal(); if (reveal) { void panel.webview.postMessage(reveal); reveal = undefined; } if (draft) { void panel.webview.postMessage({ type: 'draft', text: draft }); draft = undefined; } update(); return; }
		const resources = vscode.Uri.joinPath(context.extensionUri, 'resources');
		panel = vscode.window.createWebviewPanel('atsIde.home', t('Inicio \u00b7 ArmotuSitio IDE'), vscode.ViewColumn.One, {
			enableScripts: true, localResourceRoots: [resources, vscode.Uri.joinPath(context.extensionUri, 'dist')]
		});
		const current = panel;
		const nonce = randomBytes(24).toString('base64');
		const uri = name => current.webview.asWebviewUri(vscode.Uri.joinPath(resources, name)).toString();
		current.webview.html = `<!doctype html><html lang="es-AR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${current.webview.cspSource}; style-src ${current.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('home.css')}"><title>ArmotuSitio IDE</title></head>
<body><main>
<header><img src="${uri('logo.png')}" alt="ArmotuSitio" width="56" height="56"><div><p class="eyebrow">ARMOTUSITIO IDE</p><h1>${t('Trabaj\u00e1 con el Harness')}</h1><p class="subtitle">${t('Describ\u00ed la tarea, revis\u00e1 el plan y segu\u00ed su ejecuci\u00f3n.')}</p></div></header>
<section aria-labelledby="activity-title"><div class="section-heading"><h2 id="activity-title">${t('Tus tareas')}</h2><button type="button" class="secondary icon-button" data-action="refresh" title="${t('Actualizar estado')}" aria-label="${t('Actualizar estado')}"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path fill="currentColor" d="M13 2v4H9l1.5-1.5A4.5 4.5 0 1 0 12.4 9h1A5.5 5.5 0 1 1 11.2 3.8L13 2Z"/></svg></button></div><div id="workflow-runs" aria-live="polite"></div></section>
<details id="task-composer"><summary>${t('Nueva tarea')}</summary><section aria-labelledby="task-title"><h2 id="task-title">${t('Nueva tarea')}</h2>
<form id="task-form"><div class="task-selectors"><label for="task-project">${t('Proyecto')}<select id="task-project" required></select></label><label for="task-host"><span id="task-host-title">${t('IA para esta tarea')}</span><select id="task-host"><option value="project">${t('Configuraci\u00f3n del proyecto')}</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label></div>
<label for="task-text">${t('\u00bfQu\u00e9 quer\u00e9s hacer?')}</label><textarea id="task-text" rows="5" maxlength="32000" required placeholder="${t('Describ\u00ed el cambio y c\u00f3mo sabremos que est\u00e1 terminado.')}"></textarea>
<p class="muted" id="task-hint">${t('Primero se revisan los requisitos y las verificaciones del proyecto. La ejecuci\u00f3n empieza cuando confirm\u00e1s el plan.')}</p>
<button id="prepare-task" type="submit">${t('Preparar tarea')}</button><p id="task-feedback" role="status" aria-live="polite"></p></form></section>
</details>
<details class="advanced"><summary>${t('Herramientas del proyecto y actividad anterior')}</summary>
<section aria-labelledby="native-tools-title"><h2 id="native-tools-title">${t('Herramientas del Harness')}</h2><form id="native-tools"><label for="tool-project">${t('Proyecto')}<select id="tool-project"></select></label><label for="tool-choice">${t('\u00bfQu\u00e9 necesit\u00e1s hacer?')}<select id="tool-choice"></select></label><p id="tool-description" class="muted"></p><label id="tool-task-label" for="tool-task" hidden>${t('Identificador de la tarea')}<input id="tool-task" maxlength="100" placeholder="20261024-\u2026"></label><label id="tool-host-label" for="tool-host" hidden>${t('IA que quer\u00e9s probar')}<select id="tool-host"><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label><button id="tool-run" type="submit">${t('Abrir herramienta')}</button></form><div id="tool-result" aria-live="polite"></div></section>
<div class="toolbar"><button data-action="open">${t('Abrir un proyecto')}</button><button class="secondary" data-action="theme">${t('Cambiar tema')}</button><button class="secondary" data-action="refresh">${t('Actualizar')}</button></div>
<p id="trust" class="muted" role="status"></p>
<section aria-labelledby="projects-title"><div class="section-heading"><h2 id="projects-title">${t('Tus proyectos')}</h2><span class="muted">${t('Harness local')}</span></div><div id="projects"></div></section>
<section aria-labelledby="tools-title"><h2 id="tools-title">${t('Herramientas')}</h2><div class="tools">
<button class="tool" data-action="chat"><strong>Chat @harness</strong><span>${t('Consultar el Harness y gestionar proyectos y tareas')}</span></button>
<button class="tool" data-action="mcp"><strong>MCP ArmotuSitio</strong><span>${t('Configurar la clave de Work Management')}</span></button>
<button class="tool" data-action="agent"><strong>Claude / Codex</strong><span>${t('Enviar una tarea a tu CLI instalada')}</span></button>
<button class="tool" data-action="context"><strong>${t('Contexto')}</strong><span>${t('Explorar el inventario del proyecto')}</span></button>
<button class="tool" data-action="worktrees"><strong>Git worktrees</strong><span>${t('Consultar espacios de trabajo aislados')}</span></button>
<button class="tool" data-action="github"><strong>GitHub</strong><span>${t('Consultar PRs y ejecuciones de Actions')}</span></button>
<button class="tool" data-action="n8n"><strong>n8n</strong><span>${t('Abrir tu dashboard configurado')}</span></button>
<button class="tool" data-action="plan"><strong>${t('Planes de agentes')}</strong><span>${t('Validar dependencias y presupuesto de un JSON')}</span></button>
</div></section>
<section aria-labelledby="progress-title"><h2 id="progress-title">${t('Progreso del Harness')}</h2><div id="progress" aria-live="polite"></div></section>
<section aria-labelledby="runs-title"><div class="section-heading"><h2 id="runs-title">${t('Historial de tareas del IDE')}</h2><div class="actions"><button class="secondary" data-action="clear">${t('Borrar historial')}</button><button class="secondary" data-action="cancel">${t('Cancelar una tarea')}</button></div></div><p class="muted">${t('Hasta 20 tareas por proyecto. Se guardan en este workspace, sin logs ni comandos privados.')}</p><div id="runs" role="log" aria-live="polite"></div></section>
</details><footer>${t('Las tareas usan el Harness del proyecto. Revis\u00e1 el plan antes de ejecutar: los agentes pueden modificar archivos y correr verificaciones.')}</footer>
</main><script nonce="${nonce}" src="${current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'home.js'))}"></script></body></html>`;
		const disposables = [];
		disposables.push(current.webview.onDidReceiveMessage(async message => {
			if (!message || typeof message.action !== 'string') { return; }
			if (await workspace.receive(message)) { await update(); return; }
			if (message.action === 'refresh' || message.action === 'ready') { if (message.action === 'refresh') { await controller.refreshActivity(true); } await update(); if (reveal && panel) { void panel.webview.postMessage(reveal); reveal = undefined; } if (draft && panel) { void panel.webview.postMessage({ type: 'draft', text: draft }); draft = undefined; } return; }
			if (message.action === 'open') {
				const folders = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: t('Agregar proyecto') });
				if (folders?.length) { vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, { uri: folders[0] }); }
				return;
			}
			if (message.action === 'execute') {
				const project = (await projects()).find(p => p.profile.root === message.root);
				if (project && project.profile.actions.includes(message.command)) {
					await controller.execute(project.folder.uri.toString(), message.command);
				}
				return;
			}
			if (message.action === 'provider') {
				const project = (await projects()).find(p => p.profile.root === message.root);
				if (project) { await vscode.commands.executeCommand('atsHarness.selectProvider', project.folder.uri.toString()); }
				return;
			}
			if (message.action === 'repeat') { if (typeof message.id === 'string') { await controller.repeat(message.id); } return; }
			const commands = { changes: 'workbench.view.scm', theme: 'workbench.action.selectTheme', chat: 'atsIde.chat', mcp: 'atsIde.mcpConfigure', agent: 'atsIde.agent', context: 'atsIde.context', worktrees: 'atsIde.worktrees', github: 'atsIde.github', n8n: 'atsIde.n8n', plan: 'atsHarness.reviewPlan', cancel: 'atsHarness.cancelTask', clear: 'atsHarness.clearHistory' };
			if (Object.hasOwn(commands, message.action)) { await vscode.commands.executeCommand(commands[message.action]); }
		}));
		disposables.push(current.onDidDispose(() => { panel = undefined; for (const disposable of disposables) { disposable.dispose(); } }));
	}));
	context.subscriptions.push(controller.onDidChangeTreeData(update), vscode.workspace.onDidGrantWorkspaceTrust(update), { dispose: () => panel?.dispose() });
}

module.exports = { registerHome };
