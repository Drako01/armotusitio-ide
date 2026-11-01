/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const { ACTIONS } = require('./core.ts');
const { nativeRun, progressView } = require('./workflow.ts');
const { sortActivity } = require('./adapter.ts');
const key = 'atsHarness.history.v1';
const states = ['running', 'passed', 'failed', 'cancelled', 'ended', 'unknown'];

/** Keep only execution summaries, bounded to twenty entries per project. */
class History {
	storage;
	reportError;
	rows: { id: string; project: string; action: string; host?: string; state: string; startedAt: number; endedAt?: number }[] = [];
	pending = Promise.resolve();
	constructor(storage, reportError) {
		this.storage = storage;
		this.reportError = reportError;
		const saved = storage.get(key, []);
		if (Array.isArray(saved)) {
			for (const row of saved) { this.put(row, true); }
		}
	}
	put(row, restored = false) {
		if (!row || typeof row.id !== 'string' || row.id.length > 100 || typeof row.project !== 'string' || row.project.length > 4096 || !ACTIONS.includes(row.action) || !states.includes(row.state) || !Number.isSafeInteger(row.startedAt) || row.startedAt < 0) { return; }
		const state = restored && row.state === 'running' ? 'unknown' : row.state;
		const entry = { id: row.id, project: row.project, action: row.action, host: ['codex', 'claude', 'custom', 'plan'].includes(row.host) ? row.host : undefined, state, startedAt: row.startedAt, endedAt: undefined };
		if (state !== 'running' && state !== 'unknown' && Number.isSafeInteger(row.endedAt) && row.endedAt >= row.startedAt) { entry.endedAt = row.endedAt; }
		this.rows = this.rows.filter(item => item.id !== entry.id);
		this.rows.push(entry);
		this.rows.sort((a, b) => a.startedAt - b.startedAt);
		const counts = new Map();
		this.rows = this.rows.reverse().filter(item => { if (['running', 'unknown'].includes(item.state)) { return true; } const count = (counts.get(item.project) || 0) + 1; counts.set(item.project, count); return count <= 20; }).reverse();
		if (!restored) { this.save(); }
	}
	save() {
		const rows = this.rows.map(row => ({ ...row }));
		this.pending = this.pending.then(() => this.storage.update(key, rows)).catch(() => this.reportError());
	}
	clear() { this.rows = []; this.save(); }
}

/** Read the native, read-only progress view; never execute or retry a harness task. */
async function readProgress(profile) {
	const result = await nativeRun(profile, ['progress', '--json'], { timeout: 15000 });
	if (result.code === 0) { return normalizeProgress(result.value); }
	if (/E_NO_ACTIVE_TASK|No active task; pass a <task-id>/.test(result.error || '')) { return null; }
	throw new Error('HARNESS_PROGRESS');
}

/** Preserve sanitized operational fields shared with every other surface. */
function normalizeProgress(value) { return progressView(value); }

/** Poll trusted projects with bounded subprocesses and discard obsolete responses. */
/** Workflow phases of Inicio's task form, as feed states and needs. */
const WORKFLOW_STATES = {
	preparing: ['running'], creating: ['running'], running: ['running'], stopping: ['running'], pending: ['queued'],
	questions: ['paused', 'answer'], review: ['queued', 'approval'], blocked: ['blocked', 'decision'],
	completed: ['completed'], failed: ['failed'], cancelled: ['cancelled'], interrupted: ['interrupted']
};

/** Publish the task form's workflows and the project Harness progress to the feed, so Inicio reads one source. */
function publishSources(feed, controller, progress) {
	const workflows = controller.getWorkflowActivity?.() || [];
	const ids = new Set();
	for (const entry of workflows) {
		const [state, needs] = WORKFLOW_STATES[entry.phase] || ['interrupted'];
		const id = 'task:' + entry.id;
		ids.add(id);
		feed.publish({
			id, kind: 'task', project: entry.project, title: entry.title || entry.nativeId || entry.id, state, ...(needs ? { needs } : {}),
			startedAt: entry.startedAt || entry.checkedAt || 0, updatedAt: entry.endedAt || entry.checkedAt || entry.startedAt || 0,
			...(entry.progress?.percent === undefined ? {} : { detail: entry.progress.percent + '%' }), ...(entry.progressError ? { stale: true } : {}),
			actions: ['open'], origin: entry.owned ? 'this-window' : 'external', ...(entry.nativeId ? { parentId: entry.nativeId } : {})
		});
	}
	for (const row of progress) {
		if (row.error || !row.id) { continue; }
		const id = 'external:' + row.project + ':' + row.id;
		ids.add(id);
		const state = row.live ? 'running' : row.outcome === 'passed' || row.outcome === 'completed' ? 'completed' : row.outcome === 'failed' ? 'failed' : row.state === 'stalled' ? 'interrupted' : 'completed';
		feed.publish({ id, kind: 'external', project: row.project, title: row.title || row.id, state, startedAt: row.startedAt || 0, updatedAt: row.checkedAt || row.startedAt || 0, ...(row.percent === undefined ? {} : { detail: row.percent + '%' }), actions: ['open'], origin: 'external' });
	}
	feed.retain(item => (item.kind !== 'task' && item.kind !== 'external') || ids.has(item.id));
}

