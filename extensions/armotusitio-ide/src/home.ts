/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');

/** Register a local operations overview backed by the existing harness controller. */
function registerHome(context, controller, projects) {
	let panel;
	const t = message => vscode.l10n.t(message);
	async function update() {
		if (!panel) { return; }
		const all = await projects();
		if (!panel) { return; }
		void panel.webview.postMessage({
			type: 'state', trusted: vscode.workspace.isTrusted,
			labels: {
				trusted: t('Workspace confiable \u00b7 Se solicita confirmaci\u00f3n antes de ejecutar tareas.'),
				restricted: t('Modo restringido \u00b7 Marc\u00e1 el workspace como confiable para ejecutar tareas.'),
				emptyProjects: t('Abr\u00ed ArmotuSitio 2.0 o RedEvent para detectar su harness y sus comandos disponibles.'),
				emptyJobs: t('Todav\u00eda no hay tareas del IDE guardadas en este workspace.'),
				emptyProgress: t('Sin progreso externo disponible. Se consulta cada 15 segundos en RedEvent, con un workspace confiable.'),
				progressError: t('No se pudo consultar el progreso. Verific\u00e1 que Node y el harness est\u00e9n disponibles y volv\u00e9 a actualizar.'),
				duration: t('Duraci\u00f3n'),
				repeat: t('Repetir tarea'),
				states: { running: t('En ejecuci\u00f3n'), passed: t('Completada'), failed: t('Fall\u00f3'), cancelled: t('Cancelada'), ended: t('Finaliz\u00f3 sin c\u00f3digo de salida'), unknown: t('Resultado desconocido tras reiniciar el IDE'), completed: t('Completada'), stalled: t('Sin proceso activo'), active: t('Activa'), pending: t('Pendiente'), blocked: t('Bloqueada'), aborted: t('Abortada') }
			},
			projects: all.map(({ profile }) => ({ name: profile.name, root: profile.root, actions: profile.actions })),
			jobs: controller.getHistory().map(job => ({ id: job.id, action: job.action, state: job.state, project: job.project, startedAt: job.startedAt, endedAt: job.endedAt, repeatable: controller.canRepeat(job), repeatBlocked: controller.isBusy(job.project, job.action) || !all.some(({ profile }) => profile.root === job.project && profile.actions.includes(job.action)) })),
			progress: controller.progress
		});
	}
	context.subscriptions.push(vscode.commands.registerCommand('atsIde.home', () => {
		if (panel) { panel.reveal(); update(); return; }
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
<header><img src="${uri('logo.png')}" alt="ArmotuSitio" width="88" height="88"><div><p class="eyebrow">ARMOTUSITIO IDE</p><h1>${t('Tu espacio de trabajo.')}</h1><p class="subtitle">${t('Proyectos, agentes y verificaciones, desde un mismo lugar.')}</p></div></header>
<div class="toolbar"><button data-action="open">${t('Abrir un proyecto')}</button><button class="secondary" data-action="theme">${t('Cambiar tema')}</button><button class="secondary" data-action="refresh">${t('Actualizar')}</button></div>
<p id="trust" class="muted" role="status"></p>
<section aria-labelledby="projects-title"><div class="section-heading"><h2 id="projects-title">${t('Tus proyectos')}</h2><span class="muted">${t('Harness local')}</span></div><div id="projects"></div></section>
<section aria-labelledby="tools-title"><h2 id="tools-title">${t('Herramientas')}</h2><div class="tools">
<button class="tool" data-action="agent"><strong>Claude / Codex</strong><span>${t('Enviar una tarea a tu CLI instalada')}</span></button>
<button class="tool" data-action="context"><strong>${t('Contexto')}</strong><span>${t('Explorar el inventario del proyecto')}</span></button>
<button class="tool" data-action="worktrees"><strong>Git worktrees</strong><span>${t('Consultar espacios de trabajo aislados')}</span></button>
<button class="tool" data-action="github"><strong>GitHub</strong><span>${t('Consultar PRs y ejecuciones de Actions')}</span></button>
<button class="tool" data-action="n8n"><strong>n8n</strong><span>${t('Abrir tu dashboard configurado')}</span></button>
<button class="tool" data-action="plan"><strong>${t('Planes de agentes')}</strong><span>${t('Validar dependencias y presupuesto de un JSON')}</span></button>
</div></section>
<section aria-labelledby="progress-title"><h2 id="progress-title">${t('Progreso del Harness')}</h2><div id="progress" aria-live="polite"></div></section>
<section aria-labelledby="runs-title"><div class="section-heading"><h2 id="runs-title">${t('Historial de tareas del IDE')}</h2><div class="actions"><button class="secondary" data-action="clear">${t('Borrar historial')}</button><button class="secondary" data-action="cancel">${t('Cancelar una tarea')}</button></div></div><p class="muted">${t('Hasta 20 tareas por proyecto. Se guardan en este workspace, sin logs ni comandos privados.')}</p><div id="runs" role="log" aria-live="polite"></div></section>
<footer>${t('Las tareas se ejecutan en el harness de cada repositorio. Los logs se muestran en la terminal. No se env\u00edan cambios a GitHub desde esta pantalla.')}</footer>
</main><script nonce="${nonce}" src="${current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'home.js'))}"></script></body></html>`;
		const disposables = [];
		disposables.push(current.webview.onDidReceiveMessage(async message => {
			if (!message || typeof message.action !== 'string') { return; }
			if (message.action === 'refresh' || message.action === 'ready') { if (message.action === 'refresh') { await controller.refreshActivity(); } await update(); return; }
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
			if (message.action === 'repeat') { if (typeof message.id === 'string') { await controller.repeat(message.id); } return; }
			const commands = { theme: 'workbench.action.selectTheme', agent: 'atsIde.agent', context: 'atsIde.context', worktrees: 'atsIde.worktrees', github: 'atsIde.github', n8n: 'atsIde.n8n', plan: 'atsHarness.reviewPlan', cancel: 'atsHarness.cancelTask', clear: 'atsHarness.clearHistory' };
			if (Object.hasOwn(commands, message.action)) { await vscode.commands.executeCommand(commands[message.action]); }
		}));
		disposables.push(current.onDidDispose(() => { panel = undefined; for (const disposable of disposables) { disposable.dispose(); } }));
	}));
	context.subscriptions.push(controller.onDidChangeTreeData(update), vscode.workspace.onDidGrantWorkspaceTrust(update), { dispose: () => panel?.dispose() });
}

module.exports = { registerHome };
