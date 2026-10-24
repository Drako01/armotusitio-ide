/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { ACTIONS } = require('./core.ts');
const runFile = promisify(execFile);
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
			for (const row of saved.slice(-100)) { this.put(row, true); }
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
		this.rows = this.rows.reverse().filter(item => { const count = (counts.get(item.project) || 0) + 1; counts.set(item.project, count); return count <= 20; }).slice(0, 100).reverse();
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
	try {
		const { stdout } = await runFile('node', [path.join(profile.root, '.harness', 'core.mjs'), 'progress', '--json'], {
			cwd: profile.root, windowsHide: true, timeout: 10000, maxBuffer: 262144
		});
		return normalizeProgress(JSON.parse(stdout));
	} catch (error) {
		if (typeof error.stderr === 'string' && error.stderr.includes('No active task; pass a <task-id>')) { return null; }
		throw error;
	}
}

/** Discard logs, commands and arbitrary metadata from the native response. */
function normalizeProgress(value) {
	if (!value || typeof value.id !== 'string' || !/^[a-z0-9._-]{1,100}$/i.test(value.id) || typeof value.state !== 'string' || !/^[a-z_-]{1,40}$/i.test(value.state)) { throw new Error('Invalid progress'); }
	const result = { id: value.id, state: value.state, live: value.live === true, percent: undefined, elapsedMs: undefined };
	if (Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) { result.percent = value.percent; }
	if (Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) { result.elapsedMs = value.elapsedMs; }
	return result;
}

/** Poll trusted projects with bounded subprocesses and discard obsolete responses. */
function registerActivity(context, controller, projects, vscode, reader = readProgress) {
	const t = message => vscode.l10n.t(message);
	const bar = vscode.window.createStatusBarItem('atsHarness.activity', vscode.StatusBarAlignment.Left, 20);
	bar.name = t('Actividad del Harness');
	bar.command = 'atsIde.home';
	let disposed = false, polling = false;
	controller.progress = [];
	function render() {
		const running = [...controller.jobs.values()].filter(job => job.state === 'running').length;
		const workflows = controller.getWorkflowActivity?.() || [];
		const owned = [...workflows].reverse().find(entry => entry.owned && ['preparing', 'creating', 'running', 'stopping'].includes(entry.phase));
		const live = controller.progress.find(row => row.live);
		const stalled = controller.progress.find(row => row.state === 'stalled');
		bar.text = live ? `$(sync~spin) Harness \u00b7 ${live.id}${live.percent === undefined ? '' : ' \u00b7 ' + live.percent + '%'}` : running ? `$(sync~spin) Harness \u00b7 ${running}` : '$(pulse) Harness';
		bar.tooltip = t('Abr\u00ed el inicio para ver el progreso y el historial del Harness.');
		if (!live && !running && stalled) { bar.text = '$(warning) Harness'; bar.tooltip = t('El Harness tiene una tarea sin proceso activo. Abr\u00ed el inicio para ver su progreso registrado.'); }
		if (controller.progress.some(row => row.error)) { bar.text = '$(warning) Harness'; bar.tooltip = t('No se pudo consultar el progreso. Abr\u00ed el inicio para volver a intentar.'); }
		if (owned) {
			const stale = owned.progressError || (owned.checkedAt && Date.now() - owned.checkedAt > 15000);
			const label = owned.phase === 'preparing' ? t('Revisando tarea') : owned.phase === 'creating' ? t('Preparando ejecuci\u00f3n') : owned.phase === 'stopping' ? t('Deteniendo tarea') : t('Ejecutando tarea');
			bar.text = stale ? '$(warning) Harness' : `$(sync~spin) Harness \u00b7 ${owned.title ? owned.title.slice(0, 50) : label}${owned.progress?.percent === undefined ? '' : ' \u00b7 ' + owned.progress.percent + '%'}`;
			bar.tooltip = stale ? t('El progreso no est\u00e1 actualizado. Abr\u00ed el Harness para revisar la conexi\u00f3n y la tarea actual.') : `${label}\n${owned.project}\n${owned.nativeId || ''}`;
		}
		const finished = [...workflows].reverse().find(entry => ['completed', 'failed'].includes(entry.phase) && entry.endedAt && Date.now() - entry.endedAt < 60000);
		if (!owned && !live && finished && !controller.progress.some(row => row.error)) {
			bar.text = `${finished.phase === 'completed' ? '$(check)' : '$(error)'} Harness \u00b7 ${finished.phase === 'completed' ? t('Tarea completada') : t('La tarea fall\u00f3')}`;
			bar.tooltip = `${finished.title || ''}\n${finished.project}\n${finished.nativeId || ''}`;
		}
		if (!vscode.workspace.isTrusted) { bar.text = '$(lock) Harness'; bar.tooltip = t('Marc\u00e1 el workspace como confiable para consultar el progreso.'); }
	}
	async function refresh(manual = false) {
		if (disposed || polling) { return; }
		polling = true;
		try {
			const all = await projects();
			if (disposed) { return; }
			if (!all.length) { controller.progress = []; bar.hide(); controller.refresh(); return; }
			bar.show();
			const trusted = vscode.workspace.isTrusted;
			const rows = trusted ? await Promise.all(all.filter(({ profile }) => profile.id === 'redevent' && profile.actions.includes('progress')).map(async ({ profile }) => {
				try {
					const current = [...(controller.getWorkflowActivity?.() || [])].reverse().find(entry => entry.project === profile.root && entry.owned && entry.phase === 'running' && entry.progress?.live && !entry.progressError);
					const result = current ? normalizeProgress(current.progress) : await reader(profile);
					return result ? { project: profile.root, ...result, error: false } : null;
				}
				catch { return { project: profile.root, error: true }; }
			})) : [];
			if (disposed) { return; }
			const current = await projects();
			controller.progress = vscode.workspace.isTrusted ? rows.filter(row => row && current.some(({ profile }) => profile.root === row.project)) : [];
			await controller.refreshWorkflowActivity?.(manual);
			if (disposed) { return; }
			if (!current.length) { bar.hide(); }
			render(); controller.refresh();
		} catch {
			if (!disposed) { controller.progress = []; bar.hide(); controller.refresh(); }
		} finally { polling = false; }
	}
	const timer = setInterval(() => { void refresh(); }, 3000);
	const changed = controller.onDidChangeTreeData(render);
	context.subscriptions.push(bar, changed,
		vscode.workspace.onDidGrantWorkspaceTrust(() => { void refresh(); }),
		vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh(); }),
		vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('atsHarness.enabled')) { void refresh(); } }),
		{ dispose() { disposed = true; clearInterval(timer); } });
	controller.refreshActivity = refresh;
	void refresh();
}

module.exports = { History, normalizeProgress, readProgress, registerActivity };