function registerActivity(context, controller, projects, vscode, reader = readProgress, feed = undefined) {
	const t = message => vscode.l10n.t(message);
	const bar = vscode.window.createStatusBarItem('atsHarness.activity', vscode.StatusBarAlignment.Left, 20);
	bar.name = t('Actividad del Harness');
	bar.command = 'atsIde.home';
	let disposed = false, polling, trailing = false;
	controller.progress = [];
	if (feed) { context.subscriptions.push(feed.onDidChange(() => render())); }
	function render() {
		const progress = controller.readHarnessProgress?.() || controller.progress;
		const items = feed?.snapshot() || [];
		const feedRunning = items.filter(item => item.kind === 'chat-run' && item.state === 'running').length;
		const attention = items.filter(item => item.needs).length;
		const running = [...controller.jobs.values()].filter(job => job.state === 'running').length + (controller.nativeRunning?.() || 0) + feedRunning;
		const workflows = controller.getWorkflowActivity?.() || [];
		const owned = sortActivity(workflows).find(entry => (entry.owned || entry.progress?.live || ['preparing', 'creating', 'stopping'].includes(entry.phase)) && ['preparing', 'creating', 'running', 'stopping'].includes(entry.phase));
		const live = progress.find(row => row.live);
		const stalled = progress.find(row => row.state === 'stalled');
		bar.text = live ? `$(sync~spin) Harness \u00b7 ${live.id}${live.percent === undefined ? '' : ' \u00b7 ' + live.percent + '%'}` : running ? `$(sync~spin) Harness \u00b7 ${running}` : '$(pulse) Harness';
		bar.tooltip = t('Abr\u00ed el inicio para ver el progreso y el historial del Harness.');
		if (!live && !running && stalled) { bar.text = '$(warning) Harness'; bar.tooltip = t('El Harness tiene una tarea sin proceso activo. Abr\u00ed el inicio para ver su progreso registrado.'); }
		if (progress.some(row => row.error)) { bar.text = '$(warning) Harness'; bar.tooltip = t('No se pudo consultar el progreso. Abr\u00ed el inicio para volver a intentar.'); }
		if (owned) {
			const stale = owned.progressError || (owned.checkedAt && Date.now() - owned.checkedAt > 15000);
			const label = owned.phase === 'preparing' ? t('Revisando tarea') : owned.phase === 'creating' ? t('Preparando ejecuci\u00f3n') : owned.phase === 'stopping' ? t('Deteniendo tarea') : t('Ejecutando tarea');
			bar.text = stale ? '$(warning) Harness' : `$(sync~spin) Harness \u00b7 ${owned.title ? owned.title.slice(0, 50) : label}${owned.progress?.percent === undefined ? '' : ' \u00b7 ' + owned.progress.percent + '%'}`;
			bar.tooltip = stale ? t('El progreso no est\u00e1 actualizado. Abr\u00ed el Harness para revisar la conexi\u00f3n y la tarea actual.') : `${label}\n${owned.project}\n${owned.nativeId || ''}`;
		}
		const finished = [...workflows].reverse().find(entry => ['completed', 'failed', 'cancelled'].includes(entry.phase) && entry.endedAt && Date.now() - entry.endedAt < 60000);
		if (!owned && !live && !running && finished && !progress.some(row => row.error)) {
			bar.text = `${finished.phase === 'completed' ? '$(check)' : finished.phase === 'cancelled' ? '$(circle-slash)' : '$(error)'} Harness \u00b7 ${finished.phase === 'completed' ? t('Tarea completada') : finished.phase === 'cancelled' ? t('Tarea cancelada') : t('La tarea fall\u00f3')}`;
			bar.tooltip = `${finished.title || ''}\n${finished.project}\n${finished.nativeId || ''}`;
		}
		// The single Harness item also tells the provider quota (AB) and the cache in use (I).
		const extras = [controller.quotaDescription, controller.cacheDescription && t('Cach\u00e9: ') + controller.cacheDescription].filter(Boolean);
		if (extras.length && typeof bar.tooltip === 'string') { bar.tooltip += '\n' + extras.join('\n'); }
		// What needs the user wins over everything else: it is the reason to open Inicio now.
		bar.backgroundColor = undefined;
		if (attention) {
			bar.text = `$(bell) Harness \u00b7 ${running ? running + ' ' + t('en curso') + ' \u00b7 ' : ''}${attention} ${t('atenci\u00f3n')}`;
			bar.tooltip = t('Hay algo esperando tu decisi\u00f3n. Abr\u00ed Inicio para resolverlo.');
			bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		}
		if (!vscode.workspace.isTrusted) { bar.text = '$(lock) Harness'; bar.tooltip = t('Marc\u00e1 el workspace como confiable para consultar el progreso.'); }
		if (feed) { bar.show(); }
	}
	async function sample(manual) {
		try {
			const all = await projects();
			if (disposed) { return; }
			const native = await controller.nativeProjects?.() || [];
			if (!all.length && !native.length) { controller.progress = []; bar.hide(); controller.refresh(); return; }
			bar.show();
			await controller.refreshWorkflowActivity?.(manual);
			const rows = vscode.workspace.isTrusted ? await Promise.all(all.map(async ({ profile }) => {
				if (profile.workflow && controller.getWorkflowActivity) {
					return sortActivity(controller.getWorkflowActivity().filter(entry => entry.project === profile.root && entry.progress)).map(entry => ({ project: profile.root, ...entry.progress, checkedAt: entry.checkedAt, error: entry.progressError === true }));
				}
				if (profile.id !== 'redevent' || !profile.actions.includes('progress')) { return []; }
				try { const result = await reader(profile); return result ? [{ project: profile.root, ...result, error: false }] : []; }
				catch { return [{ project: profile.root, error: true }]; }
			})) : [];
			if (disposed) { return; }
			const current = await projects();
			controller.progress = vscode.workspace.isTrusted ? rows.flat().filter(row => current.some(({ profile }) => profile.root === row.project)) : [];
			if (feed) { publishSources(feed, controller, controller.readHarnessProgress?.() || controller.progress); }
			if (!current.length && !native.length) { bar.hide(); }
			render(); controller.refresh();
		} catch { if (!disposed) { render(); controller.refresh(); } }
	}
	async function refresh(manual = false) {
		if (disposed) { return; }
		if (polling) { if (manual) { trailing = true; return polling; } return; }
		polling = (async () => { do { const full = manual || trailing; trailing = false; await sample(full); manual = false; } while (trailing && !disposed); })();
		try { await polling; } finally { polling = undefined; }
	}
	let debounce;
	const watchers = [];
	if (vscode.workspace.createFileSystemWatcher && vscode.RelativePattern) {
		for (const folder of vscode.workspace.workspaceFolders || []) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.harness/{tasks,locks,active,completed,failed}/**/*'));
			const invalidate = () => { clearTimeout(debounce); debounce = setTimeout(() => { void refresh(); }, 250); };
			watchers.push(watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate));
		}
	}
	context.subscriptions.push(...watchers);
	let timer;
	function schedule() {
		clearTimeout(timer); if (disposed) { return; }
		const active = (controller.getWorkflowActivity?.() || []).some(entry => entry.progress?.live || ['preparing', 'creating', 'running', 'stopping'].includes(entry.phase)) || [...controller.jobs.values()].some(job => job.state === 'running');
		timer = setTimeout(() => { void refresh().finally(schedule); }, active ? 2000 : 15000);
	}
	const changed = controller.onDidChangeTreeData(() => { render(); schedule(); });
	context.subscriptions.push(bar, changed,
		vscode.workspace.onDidGrantWorkspaceTrust(() => { void refresh(); }),
		vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); }),
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('atsHarness.enabled')) { void refresh(); } }),
		{ dispose() { disposed = true; clearTimeout(timer); clearTimeout(debounce); } });
	controller.refreshActivity = refresh;
	void refresh().finally(schedule);
}

module.exports = { History, normalizeProgress, readProgress, registerActivity };
