/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Native Harness IDE commands. Never execute project scripts merely by detecting them. */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NativeHarness, approvalDigest, type Plan } from './native-harness.ts';
import { proposeProjectConfig, loadProjectConfig, writeProjectConfig } from './native-project.ts';
import { reviewAgentDraft, inspectAgentWorkspace, type NativeProvider, type AgentRole } from './native-providers.ts';

type Host = any; // vscode host is injected by the existing extension (avoid duplicating the UI layer).
const sessions = new Map<string, NativeHarness>();

export function registerNativeHarness(context: Host, vscode: Host): void {
	const choose = async (): Promise<{ folder: Host; engine: NativeHarness } | undefined> => {
		const roots = vscode.workspace.workspaceFolders || [];
		if (!roots.length) { vscode.window.showWarningMessage('Abr\u00ed una carpeta para utilizar el Harness nativo.'); return; }
		const folder = roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(roots.map((f: Host) => ({ label: f.name, description: f.uri.fsPath, folder: f })), { placeHolder: 'Eleg\u00ed el proyecto' }))?.folder;
		if (!folder) { return; }
		const root = await fs.realpath(folder.uri.fsPath);
		// Existing native project Harness remains authoritative. Do not create competing task state.
		const original = await fs.stat(path.join(root, '.harness', 'core.mjs')).then(s => s.isFile()).catch(() => false);
		const legacy = await fs.stat(path.join(root, 'harness', 'scripts', 'ide.mjs')).then(s => s.isFile()).catch(() => false);
		if (original || legacy) { vscode.window.showInformationMessage('Este proyecto ya dispone de un Harness nativo. Utiliz\u00e1 sus controles existentes; no se crea un segundo motor.'); return; }
		const hash = createHash('sha256').update(root).digest('hex');
		const engine = sessions.get(root) || new NativeHarness(root, path.join(context.globalStorageUri.fsPath, 'native-harness', hash));
		sessions.set(root, engine); return { folder, engine };
	};
	const ensureTrust = (): boolean => vscode.workspace.isTrusted === true;
	const running = new Map<string, { engine: NativeHarness; taskId: string }>();
	const showError = (e: unknown): void => { void vscode.window.showErrorMessage(`Harness nativo: ${e instanceof Error ? e.message : String(e)}`); };
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeAgentReview', async () => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage('Workspace trust is required to prepare agents.'); return; }
			const chosen = await choose();
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
			vscode.window.showInformationMessage('Agent proposal reviewed locally. No provider was invoked.');
		} catch (error) { showError(error); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeDoctor', async () => {
		try {
			const p = await choose(); if (!p) { return; } const report = await p.engine.diagnose();
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) }));
		} catch (e) { showError(e); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeConfigure', async () => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage('Workspace trust is required for configuration.'); return; }
			const selected = await choose();
			if (!selected) { return; }
			const root = await fs.realpath(selected.folder.uri.fsPath);
			const proposal = await proposeProjectConfig(root);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(proposal, null, 2) }), { preview: true });
			if (proposal.existing) { vscode.window.showInformationMessage('Existing Harness configuration has not been changed.'); return; }
			const answer = await vscode.window.showWarningMessage('Create the reviewed .ats-harness.json? This does not run commands.', { modal: true }, 'Create configuration');
			if (answer !== 'Create configuration' || !ensureTrust()) { return; }
			if (await fs.realpath(selected.folder.uri.fsPath) !== root) { throw Error('HARNESS_ROOT_CHANGED'); }
			const file = await writeProjectConfig(root, proposal.config);
			vscode.window.showInformationMessage(`Harness configuration created: ${file}`);
		} catch (error) { showError(error); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeNewTask', async () => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage('El proyecto debe ser confiable para crear tareas ejecutables.'); return; }
			const p = await choose(); if (!p) { return; }
			// Suggestions are never authorizations. No package script runs until reviewed explicitly.
			const existing = await loadProjectConfig(p.folder.uri.fsPath);
			const suggested = existing || (await proposeProjectConfig(p.folder.uri.fsPath)).config;
			const options = [...suggested.plan.gates.map(g => ({ label: `${g.executable} ${g.args.join(' ')}`, executable: g.executable, args: g.args })), { label: 'Comando personalizado', executable: '', args: [] }];
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
			const plan: Plan = { schemaVersion: 1, gates: [{ id: 'verify', executable, args, cwd: '.' }] };
			// Present exact, immutable plan for explicit approval.
			const preview = JSON.stringify({ project: p.folder.uri.fsPath, plan }, null, 2);
			const doc = await vscode.workspace.openTextDocument({ language: 'json', content: preview }); await vscode.window.showTextDocument(doc, { preview: true });
			const accept = await vscode.window.showWarningMessage('Revis\u00e1 el plan y sus argumentos. \u00bfCrear la tarea sin ejecutarla?', { modal: true }, 'Crear tarea');
			if (accept !== 'Crear tarea' || !ensureTrust()) { return; }
			const task = await p.engine.create(title, plan);
			vscode.window.showInformationMessage(`Tarea nativa registrada: ${task.id}. Us\u00e1 \u00abEjecutar tarea nativa\u00bb cuando quieras autorizarla.`);
		} catch (e) { showError(e); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeRunTask', async () => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage('Este workspace no es confiable.'); return; }
			const p = await choose(); if (!p) { return; }
			const tasks = await p.engine.list();
			const selected = await vscode.window.showQuickPick(tasks.map(task => ({ label: task.title, description: task.id, task })), { title: 'Tareas nativas del proyecto' });
			if (!selected) { return; }
			const task = await p.engine.get(selected.task.id);
			const root = await fs.realpath(p.folder.uri.fsPath);
			const digest = approvalDigest(task.plan, root);
			const exact = task.plan.gates.map(g => `${g.executable} ${JSON.stringify(g.args)}  (${g.cwd || '.'})`).join('\n');
			if (await vscode.window.showWarningMessage(`Autorizar ejecuci\u00f3n local:\n${exact}`, { modal: true }, 'Ejecutar') !== 'Ejecutar') { return; }
			if (!ensureTrust()) { return; }
			if (running.has(p.folder.uri.toString())) { throw Error('HARNESS_ALREADY_RUNNING'); }
			running.set(p.folder.uri.toString(), { engine: p.engine, taskId: task.id });
			let result;
			try { result = await p.engine.execute(task.id, digest, ensureTrust); }
			finally { running.delete(p.folder.uri.toString()); }
			const last = result.attempts[result.attempts.length - 1];
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(last, null, 2) }));
		} catch (e) { showError(e); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeCancel', async () => {
		try {
			if (!ensureTrust()) { return; }
			const p = await choose(); if (!p) { return; }
			const current = running.get(p.folder.uri.toString());
			if (!current) { vscode.window.showInformationMessage('No hay una tarea nativa activa en este proyecto.'); return; }
			const answer = await vscode.window.showWarningMessage(`Cancelar la tarea activa ${current.taskId}?`, { modal: true }, 'Cancelar tarea');
			if (answer !== 'Cancelar tarea' || !ensureTrust()) { return; }
			current.engine.cancel();
		} catch (e) { showError(e); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeStatus', async () => {
		try {
			const p = await choose(); if (!p) { return; } const tasks = await p.engine.list();
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(tasks.map(t => ({ id: t.id, title: t.title, attempts: t.attempts.map(a => ({ id: a.id, status: a.status })) })), null, 2) }));
		} catch (e) { showError(e); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeReconcile', async () => {
		try {
			if (!ensureTrust()) { return; } const p = await choose(); if (!p) { return; }
			const diagnostic = await p.engine.diagnose();
			if (diagnostic.lock !== 'stale') { vscode.window.showInformationMessage('No hay locks obsoletos para reconciliar.'); return; }
			if (await vscode.window.showWarningMessage('Marcar intentos interrumpidos y retirar el lock obsoleto. No reejecutar operaciones.', { modal: true }, 'Reconciliar') !== 'Reconciliar') { return; }
			await p.engine.reconcile(); vscode.window.showInformationMessage('Estado reconciliado sin reintentar tareas.');
		} catch (e) { showError(e); }
	}));
	context.subscriptions.push({ dispose() { for (const engine of sessions.values()) { engine.cancel(); } sessions.clear(); } });
}
