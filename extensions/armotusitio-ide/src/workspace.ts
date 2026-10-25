/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const { HarnessWorkflow, nativeRun, redact } = require('./workflow.ts');
const { readEvidence } = require('./evidence.ts');
const { toolArgs } = require('./catalog.ts');
const { capabilities, sortActivity } = require('./adapter.ts');

/** Connect the webview to native lifecycle actions; never accept commands or filesystem paths from it. */
function createWorkspace(context, controller, projects) {
	const t = message => vscode.l10n.t(message);
	const output = vscode.window.createOutputChannel('ArmotuSitio Harness');
	let generation = 0;
	const generations = new WeakMap();
	const allowed = profile => (generations.get(profile) === undefined || generations.get(profile) === generation) && ['redevent', 'armotusitio'].includes(profile?.id) && vscode.workspace.isTrusted && vscode.workspace.getConfiguration('atsHarness').get('enabled', true) &&
		(vscode.workspace.workspaceFolders || []).some(folder => folder.uri.scheme === 'file' && path.resolve(folder.uri.fsPath) === path.resolve(profile.root));
	const draftKey = 'atsHarness.drafts.v1.' + createHash('sha256').update((context.storageUri || context.globalStorageUri).fsPath).digest('hex');
	let draftWrite = Promise.resolve();
	controller.canPersistHarnessDrafts = !!context.secrets?.store;
	const terminalNotices = new Set();
	const previousPhases = new Map();
	let preferences = context.workspaceState.get?.('atsHarness.ui.v1', {}) || {};
	let preferenceSignature = JSON.stringify(preferences);
	controller.getHarnessPreferences = () => preferences;
	const workflow = new HarnessWorkflow({
		storage: context.workspaceState,
		directory: path.join((context.storageUri || context.globalStorageUri).fsPath, 'harness-requests'),
		allowed, changed: () => {
			for (const entry of workflow.all()) {
				const previous = previousPhases.get(entry.id); previousPhases.set(entry.id, entry.phase);
				const identity = `${entry.id}/${entry.progress?.attempt || 0}/${entry.phase}`;
				const mode = vscode.workspace.getConfiguration('atsHarness', vscode.Uri?.file(entry.project)).get('notifications', 'errors');
				if (entry.origin === 'ide' && previous && previous !== entry.phase && ['completed', 'failed', 'cancelled'].includes(entry.phase) && !terminalNotices.has(identity)) {
					terminalNotices.add(identity);
					if (mode === 'always' && (!preferences.focus || entry.phase === 'failed') || mode === 'errors' && entry.phase === 'failed') {
						const open = t('Ver tarea'); const label = entry.phase === 'completed' ? t('Tarea completada') : entry.phase === 'cancelled' ? t('Tarea cancelada') : t('La tarea fall\u00f3');
						const notify = entry.phase === 'failed' ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
						void Promise.resolve().then(() => notify(`${label}: ${entry.title || entry.nativeId}`, open)).then(selected => { if (selected === open) { return vscode.commands.executeCommand('atsIde.home', { task: entry.nativeId, root: entry.project }); } }).catch(() => undefined);
					}
				}
			}
			controller.refresh();
		}, log: text => output.append(text)
	});
	controller.getWorkflowActivity = () => sortActivity(workflow.all().map(entry => workflow.view(entry)));
	let nativeRoots = new Set();
	controller.readHarnessProgress = () => {
		if (!vscode.workspace.isTrusted || !vscode.workspace.getConfiguration('atsHarness').get('enabled', true)) { return []; }
		const rows = sortActivity(workflow.all().filter(entry => entry.profile && allowed(entry.profile) && entry.progress).map(entry => ({ ...workflow.view(entry) }))).map(entry => ({ project: entry.project, ...entry.progress, checkedAt: entry.checkedAt, error: entry.progressError === true }));
		return [...rows, ...controller.progress.filter(row => !nativeRoots.has(row.project) && allowed({ id: 'redevent', root: row.project }))];
	};
	let refreshing;
	let trailing = false, cursor = 0, disposed = false;
	let toolResult;
	let selectedLogs;
	const extrasBusy = new Set();
	const toolsBusy = new Set();
	controller.harnessBusy = root => workflow.busy.has(root) || toolsBusy.has(root) || workflow.all().some(entry => entry.project === root && ['preparing', 'creating', 'running', 'stopping'].includes(entry.phase));
	const contracts = new Map();
	const discoveries = new Map();
	const invalidate = () => { generation++; contracts.clear(); discoveries.clear(); };
	for (const event of [vscode.workspace.onDidChangeWorkspaceFolders, vscode.workspace.onDidGrantWorkspaceTrust]) { if (event) { context.subscriptions.push(event(invalidate)); } }
	if (vscode.workspace.onDidChangeConfiguration) { context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('atsHarness')) { invalidate(); } })); }
	async function negotiate(profile) {
		if (!allowed(profile)) { throw new Error('HARNESS_WORKSPACE'); }
		if (profile.id === 'redevent') { return { operations: (profile.tools || []).map(tool => tool.id), hosts: ['project', 'codex', 'claude'] }; }
		const old = contracts.get(profile.root);
		if (old && Date.now() - old.at < 60000) { if (old.error) { throw new Error(old.error); } return old.value; }
		try {
			const result = await nativeRun(profile, ['capabilities'], { timeout: 15000, authorize: () => allowed(profile) });
			if (result.code !== 0) { throw new Error('HARNESS_CONTRACT'); }
			const value = capabilities(result.value);
			contracts.set(profile.root, { at: Date.now(), value }); return value;
		} catch (error) { contracts.set(profile.root, { at: Date.now(), error: error.message }); throw error; }
	}
	controller.clearWorkflowHistory = () => { for (const entry of workflow.all()) { if (['completed', 'failed', 'cancelled'].includes(entry.phase) && !workflow.children.has(entry.id)) { workflow.entries.delete(entry.id); } } workflow.changed(); };
	controller.getHarnessConnection = root => contracts.get(root);
	async function sample(manual) {
		if (disposed || !vscode.workspace.isTrusted) { return; }
		const pollGeneration = generation;
		const all = await projects();
		if (pollGeneration !== generation) { return; }
		nativeRoots = new Set(all.filter(item => item.profile.workflow).map(item => item.profile.root));
		for (const { profile } of all) {
			generations.set(profile, pollGeneration);
			if (!profile.workflow || !allowed(profile)) { continue; }
			try {
				if (manual) { contracts.delete(profile.root); }
				await negotiate(profile);
				const result = await nativeRun(profile, ['progress', '--json'], { timeout: 15000, authorize: () => allowed(profile) });
				if (disposed || !allowed(profile)) { continue; }
				if (result.value?.id) { await workflow.observe(profile, result.value.id, result.value); }
				else if (!/E_NO_ACTIVE_TASK|No active task; pass a <task-id>/.test(result.error || '')) { throw new Error('HARNESS_PROGRESS'); }
				if (manual || Date.now() - (discoveries.get(profile.root) || 0) > 30000) {
					discoveries.set(profile.root, Date.now());
					const list = await nativeRun(profile, ['list'], { timeout: 15000, authorize: () => allowed(profile) });
					if (Array.isArray(list.value) && allowed(profile) && !disposed) {
						for (const row of list.value.filter(row => row?.status === 'active' && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(row.id)).slice(-50)) {
							const known = workflow.all().find(entry => entry.project === profile.root && entry.nativeId === row.id);
							if (!known) { await workflow.observe(profile, row.id); } else if (['completed', 'failed', 'cancelled'].includes(known.phase)) { await workflow.refresh(known.id, profile); }
						}
					}
				}
				const previous = contracts.get(profile.root) || {};
				contracts.set(profile.root, { ...previous, lastSuccess: Date.now(), lastAttempt: Date.now(), observationError: undefined });
			} catch (error) {
				contracts.set(profile.root, { ...contracts.get(profile.root), observationError: error.message, lastAttempt: Date.now() });
			}
		}
		if (pollGeneration !== generation) { return; }
		const entries = workflow.all().filter(item => item.nativeId);
		const active = entries.filter(entry => workflow.children.has(entry.id) || ['running', 'stopping', 'pending'].includes(entry.phase));
		const others = entries.filter(entry => !active.includes(entry) && (manual || !entry.checkedAt || !['completed', 'failed', 'cancelled'].includes(entry.phase)));
		const batch = manual ? others : Array.from({ length: Math.min(4, others.length) }, (_, index) => others[(cursor + index) % others.length]);
		cursor = others.length ? (cursor + 4) % others.length : 0;
		for (const entry of [...active, ...batch]) {
			const project = all.find(item => item.profile.root === entry.project);
			if (project) { generations.set(project.profile, pollGeneration); }
			if (project && allowed(project.profile) && (!entry.checkedAt || Date.now() - entry.checkedAt > 1000 || manual)) { await workflow.refresh(entry.id, project.profile); }
		}
	}
	async function refresh(manual = false) {
		if (refreshing) { if (manual) { trailing = true; } return refreshing; }
		refreshing = (async () => { do { const full = manual || trailing; trailing = false; await sample(full); manual = false; } while (trailing && !disposed); })();
		try { await refreshing; } finally { refreshing = undefined; }
	}
	controller.refreshWorkflowActivity = refresh;
	context.subscriptions.push(output, { dispose() { disposed = true; controller.refreshWorkflowActivity = undefined; void workflow.dispose(); } });
	return {
		refresh,
		views: () => sortActivity(workflow.all().map(entry => ({ ...workflow.view(entry), logs: selectedLogs === entry.id ? entry.logs || '' : undefined }))),
		toolResult: () => toolResult,
		async receive(message) {
			if (message.action === 'preferences') {
				const value = message.value || {};
				preferences = { filterProject: typeof value.filterProject === 'string' ? value.filterProject.slice(0, 4096) : '', filterState: typeof value.filterState === 'string' && /^[a-z-]{1,30}$/.test(value.filterState) ? value.filterState : '', filterHost: ['project', 'claude', 'codex', 'custom', 'plan'].includes(value.filterHost) ? value.filterHost : '', since: typeof value.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.since) ? value.since : '', compact: value.compact === true, focus: value.focus === true, pin: typeof value.pin === 'string' ? value.pin.slice(0, 100) : '', project: typeof value.project === 'string' ? value.project.slice(0, 4096) : '', search: typeof value.search === 'string' ? redact(value.search).slice(0, 200) : '', expanded: Array.isArray(value.expanded) ? value.expanded.filter(key => typeof key === 'string' && key.length < 200).slice(0, 100) : [] };
				const signature = JSON.stringify(preferences); if (signature !== preferenceSignature) { preferenceSignature = signature; await context.workspaceState.update('atsHarness.ui.v1', preferences); } return true;
			}
			if (message.action === 'workflowLogs') {
				const entry = workflow.all().find(entry => entry.id === message.id && entry.project === message.root);
				if (entry) { selectedLogs = selectedLogs === entry.id ? undefined : entry.id; controller.refresh(); }
				return true;
			}
			if (!['prepareTask', 'answerTask', 'startTask', 'resumeTask', 'stopTask', 'observeTask', 'invokeTool', 'editTask', 'exportTask', 'reuseTask', 'bindCard', 'inspectCard', 'openEvidence', 'reconcileCreation', 'saveTemplate', 'useTemplate', 'saveDraft', 'loadDraft', 'diagnoseProject'].includes(message.action)) { return false; }
			try {
				const requestGeneration = generation;
				const project = (await projects()).find(item => item.profile.root === message.root);
				if (requestGeneration !== generation) { throw new Error('HARNESS_WORKSPACE'); }
				if (project?.profile) { generations.set(project.profile, generation); }
				if (!project?.profile.workflow || !allowed(project.profile)) { throw new Error('HARNESS_WORKSPACE'); }
				if (message.action === 'diagnoseProject') {
					const operations = project.profile.id === 'armotusitio' ? ['version', 'capabilities'] : ['progress'];
					const readings = await Promise.allSettled(operations.map(operation => nativeRun(project.profile, [operation, ...(operation === 'progress' ? ['--json'] : [])], { timeout: 15000, authorize: () => allowed(project.profile) })));
					if (!allowed(project.profile)) { return true; }
					const report = { project: project.profile.id, extensionHost: { platform: process.platform, node: process.version }, connection: contracts.get(project.profile.root), readings: readings.map((reading, index) => reading.status === 'fulfilled' ? { operation: operations[index], code: reading.value.code, detail: reading.value.error || reading.value.output } : { operation: operations[index], error: String(reading.reason?.message || 'HARNESS_PROGRESS').slice(0, 300) }) };
					await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: redact(JSON.stringify(report, null, 2)) }));
					return true;
				}
				if (['saveDraft', 'loadDraft'].includes(message.action)) {
					if (!context.secrets?.get || !context.secrets?.store) { return true; }
					draftWrite = draftWrite.catch(() => undefined).then(async () => {
						if (!allowed(project.profile)) { return; }
						let values; try { values = JSON.parse(await context.secrets.get(draftKey) || '{}'); } catch { values = {}; }
						if (!values || typeof values !== 'object' || Array.isArray(values)) { values = {}; }
						if (message.action === 'loadDraft') { if (typeof values[project.profile.root] === 'string') { controller.restoreHarnessDraft?.(project.profile.root, values[project.profile.root].slice(0, 32000)); } return; }
						if (typeof message.text !== 'string' || message.text.length > 32000 || message.text.includes('\0')) { throw new Error('HARNESS_REQUEST'); }
						if (values[project.profile.root] === message.text) { return; }
						if (message.text) { values[project.profile.root] = message.text; } else { delete values[project.profile.root]; }
						await context.secrets.store(draftKey, JSON.stringify(Object.fromEntries(Object.entries(values).slice(-20))));
					});
					await draftWrite; return true;
				}
				const negotiated = await negotiate(project.profile);
				if (['saveTemplate', 'useTemplate'].includes(message.action)) {
					const directory = path.join((context.storageUri || context.globalStorageUri).fsPath, 'harness-templates');
					const rows = (context.workspaceState.get('atsHarness.templates.v1', []) || []).filter(row => /^[a-f0-9-]{36}$/i.test(row.id) && typeof row.name === 'string').slice(-20);
					if (message.action === 'saveTemplate') {
						if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 32000 || message.text.includes('\0') || redact(message.text) !== message.text) { throw new Error('HARNESS_REQUEST'); }
						const name = await vscode.window.showInputBox({ title: t('Guardar plantilla local'), prompt: t('Nombre de la plantilla. El texto se guarda en el almacenamiento privado de este workspace.'), validateInput: value => value.trim().length > 0 && value.length <= 80 && redact(value) === value ? undefined : t('Ingres\u00e1 un nombre breve sin credenciales.') });
						if (name && allowed(project.profile)) { const id = randomUUID(); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, id + '.txt'), message.text, { flag: 'wx', mode: 0o600 }); await context.workspaceState.update('atsHarness.templates.v1', [...rows, { id, name }]); }
					} else {
						const selected = await vscode.window.showQuickPick(rows.map(row => ({ label: row.name, id: row.id })), { title: t('Usar una plantilla local') });
						if (selected && rows.some(row => row.id === selected.id) && allowed(project.profile)) { await controller.openTask(await fs.readFile(path.join(directory, selected.id + '.txt'), 'utf8')); }
					}
					return true;
				}
				if (['exportTask', 'reuseTask', 'bindCard', 'inspectCard', 'openEvidence', 'reconcileCreation'].includes(message.action)) {
					const entry = workflow.all().find(entry => entry.id === message.id && entry.project === project.profile.root);
					if (!entry || extrasBusy.has(entry.id)) { throw new Error('HARNESS_BUSY'); }
					extrasBusy.add(entry.id);
					try {
						if (message.action === 'reconcileCreation') {
							if (!entry.creationUncertain) { throw new Error('HARNESS_REQUEST'); }
							const result = await nativeRun(project.profile, ['list'], { timeout: 15000, authorize: () => allowed(project.profile) });
							if (result.code !== 0 || !Array.isArray(result.value)) { throw new Error('HARNESS_PROGRESS'); }
							const rows = result.value.filter(row => /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(row?.id));
							const selected = await vscode.window.showQuickPick(rows.map(row => ({ label: row.id, description: String(row.title || row.status || ''), id: row.id })), { title: t('Seleccion\u00e1 la tarea creada para continuar observ\u00e1ndola') });
							if (!allowed(project.profile)) { return true; }
							if (selected && rows.some(row => row.id === selected.id)) { await workflow.observe(project.profile, selected.id); }
							else { const clear = t('Confirmo que no se cre\u00f3'); if (await vscode.window.showWarningMessage(t('Revis\u00e1 el listado y la evidencia nativa antes de descartar esta alerta. No se borrar\u00e1 ninguna tarea del Harness.'), { modal: true }, clear) !== clear || !allowed(project.profile)) { return true; } }
							await workflow.cleanInput(entry); workflow.entries.delete(entry.id); workflow.changed();
						} else if (message.action === 'exportTask') {
							const choices = [t('Resultado y verificaciones'), t('Intentos'), t('L\u00ednea de tiempo')];
							const selected = await vscode.window.showQuickPick(choices, { canPickMany: true, title: t('Eleg\u00ed qu\u00e9 incluir en el resumen local') });
							if (!selected?.length || !allowed(project.profile)) { return true; }
							const value = { task: entry.nativeId, title: entry.title, phase: entry.phase, host: entry.host, issueKey: entry.issueKey, ...(selected.includes(choices[0]) ? { progress: entry.progress ? Object.fromEntries(Object.entries(entry.progress).filter(([key]) => key !== 'attempts')) : undefined } : {}), ...(selected.includes(choices[1]) ? { attempts: entry.progress?.attempts } : {}), ...(selected.includes(choices[2]) ? { timeline: entry.timeline } : {}) };
							await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: redact(JSON.stringify(value, null, 2)) }));
						} else if (message.action === 'reuseTask') {
							if (project.profile.id === 'armotusitio' && negotiated.operations.includes('source')) {
								const source = await nativeRun(project.profile, ['source', entry.nativeId, '0', '12000'], { timeout: 15000, authorize: () => allowed(project.profile) });
								if (source.code !== 0 || typeof source.value?.text !== 'string' || source.value.complete !== true) { throw new Error('HARNESS_SOURCE'); }
								await controller.openTask(source.value.text);
							} else { await controller.openTask(entry.title || entry.nativeId); }
						} else if (message.action === 'openEvidence') {
							const reference = typeof message.node === 'string' ? entry.evidence?.[message.node] : undefined;
							const content = redact(await readEvidence(project.profile.root, reference));
							if (!allowed(project.profile)) { throw new Error('HARNESS_WORKSPACE'); }
							await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'log', content }));
						} else {
							const key = entry.issueKey || await vscode.window.showInputBox({ title: t('Vincular con Work Management'), prompt: t('Clave de la tarjeta, por ejemplo RED-001-220'), validateInput: value => /^[a-z][a-z0-9-]*-\d+$/i.test(value) ? undefined : t('Ingres\u00e1 una clave de tarjeta v\u00e1lida.') });
							if (key && /^[a-z][a-z0-9-]*-\d+$/i.test(key) && allowed(project.profile)) { if (await vscode.commands.executeCommand('atsIde.issueContext', key.toUpperCase()) === true && allowed(project.profile)) { entry.issueKey = key.toUpperCase(); workflow.changed(); } }
						}
					} finally { extrasBusy.delete(entry.id); controller.refresh(); }
					return true;
				}
				if (toolsBusy.has(project.profile.root) && ['prepareTask', 'answerTask', 'startTask', 'resumeTask'].includes(message.action)) { throw new Error('HARNESS_BUSY'); }
				if (message.action === 'invokeTool') {
					const tool = project.profile.tools?.find(item => item.id === message.tool);
					if (!tool || project.profile.id === 'armotusitio' && !negotiated.operations.includes(tool.id) || toolsBusy.has(project.profile.root)) { throw new Error('HARNESS_BUSY'); }
					if ((tool.input === 'confirm' || tool.input === 'host') && workflow.busy.has(project.profile.root)) { throw new Error('HARNESS_BUSY'); }
					const args = toolArgs(tool.id, message.task, message.host);
					if (tool.input === 'confirm' || tool.input === 'host') {
						const run = t('Ejecutar');
						if (await vscode.window.showWarningMessage(t(tool.description), { modal: true }, run) !== run) { return true; }
					}
					if (!allowed(project.profile) || toolsBusy.has(project.profile.root) || ['confirm', 'host'].includes(tool.input) && workflow.busy.has(project.profile.root)) { throw new Error('HARNESS_WORKSPACE'); }
					toolsBusy.add(project.profile.root);
					toolResult = { title: t(tool.title), project: project.profile.root, task: message.task, running: true }; controller.refresh();
					try {
						const result = await nativeRun(project.profile, args, { timeout: 1800000, authorize: () => allowed(project.profile), log: text => output.append(text) });
						toolResult = { title: t(tool.title), project: project.profile.root, running: false, code: result.code, text: result.output || result.error || '' };
						if (tool.id === 'list' && Array.isArray(result.value)) {
							const rows = result.value.filter(item => typeof item?.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(item.id));
							toolResult.total = rows.length;
							toolResult.rows = rows.slice(-200).reverse().map(item => ({ id: item.id, state: String(item.status || '').slice(0, 40), domain: String(item.domain || '').slice(0, 80) }));
						}
					} catch { toolResult = { title: t(tool.title), running: false, code: 1, text: t('No se pudo completar la consulta. Revis\u00e1 el entorno y los detalles del Harness.') }; }
					finally { toolsBusy.delete(project.profile.root); controller.refresh(); }
					return true;
				}
				if (message.action === 'prepareTask') {
					if ([...(controller.jobs?.values() || [])].some(job => job.project === project.profile.root && job.state === 'running' && ['verify', 'test', 'run', 'dispatch', 'abort'].includes(job.action))) { throw new Error('HARNESS_BUSY'); }
					const provider = project.profile.id === 'armotusitio' ? {} : await controller.getProvider(project.profile);
					if (toolsBusy.has(project.profile.root)) { throw new Error('HARNESS_BUSY'); }
					if (provider.error || (provider.custom && message.host !== 'project')) { throw new Error('HARNESS_PROVIDER'); }
					await workflow.prepare(project.profile, message.text, project.profile.id === 'armotusitio' ? 'project' : message.host);
				} else if (message.action === 'answerTask') { await workflow.answer(message.id, project.profile, message.answers); }
				else if (message.action === 'editTask') { await controller.openTask(await workflow.edit(message.id, project.profile)); }
				else if (message.action === 'startTask') { await workflow.start(message.id, project.profile); }
				else if (message.action === 'observeTask') { await workflow.observe(project.profile, message.id); }
				else if (message.action === 'stopTask' || message.action === 'resumeTask') {
					const entry = workflow.all().find(entry => entry.id === message.id && entry.project === project.profile.root);
					if (!entry) { throw new Error('HARNESS_WORKSPACE'); }
					const validateAttempt = async () => {
						if (!entry.nativeId) { return; }
						await workflow.refresh(entry.id, project.profile);
						if (entry.progressError || Number.isSafeInteger(message.attempt) && message.attempt !== entry.progress?.attempt || message.attempt === undefined && project.profile.id === 'armotusitio' && entry.progress?.attempt && !workflow.children.has(entry.id)) { throw new Error('HARNESS_ATTEMPT_CHANGED'); }
					};
					await validateAttempt();
					const label = message.action === 'stopTask' ? t('Detener tarea') : t('Reanudar tarea');
					const explanation = message.action === 'stopTask' ? t('Se solicitar\u00e1 detener esta tarea del Harness. Los cambios ya realizados se conservan.') : t('El Harness volver\u00e1 a ejecutar trabajo pendiente. Revis\u00e1 los cambios existentes antes de continuar.');
					if (await vscode.window.showWarningMessage(`${explanation}\n\n${entry.title || entry.nativeId || entry.id}\n${entry.project}${entry.progress?.attempt ? '\n' + t('Intento') + ' ' + entry.progress.attempt : ''}`, { modal: true }, label) === label) {
						await validateAttempt();
						await workflow[message.action === 'stopTask' ? 'stop' : 'resume'](message.id, project.profile);
					}
				}
			} catch (error) {
				output.append(`[${message.action}] ${redact(error.message).slice(0, 300)}\n`);
				if (typeof message.root === 'string') { contracts.set(message.root, { ...contracts.get(message.root), lastOperationError: redact(error.message).slice(0, 300) }); }
				const known = { HARNESS_ATTEMPT_CHANGED: 'El intento cambi\u00f3 o no pudo verificarse. Actualiz\u00e1 la tarea antes de repetir la acci\u00f3n.', HARNESS_RECONCILE: 'Hay una creaci\u00f3n sin confirmar. Revis\u00e1 el listado nativo antes de preparar otra tarea.', HARNESS_CONTRACT: 'No se pudo validar el contrato del Harness. Abr\u00ed Diagn\u00f3stico para revisar el entorno.', HARNESS_CAPABILITY: 'El contrato del Harness no ofrece las operaciones requeridas. Abr\u00ed Diagn\u00f3stico para revisar su versi\u00f3n.' };
				const label = known[error.message] ? t(known[error.message]) : error.message === 'HARNESS_BUSY' ? t('Hay una operaci\u00f3n del Harness en curso. Esper\u00e1 a que termine.') : error.message === 'HARNESS_PROVIDER' ? t('Revis\u00e1 la configuraci\u00f3n de IA. Si us\u00e1s un comando personalizado, eleg\u00ed \u00abConfiguraci\u00f3n del proyecto\u00bb.') : t('No se pudo completar la operaci\u00f3n. Revis\u00e1 el estado de la tarea y los detalles del Harness.');
				vscode.window.showErrorMessage(label);
			}
			controller.refresh();
			return true;
		}
	};
}

module.exports = { createWorkspace };
