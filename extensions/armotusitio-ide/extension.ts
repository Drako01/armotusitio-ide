/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const vscode = require('vscode');
const { detect, command, validatePlan } = require('./src/core.ts');
const integrations = require('./src/integrations.ts');
const { registerHome } = require('./src/home.ts');
const { History, registerActivity } = require('./src/activity.ts');
const { registerMcp } = require('./src/mcp.ts');
const { registerChat } = require('./src/chat.ts');
const { readProvider, selectProvider } = require('./src/provider.ts');
const { sortActivity } = require('./src/adapter.ts');
const { registerNativeHarness } = require('./src/native-integration.ts');
const repeatActions = ['check', 'verify', 'test'];

async function projects() {
	if (!vscode.workspace.getConfiguration('atsHarness').get('enabled', true)) { return []; }
	const all = await Promise.all((vscode.workspace.workspaceFolders || []).map(async folder => ({ folder, profile: await detect(folder.uri.fsPath) })));
	return all.filter(item => item.profile);
}
async function selectProject(uri = undefined) {
	const all = await projects(); if (uri) { return all.find(x => x.folder.uri.toString() === uri); }
	if (all.length === 1) { return all[0]; }
	return (await vscode.window.showQuickPick(all.map(x => ({ label: x.profile.name, description: x.profile.root, project: x })), { placeHolder: 'Select project' }))?.project;
}
class Controller {
	jobs = new Map();
	launching = new Set();
	events = new vscode.EventEmitter();
	onDidChangeTreeData = this.events.event;
	history;
	progress = [];
	clearWorkflowHistory = () => { };
	getWorkflowActivity = () => [];
	getHarnessPreferences = (): { focus?: boolean } => ({});
	harnessBusy = (_root) => false;
	getHarnessConnection = (_root) => undefined;
	refreshActivity = async (_manual = false) => { };
	constructor(context) {
		this.history = new History(context.workspaceState, () => vscode.window.showWarningMessage(vscode.l10n.t('No se pudo guardar el historial del Harness.')));
	}
	getHistory() {
		const rows = new Map<string, { id: string; project: string; action: string; host?: string; state: string; startedAt: number; endedAt?: number }>(this.history.rows.map(row => [row.id, row]));
		for (const job of this.jobs.values()) { if (job.state === 'running') { rows.set(job.id, job); } }
		return [...rows.values()].sort((a, b) => a.startedAt - b.startedAt);
	}
	async clearHistory() {
		const clear = vscode.l10n.t('Borrar historial');
		if (await vscode.window.showWarningMessage(vscode.l10n.t('\u00bfQuer\u00e9s borrar el historial de este workspace? Las tareas activas van a seguir ejecut\u00e1ndose.'), { modal: true }, clear) === clear) { this.history.clear(); this.clearWorkflowHistory(); this.refresh(); }
	}
	refresh() { this.events.fire(); }
	async getProvider(profile) {
		const t = message => vscode.l10n.t(message);
		if (!vscode.workspace.isTrusted) { return { label: t('Workspace restringido'), supported: false }; }
		if (profile.id === 'armotusitio' && profile.workflow) { return { label: t('Verificaciones del proyecto'), supported: false }; }
		const state = await readProvider(profile);
		const label = !state.supported ? t('IA por plan de agentes') : state.error ? t('Configuraci\u00f3n no disponible') : state.custom ? t('Comando personalizado') : state.invalid ? t('HARNESS_HOST no admitido') : state.host === 'codex' ? 'Codex' : state.host === 'claude' ? 'Claude Code' : t('Sin IA configurada');
		return { ...state, label };
	}
	canRepeat(job) { return repeatActions.includes(job.action) && ['passed', 'failed', 'cancelled', 'ended'].includes(job.state); }
	isBusy(project, action) { return this.launching.has(JSON.stringify([project, action])) || [...this.jobs.values()].some(job => job.project === project && job.action === action && job.state === 'running'); }
	async repeat(id) {
		const job = this.getHistory().find(row => row.id === id);
		if (!job || !this.canRepeat(job)) { return; }
		const project = (await projects()).find(item => item.profile.root === job.project && item.profile.actions.includes(job.action));
		if (!project) { vscode.window.showWarningMessage(vscode.l10n.t('Abr\u00ed el proyecto original y verific\u00e1 que ese comando siga disponible.')); return; }
		await this.execute(project.folder.uri.toString(), job.action);
	}
	getTreeItem(item) { return item; }
	async getChildren(element) {
		if (!element) {
			const all = await projects(); return all.length ? await Promise.all(all.map(async project => { const item = new vscode.TreeItem(project.profile.name, vscode.TreeItemCollapsibleState.Expanded); item.project = project; item.contextValue = 'atsHarness.project'; item.iconPath = new vscode.ThemeIcon('repo'); item.description = (await this.getProvider(project.profile)).label; return item; })) : [new vscode.TreeItem('Open RedEvent or ArmoTuSitio 2.0')];
		}
		if (!element.project) { return []; }
		if (element.workflowEntry) {
			return [...(element.workflowEntry.progress?.nodes || []), ...(element.workflowEntry.progress?.finalGates || [])].map(node => { const item = new vscode.TreeItem(`${node.domain ? node.domain + ' / ' : ''}${node.agent || node.id}`); item.id = element.id + '/' + (node.domain || '') + '/' + node.id; item.description = node.status; item.iconPath = new vscode.ThemeIcon(node.status === 'running' ? 'sync~spin' : node.status === 'passed' ? 'pass' : node.status === 'failed' ? 'error' : 'circle-outline'); return item; });
		}
		const { project } = element;
		if (!element.advanced) {
			const open = (label, icon) => { const item = new vscode.TreeItem(vscode.l10n.t(label)); item.iconPath = new vscode.ThemeIcon(icon); item.command = { command: 'atsIde.home', title: vscode.l10n.t(label) }; return item; };
			const advanced = new vscode.TreeItem(vscode.l10n.t('Comandos y actividad anterior'), vscode.TreeItemCollapsibleState.Collapsed);
			advanced.project = project; advanced.advanced = true; advanced.iconPath = new vscode.ThemeIcon('tools');
			const active = sortActivity(this.getWorkflowActivity().filter(entry => entry.project === project.profile.root)).slice(0, 12).map(entry => {
				const item = new vscode.TreeItem(entry.title || entry.nativeId || vscode.l10n.t('Nueva tarea'), entry.progress?.nodes?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
				item.id = 'ats-workflow/' + entry.id; item.project = project; item.workflowEntry = entry;
				item.description = vscode.l10n.t(({ running: 'En ejecuci\u00f3n', questions: 'Falta tu respuesta', review: 'Plan listo para revisar', completed: 'Completada', failed: 'Fall\u00f3', cancelled: 'Cancelada', interrupted: 'Sin proceso activo', stopping: 'Deteniendo', pending: 'Pendiente', unknown: 'Actividad no comprobada', preparing: 'Revisando requisitos', creating: 'Creando tarea', blocked: 'Necesita atenci\u00f3n' })[entry.phase] || 'Necesita atenci\u00f3n');
				item.tooltip = `${entry.nativeId || ''}\n${entry.project}\n${entry.progress?.currentGate?.id || ''}`;
				item.iconPath = new vscode.ThemeIcon(entry.progress?.live ? 'sync~spin' : entry.phase === 'completed' ? 'pass' : ['blocked', 'failed'].includes(entry.phase) ? 'warning' : 'circle-outline');
				item.command = { command: 'atsIde.home', title: item.label, arguments: [{ task: entry.nativeId || entry.id, root: entry.project }] }; return item;
			});
			return [...active, open('Nueva tarea', 'add'), open('Progreso y resultados', 'pulse'), advanced];
		}
		const nodes = project.profile.actions.map(action => { const item = new vscode.TreeItem(action); item.iconPath = new vscode.ThemeIcon(action === 'run' ? 'play' : 'terminal'); item.command = { command: 'atsHarness.execute', title: action, arguments: [project.folder.uri.toString(), action] }; return item; });
		const provider = await this.getProvider(project.profile);
		const choice = new vscode.TreeItem(project.profile.id === 'armotusitio' && project.profile.workflow ? vscode.l10n.t('Ejecuci\u00f3n: {0}', provider.label) : vscode.l10n.t('IA: {0}', provider.label)); choice.iconPath = new vscode.ThemeIcon('hubot');
		choice.tooltip = provider.custom ? vscode.l10n.t('HARNESS_AGENT_COMMAND tiene prioridad sobre HARNESS_HOST.') : provider.inherited ? vscode.l10n.t('HARNESS_HOST proviene del entorno heredado del IDE.') : vscode.l10n.t('Eleg\u00ed la IA para las pr\u00f3ximas ejecuciones de este proyecto.');
		if (provider.supported !== false) { choice.command = { command: 'atsHarness.selectProvider', title: vscode.l10n.t('Elegir IA del Harness'), arguments: [project.folder.uri.toString()] }; }
		nodes.unshift(choice);
		for (const job of this.getHistory()) {
			if (job.project !== project.profile.root) { continue; }
			const item = new vscode.TreeItem(job.action + ' \u2014 ' + job.state); item.description = (job.host ? job.host + ' \u00b7 ' : '') + new Date(job.startedAt).toLocaleString(); item.iconPath = new vscode.ThemeIcon(job.state === 'running' ? 'sync' : job.state === 'passed' ? 'check' : job.state === 'unknown' ? 'question' : 'error'); nodes.unshift(item);
		}
		return nodes;
	}
	async execute(uri, action, token = undefined) {
		const project = await selectProject(uri); if (!project) { vscode.window.showWarningMessage('Supported workspace not found'); return; }
		if (!action) { action = await vscode.window.showQuickPick(project.profile.actions, { placeHolder: vscode.l10n.t('Eleg\u00ed un comando del harness') }); }
		if (!action) { return; }
		if (['verify', 'test', 'run', 'dispatch', 'abort'].includes(action) && this.harnessBusy(project.profile.root)) { vscode.window.showWarningMessage(vscode.l10n.t('Hay una operaci\u00f3n del Harness en curso para este proyecto. Actualiz\u00e1 su estado antes de iniciar otra.')); return; }
		if (token?.isCancellationRequested) { return; }
		let spec; try { spec = command(project.profile, action); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
		if (!vscode.workspace.isTrusted) { vscode.window.showWarningMessage('Trust the workspace before executing harness tasks.'); return; }
		const guarded = repeatActions.includes(action);
		const launchKey = JSON.stringify([spec.cwd, action]);
		if (guarded && this.isBusy(spec.cwd, action)) { vscode.window.showWarningMessage(vscode.l10n.t('Esa tarea ya est\u00e1 activa o esperando confirmaci\u00f3n en el IDE.')); return; }
		if (guarded) { this.launching.add(launchKey); this.refresh(); }
		try {
			if (await vscode.window.showWarningMessage('Run ' + spec.executable + ' ' + spec.args.join(' ') + ' in ' + project.profile.name + '?', { modal: true }, 'Run') !== 'Run') { return; }
			if (guarded && !(await projects()).some(item => item.profile.root === spec.cwd && item.profile.actions.includes(action))) { return; }
			if (!vscode.workspace.isTrusted) { return; }
			if (['verify', 'test', 'run', 'dispatch', 'abort'].includes(action) && this.harnessBusy(project.profile.root)) { return; }
			if (token?.isCancellationRequested) { return; }
			const provider = await this.getProvider(project.profile);
			if (!vscode.workspace.isTrusted || token?.isCancellationRequested) { return; }
			if (!vscode.workspace.getConfiguration('atsHarness').get('enabled', true) || !vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === project.folder.uri.toString())) { return; }
			const host = provider.custom ? 'custom' : provider.supported === false ? 'plan' : provider.host;
			const env = host && ['codex', 'claude'].includes(host) && action !== 'test' ? { HARNESS_HOST: host } : undefined;
			const task = new vscode.Task({ type: 'ats-harness', action }, project.folder, 'ATS ' + project.profile.id + ' ' + action, 'ArmoTuSitio IDE', new vscode.ProcessExecution(spec.executable, spec.args, { cwd: spec.cwd, env }));
			task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.New };
			const execution = await vscode.tasks.executeTask(task);
			const id = Date.now() + '-' + Math.random().toString(36).slice(2);
			const job = { id, project: spec.cwd, projectName: project.profile.name, action, host, state: 'running', started: new Date().toLocaleTimeString(), startedAt: Date.now(), endedAt: undefined };
			this.jobs.set(execution, job);
			this.history.put(job);
			this.refresh();
			return id;
		} finally { if (guarded) { this.launching.delete(launchKey); this.refresh(); } }
	}
	/** Notify once for IDE task completion, using the current project preference. */
	async notifyCompletion(job) {
		const config = vscode.workspace.getConfiguration('atsHarness', vscode.Uri.file(job.project));
		const configuredMode = config.get('notifications', 'errors');
		const mode = configuredMode === 'always' && this.getHarnessPreferences().focus ? 'errors' : configuredMode;
		if (!config.get('enabled', true) || (mode !== 'always' && !(mode === 'errors' && ['failed', 'ended'].includes(job.state)))) { return; }
		const seconds = Math.max(0, Math.floor((job.endedAt - job.startedAt) / 1000));
		const messages = {
			passed: vscode.l10n.t('Harness: {0} en {1} termin\u00f3 correctamente ({2} s).', job.action, job.projectName, seconds),
			failed: vscode.l10n.t('Harness: {0} en {1} fall\u00f3 ({2} s).', job.action, job.projectName, seconds),
			cancelled: vscode.l10n.t('Harness: {0} en {1} se cancel\u00f3 ({2} s).', job.action, job.projectName, seconds),
			ended: vscode.l10n.t('Harness: {0} en {1} finaliz\u00f3 sin c\u00f3digo de salida ({2} s). Revis\u00e1 el resultado en la terminal.', job.action, job.projectName, seconds)
		};
		const open = vscode.l10n.t('Ver historial');
		const message = messages[job.state];
		if (!message) { return; }
		const selection = job.state === 'failed' ? await vscode.window.showErrorMessage(message, open)
			: job.state === 'ended' ? await vscode.window.showWarningMessage(message, open)
				: await vscode.window.showInformationMessage(message, open);
		if (selection === open) { await vscode.commands.executeCommand('atsHarness.history'); }
	}
	finish(execution, exitCode) {
		const job = this.jobs.get(execution); if (!job || job.state !== 'running') { return; }
		job.state = job.cancelRequested ? 'cancelled' : exitCode === 0 ? 'passed' : exitCode === undefined ? 'ended' : 'failed';
		job.endedAt = Date.now(); this.history.put(job);
		for (const [key, value] of this.jobs) { if (value.state !== 'running' && !this.history.rows.some(row => row.id === value.id)) { this.jobs.delete(key); } }
		this.refresh();
		void this.notifyCompletion(job).catch(() => { /* Notification failures must not change the task outcome. */ });
	}
	async terminate() {
		const jobs = [...this.jobs.entries()].filter(([, job]) => job.state === 'running');
		if (!jobs.length) { vscode.window.showInformationMessage('No active ATS harness task'); return; }
		const selected = await vscode.window.showQuickPick(jobs.map(([execution, job]) => ({ label: job.action + ' \u00b7 ' + job.project, execution })), { placeHolder: 'Cancel one ATS task' });
		if (!selected) { return; }
		if (await vscode.window.showWarningMessage('Terminate this harness process?', { modal: true }, 'Terminate') === 'Terminate') { this.jobs.get(selected.execution).cancelRequested = true; selected.execution.terminate(); }
	}
}
async function reviewPlan() {
	const project = await selectProject(); if (!project) { return; }
	const files = await vscode.window.showOpenDialog({ defaultUri: project.folder.uri, canSelectFiles: true, canSelectMany: false, filters: { JSON: ['json'] } });
	if (!files?.length) { return; }
	try {
		const raw = await vscode.workspace.fs.readFile(files[0]);
		if (raw.byteLength > 1048576) { throw new Error('Plan too large'); }
		const result = validatePlan(JSON.parse(Buffer.from(raw).toString('utf8')));
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(files[0]));
		vscode.window.showInformationMessage('Validated agent DAG: ' + result.tasks + ' tasks, reserved budget ' + result.budget + '. Plan was not executed.');
	} catch (e) { vscode.window.showErrorMessage('Invalid agent plan: ' + e.message); }
}
function activate(context) {
	const controller = new Controller(context);
	registerNativeHarness(context, vscode);
	integrations.register(context, projects);
	registerHome(context, controller, projects);
	registerActivity(context, controller, projects, vscode);
	const mcp = registerMcp(context, vscode);
	context.subscriptions.push(vscode.commands.registerCommand('atsIde.issueContext', async key => {
		if (!mcp?.enabled() || !/^[a-z][a-z0-9-]*-\d+$/i.test(key)) { return; }
		try { const result = await mcp.client.call('get_issue_context', { issue_key: key }); if (result.isError) { return false; } await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: require('./src/workflow.ts').redact(JSON.stringify(result.structuredContent ?? result.content, null, 2)) })); return true; } catch { vscode.window.showErrorMessage(vscode.l10n.t('No se pudo consultar la tarjeta. Revis\u00e1 la conexi\u00f3n MCP y sus permisos.')); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.taskActions', async () => {
		const entries = controller.getWorkflowActivity();
		const selected = await vscode.window.showQuickPick(entries.map(entry => ({ label: entry.title || entry.nativeId || entry.id, description: entry.project, detail: entry.phase, entry })), { title: vscode.l10n.t('Abrir una tarea del Harness') });
		if (selected) { await vscode.commands.executeCommand('atsIde.home', { task: selected.entry.nativeId, root: selected.entry.project }); }
	}));
	registerChat(context, controller, projects, mcp, vscode);
	context.subscriptions.push(controller.events);
	context.subscriptions.push(vscode.window.registerTreeDataProvider('atsHarness.tasks', controller));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.refresh', async () => { await controller.refreshActivity(true); controller.refresh(); }));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.history', () => vscode.commands.executeCommand('atsIde.home')));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.clearHistory', () => controller.clearHistory()));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.execute', (uri, action) => controller.execute(uri, action)));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.selectProvider', async item => { const project = await selectProject(item?.project?.folder?.uri?.toString() || (typeof item === 'string' ? item : undefined)); if (project) { await selectProvider(project, vscode); controller.refresh(); } }));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.cancelTask', () => controller.terminate()));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.reviewPlan', reviewPlan));
	for (const action of ['check', 'status', 'run']) { context.subscriptions.push(vscode.commands.registerCommand('atsHarness.' + action, uri => controller.execute(uri, action))); }
	context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(e => controller.finish(e.execution, e.exitCode)));
	context.subscriptions.push(vscode.tasks.onDidEndTask(e => { if (controller.jobs.get(e.execution)?.state === 'running') { controller.finish(e.execution, undefined); } }));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('atsHarness.enabled')) { controller.refresh(); } }));
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => controller.refresh()));
	const watcher = vscode.workspace.createFileSystemWatcher('**/package.json');
	context.subscriptions.push(watcher);
	context.subscriptions.push(watcher.onDidChange(() => controller.refresh()), watcher.onDidCreate(() => controller.refresh()), watcher.onDidDelete(() => controller.refresh()));
	const providerWatcher = vscode.workspace.createFileSystemWatcher('**/.harness/.env');
	context.subscriptions.push(providerWatcher, providerWatcher.onDidChange(() => controller.refresh()), providerWatcher.onDidCreate(() => controller.refresh()), providerWatcher.onDidDelete(() => controller.refresh()));
	if (vscode.workspace.getConfiguration('atsHarness').get('showWelcome', true) && vscode.window.tabGroups.all.every(group => group.tabs.length === 0)) { void vscode.commands.executeCommand('atsIde.home'); }
}
function deactivate() { }
module.exports = { activate, deactivate };
