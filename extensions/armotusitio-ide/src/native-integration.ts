/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Native Harness IDE commands. Never execute project scripts merely by detecting them. */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NativeHarness, type Plan } from './native-harness.ts';
import { proposeProjectConfig, loadProjectConfig, writeProjectConfig, generatedConfigDigest, removeGeneratedProjectConfig } from './native-project.ts';
import { reviewAgentDraft, inspectAgentWorkspace, type NativeProvider, type AgentRole } from './native-providers.ts';
import { buildSupportReport, exportSupportReport } from './native-support.ts';
import { inspectHarnessAuthority } from './native-authority.ts';

type Host = any; // vscode host is injected by the existing extension (avoid duplicating the UI layer).
const sessions = new Map<string, NativeHarness>();

export function registerNativeHarness(context: Host, vscode: Host, controller: Host): void {
	const choose = async (requested?: string): Promise<{ folder: Host; engine: NativeHarness } | undefined> => {
		const roots = vscode.workspace.workspaceFolders || [];
		if (!roots.length) { vscode.window.showWarningMessage(vscode.l10n.t('Abr\u00ed una carpeta para utilizar el Harness nativo.')); return; }
		const folder = requested ? roots.find((f: Host) => f.uri.fsPath === requested) : roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(roots.map((f: Host) => ({ label: f.name, description: f.uri.fsPath, folder: f })), { placeHolder: 'Eleg\u00ed el proyecto' }))?.folder;
		if (!folder) { return; }
		const root = await fs.realpath(folder.uri.fsPath);
		// Existing native project Harness remains authoritative. Do not create competing task state.
		if ((await inspectHarnessAuthority(root)).engine === 'project') { vscode.window.showInformationMessage(vscode.l10n.t('El Harness del proyecto tiene prioridad. Revis\u00e1 sus controles y su compatibilidad desde el inicio.')); return; }
		const hash = createHash('sha256').update(root).digest('hex');
		const engine = sessions.get(root) || new NativeHarness(root, path.join(context.globalStorageUri.fsPath, 'native-harness', hash));
		sessions.set(root, engine); return { folder, engine };
	};
	const ensureTrust = (): boolean => vscode.workspace.isTrusted === true && vscode.workspace.getConfiguration('atsHarness').get('enabled', true);
	const authorized = (folder: Host): boolean => ensureTrust() && (vscode.workspace.workspaceFolders || []).some((current: Host) => current.uri.toString() === folder.uri.toString());
	const running = new Map<string, { engine: NativeHarness; taskId: string }>();
	controller.nativeRunning = () => running.size;
	controller.nativeProjects = async () => {
		const rows = [];
		if (!vscode.workspace.getConfiguration('atsHarness').get('enabled', true)) { return rows; }
		for (const folder of vscode.workspace.workspaceFolders || []) {
			try {
				if ((await inspectHarnessAuthority(folder.uri.fsPath)).engine === 'project') { continue; }
				const selected = await choose(folder.uri.fsPath);
				if (!selected) { continue; }
				const tasks = ensureTrust() ? await selected.engine.list() : [];
				const diagnostic = ensureTrust() ? await selected.engine.diagnose() : undefined;
				const configured = ensureTrust() ? !!await loadProjectConfig(folder.uri.fsPath) : false;
				rows.push({ root: folder.uri.fsPath, name: folder.name, engine: 'ide-native', configured, lock: diagnostic?.lock, tasks: tasks.sort((a, b) => Number(b.attempts.at(-1)?.status === 'running') - Number(a.attempts.at(-1)?.status === 'running')).slice(0, 100).map(task => ({ id: task.id, title: task.title, status: task.attempts.at(-1)?.status || 'pending', attempts: task.attempts.length, gates: task.plan.gates.map(gate => ({ id: gate.id, dependsOn: gate.dependsOn || [], status: task.attempts.at(-1)?.results.find(result => result.id === gate.id)?.status || 'pending' })), reconciliationRequired: task.attempts.at(-1)?.status === 'running' && (diagnostic?.lock !== 'active' || diagnostic?.lockTask !== task.id || diagnostic?.lockAttempt !== task.attempts.at(-1)?.id) })) });
			} catch { rows.push({ root: folder.uri.fsPath, name: folder.name, engine: 'ide-native', error: true, tasks: [] }); }
		}
		return rows;
	};
	const ticker = setInterval(() => { if (running.size) { controller.refresh(); } }, 1500);
	context.subscriptions.push({ dispose: () => clearInterval(ticker) });
	const showError = (e: unknown): void => { const code = e instanceof Error && /^HARNESS_[A-Z_]+$/.test(e.message) ? e.message : 'HARNESS_OPERATION_FAILED'; void vscode.window.showErrorMessage(vscode.l10n.t('Harness nativo: {0}. Revis\u00e1 el diagn\u00f3stico y la configuraci\u00f3n.', code)); };
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeAgentReview', async (requested?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('Workspace trust is required to prepare agents.')); return; }
			const chosen = await choose(requested);
			if (!chosen) { return; }
			const root = await fs.realpath(chosen.folder.uri.fsPath);
			const provider = await vscode.window.showQuickPick(['codex', 'claude'], { title: 'Select AI provider (review only)' }) as NativeProvider | undefined;
			if (!provider) { return; }
			const role = await vscode.window.showQuickPick(['planner', 'implementer', 'reviewer'], { title: 'Select agent role' }) as AgentRole | undefined;
			if (!role) { return; }
			const instruction = await vscode.window.showInputBox({ title: 'Agent instruction (not submitted to the provider)', prompt: 'Describe the proposed task. No AI execution will occur.' });
			if (!instruction) { return; }
			const readOnly = role !== 'implementer';
			const draft = { schemaVersion: 1 as const, provider, role, projectRoot: root, instruction, readOnly };
			const reviewed = reviewAgentDraft(draft);
			const inventory = await inspectAgentWorkspace(root);
			if (!ensureTrust() || await fs.realpath(chosen.folder.uri.fsPath) !== root) { return; }
			const preview = JSON.stringify({ review: reviewed, inventory, executionEnabled: false }, null, 2);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: preview }), { preview: true });
			vscode.window.showInformationMessage(vscode.l10n.t('Agent proposal reviewed locally. No provider was invoked.'));
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeSupport', async (requested?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('Workspace trust is required for support evidence.')); return; }
			const selected = await choose(requested); if (!selected) { return; }
			const report = await buildSupportReport(selected.folder.uri.fsPath, selected.engine);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) }), { preview: true });
			const action = await vscode.window.showInformationMessage(vscode.l10n.t('Support summary excludes command output and agent instructions.'), 'Export JSON');
			if (action !== 'Export JSON' || !ensureTrust()) { return; }
			const destination = await vscode.window.showSaveDialog({ filters: { 'JSON': ['json'] }, saveLabel: 'Export support evidence' });
			if (!destination) { return; }
			if (!ensureTrust()) { return; }
			await exportSupportReport(destination.fsPath, report);
			vscode.window.showInformationMessage(vscode.l10n.t('Support evidence exported without command output.'));
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeDoctor', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const p = await choose(requested); if (!p) { return; } const report = await p.engine.diagnose();
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) }));
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeConfigure', async (requested?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('Workspace trust is required for configuration.')); return; }
			const selected = await choose(requested);
			if (!selected) { return; }
			const root = await fs.realpath(selected.folder.uri.fsPath);
			const proposal = await proposeProjectConfig(root);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(proposal, null, 2) }), { preview: true });
			if (proposal.existing) { vscode.window.showInformationMessage(vscode.l10n.t('Existing Harness configuration has not been changed.')); return; }
			const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Create the reviewed .ats-harness.json? This does not run commands.'), { modal: true }, 'Create configuration');
			if (answer !== 'Create configuration' || !ensureTrust()) { return; }
			if (await fs.realpath(selected.folder.uri.fsPath) !== root) { throw Error('HARNESS_ROOT_CHANGED'); }
			const file = await writeProjectConfig(root, proposal.config);
			await context.globalState.update('atsHarness.generated.' + createHash('sha256').update(root).digest('hex'), generatedConfigDigest(proposal.config));
			vscode.window.showInformationMessage(`Harness configuration created: ${file}`);
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeRemoveConfiguration', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const selected = await choose(requested); if (!selected) { return; }
			const root = await fs.realpath(selected.folder.uri.fsPath);
			const key = 'atsHarness.generated.' + createHash('sha256').update(root).digest('hex');
			const digest = context.globalState.get(key);
			if (!digest) { throw Error('HARNESS_CONFIG_NOT_GENERATED'); }
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Retirar la configuraci\u00f3n generada por este IDE si sigue intacta. Se conserva el historial.'), { modal: true }, vscode.l10n.t('Retirar configuraci\u00f3n')) !== vscode.l10n.t('Retirar configuraci\u00f3n') || !authorized(selected.folder)) { return; }
			await removeGeneratedProjectConfig(root, digest);
			await context.globalState.update(key, undefined);
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeNewTask', async (requested?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('El proyecto debe ser confiable para crear tareas ejecutables.')); return; }
			const p = await choose(requested); if (!p) { return; }
			// Suggestions are never authorizations. No package script runs until reviewed explicitly.
			const existing = await loadProjectConfig(p.folder.uri.fsPath);
			const suggested = existing || (await proposeProjectConfig(p.folder.uri.fsPath)).config;
			const options = [{ label: vscode.l10n.t('Plan completo configurado'), executable: suggested.plan.gates[0].executable, args: suggested.plan.gates[0].args }, { label: 'Comando personalizado', executable: '', args: [] }];
			const selected = await vscode.window.showQuickPick(options, { title: 'Propuesta de verificaci\u00f3n (nada se ejecuta autom\u00e1ticamente)' });
			if (!selected) { return; }
			const executable = selected.executable || await vscode.window.showInputBox({ title: 'Ejecutable autorizado', prompt: 'Nombre del ejecutable, sin shell' });
			if (!executable) { return; }
			let args = selected.args;
			if (!selected.executable) {
				const raw = await vscode.window.showInputBox({ title: 'Argumentos JSON', value: '[]', prompt: 'Ejemplo: ["--version"]. No se interpreta shell.' });
				if (raw === undefined) { return; }
				args = JSON.parse(raw); if (!Array.isArray(args) || !args.every(x => typeof x === 'string')) { throw Error('HARNESS_ARGUMENTS'); }
			}
			const title = await vscode.window.showInputBox({ title: 'Nombre de la tarea', value: selected.label }); if (!title) { return; }
			const plan: Plan = selected.executable ? structuredClone(suggested.plan) : { schemaVersion: 1, gates: [{ id: 'verify', executable, args, cwd: '.' }] };
			// Present exact, immutable plan for explicit approval.
			const preview = JSON.stringify({ project: p.folder.uri.fsPath, plan }, null, 2);
			const doc = await vscode.workspace.openTextDocument({ language: 'json', content: preview }); await vscode.window.showTextDocument(doc, { preview: true });
			const accept = await vscode.window.showWarningMessage(vscode.l10n.t('Revis\u00e1 el plan y sus argumentos. \u00bfCrear la tarea sin ejecutarla?'), { modal: true }, 'Crear tarea');
			if (accept !== 'Crear tarea' || !authorized(p.folder)) { return; }
			const task = await p.engine.create(title, plan);
			vscode.window.showInformationMessage(`Tarea nativa registrada: ${task.id}. Us\u00e1 \u00abEjecutar tarea nativa\u00bb cuando quieras autorizarla.`);
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeRunTask', async (requested?: string, taskId?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('Este workspace no es confiable.')); return; }
			const p = await choose(requested); if (!p) { return; }
			const tasks = await p.engine.list();
			const selected = taskId ? tasks.filter(task => task.id === taskId).map(task => ({ task }))[0] : await vscode.window.showQuickPick(tasks.map(task => ({ label: task.title, description: task.id, task })), { title: 'Tareas nativas del proyecto' });
			if (!selected) { return; }
			const task = await p.engine.get(selected.task.id);
			const digest = await p.engine.reviewDigest(task.plan);
			const exact = task.plan.gates.map(g => `${g.executable} ${JSON.stringify(g.args)}  (${g.cwd || '.'})`).join('\n');
			if (await vscode.window.showWarningMessage(`Autorizar ejecuci\u00f3n local:\n${exact}`, { modal: true }, 'Ejecutar') !== 'Ejecutar') { return; }
			if (!ensureTrust()) { return; }
			if (running.has(p.folder.uri.toString())) { throw Error('HARNESS_ALREADY_RUNNING'); }
			running.set(p.folder.uri.toString(), { engine: p.engine, taskId: task.id });
			controller.refresh();
			let result;
			try { result = await p.engine.execute(task.id, digest, () => authorized(p.folder)); }
			finally { running.delete(p.folder.uri.toString()); controller.refresh(); }
			const last = result.attempts[result.attempts.length - 1];
			const state = ({ passed: 'Verificaci\u00f3n completada', failed: 'La verificaci\u00f3n fall\u00f3. Revis\u00e1 el resultado.', cancelled: 'Verificaci\u00f3n cancelada', interrupted: 'La verificaci\u00f3n requiere revisi\u00f3n', running: 'Verificaci\u00f3n en curso' })[last.status];
			vscode.window.showInformationMessage(vscode.l10n.t(state));
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeCancel', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const p = await choose(requested); if (!p) { return; }
			const current = running.get(p.folder.uri.toString());
			if (!current) { vscode.window.showInformationMessage(vscode.l10n.t('No hay una tarea nativa activa en este proyecto.')); return; }
			const answer = await vscode.window.showWarningMessage(`Cancelar la tarea activa ${current.taskId}?`, { modal: true }, 'Cancelar tarea');
			if (answer !== 'Cancelar tarea' || !ensureTrust()) { return; }
			current.engine.cancel();
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeStatus', async (requested?: string, taskId?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const p = await choose(requested); if (!p) { return; } const tasks = await p.engine.list();
			const history = await Promise.all(tasks.filter(task => !taskId || task.id === taskId).map(async task => ({ ...task, evidence: await p.engine.evidenceStatus(task.id) })));
			if (!ensureTrust()) { return; }
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(history, null, 2) }));
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeReconcile', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; } const p = await choose(requested); if (!p) { return; }
			const diagnostic = await p.engine.diagnose();
			const interrupted = (await p.engine.list()).some(task => task.attempts.some(attempt => attempt.status === 'running'));
			if (diagnostic.lock !== 'stale' && !(diagnostic.lock === 'none' && interrupted)) { vscode.window.showInformationMessage(vscode.l10n.t('No hay locks obsoletos ni intentos sin lock para reconciliar.')); return; }
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Marcar intentos interrumpidos y retirar el lock obsoleto. No reejecutar operaciones.'), { modal: true }, 'Reconciliar') !== 'Reconciliar') { return; }
			if (!ensureTrust()) { return; }
			await p.engine.reconcile(); vscode.window.showInformationMessage(vscode.l10n.t('Estado reconciliado sin reintentar tareas.'));
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push({ dispose() { for (const engine of sessions.values()) { engine.cancel(); } sessions.clear(); } });
}
