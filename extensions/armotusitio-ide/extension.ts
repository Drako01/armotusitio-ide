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
	events = new vscode.EventEmitter();
	onDidChangeTreeData = this.events.event;
	history;
	progress = [];
	refreshActivity = async () => { };
	constructor(context) {
		this.history = new History(context.workspaceState, () => vscode.window.showWarningMessage(vscode.l10n.t('No se pudo guardar el historial del Harness.')));
	}
	getHistory() {
		const rows = new Map<string, { id: string; project: string; action: string; state: string; startedAt: number; endedAt?: number }>(this.history.rows.map(row => [row.id, row]));
		for (const job of this.jobs.values()) { if (job.state === 'running') { rows.set(job.id, job); } }
		return [...rows.values()].sort((a, b) => a.startedAt - b.startedAt);
	}
	async clearHistory() {
		const clear = vscode.l10n.t('Borrar historial');
		if (await vscode.window.showWarningMessage(vscode.l10n.t('\u00bfQuer\u00e9s borrar el historial de este workspace? Las tareas activas van a seguir ejecut\u00e1ndose.'), { modal: true }, clear) === clear) { this.history.clear(); this.refresh(); }
	}
	refresh() { this.events.fire(); }
	getTreeItem(item) { return item; }
	async getChildren(element) {
		if (!element) {
			const all = await projects(); return all.length ? all.map(project => { const item = new vscode.TreeItem(project.profile.name, vscode.TreeItemCollapsibleState.Expanded); item.project = project; item.iconPath = new vscode.ThemeIcon('repo'); item.description = project.profile.repo; return item; }) : [new vscode.TreeItem('Open RedEvent or ArmoTuSitio 2.0')];
		}
		if (!element.project) { return []; }
		const { project } = element;
		const nodes = project.profile.actions.map(action => { const item = new vscode.TreeItem(action); item.iconPath = new vscode.ThemeIcon(action === 'run' ? 'play' : 'terminal'); item.command = { command: 'atsHarness.execute', title: action, arguments: [project.folder.uri.toString(), action] }; return item; });
		for (const job of this.getHistory()) {
			if (job.project !== project.profile.root) { continue; }
			const item = new vscode.TreeItem(job.action + ' \u2014 ' + job.state); item.description = new Date(job.startedAt).toLocaleString(); item.iconPath = new vscode.ThemeIcon(job.state === 'running' ? 'sync' : job.state === 'passed' ? 'check' : job.state === 'unknown' ? 'question' : 'error'); nodes.unshift(item);
		}
		return nodes;
	}
	async execute(uri, action) {
		const project = await selectProject(uri); if (!project) { vscode.window.showWarningMessage('Supported workspace not found'); return; }
		if (!action) { action = await vscode.window.showQuickPick(project.profile.actions, { placeHolder: vscode.l10n.t('Eleg\u00ed un comando del harness') }); }
		if (!action) { return; }
		let spec; try { spec = command(project.profile, action); } catch (e) { vscode.window.showErrorMessage(e.message); return; }
		if (!vscode.workspace.isTrusted) { vscode.window.showWarningMessage('Trust the workspace before executing harness tasks.'); return; }
		if (await vscode.window.showWarningMessage('Run ' + spec.executable + ' ' + spec.args.join(' ') + ' in ' + project.profile.name + '?', { modal: true }, 'Run') !== 'Run') { return; }
		const task = new vscode.Task({ type: 'ats-harness', action }, project.folder, 'ATS ' + project.profile.id + ' ' + action, 'ArmoTuSitio IDE', new vscode.ProcessExecution(spec.executable, spec.args, { cwd: spec.cwd }));
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.New };
		const execution = await vscode.tasks.executeTask(task);
		const id = Date.now() + '-' + Math.random().toString(36).slice(2);
		const job = { id, project: spec.cwd, projectName: project.profile.name, action, state: 'running', started: new Date().toLocaleTimeString(), startedAt: Date.now(), endedAt: undefined };
		this.jobs.set(execution, job);
		this.history.put(job);
		this.refresh();
	}
	/** Notify once for IDE task completion, using the current project preference. */
	async notifyCompletion(job) {
		const config = vscode.workspace.getConfiguration('atsHarness', vscode.Uri.file(job.project));
		const mode = config.get('notifications', 'errors');
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
	integrations.register(context, projects);
	registerHome(context, controller, projects);
	registerActivity(context, controller, projects, vscode);
	context.subscriptions.push(controller.events);
	context.subscriptions.push(vscode.window.registerTreeDataProvider('atsHarness.tasks', controller));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.refresh', async () => { await controller.refreshActivity(); controller.refresh(); }));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.history', () => vscode.commands.executeCommand('atsIde.home')));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.clearHistory', () => controller.clearHistory()));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.execute', (uri, action) => controller.execute(uri, action)));
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
	if (vscode.workspace.getConfiguration('atsHarness').get('showWelcome', true) && vscode.window.tabGroups.all.every(group => group.tabs.length === 0)) { void vscode.commands.executeCommand('atsIde.home'); }
}
function deactivate() { }
module.exports = { activate, deactivate };
