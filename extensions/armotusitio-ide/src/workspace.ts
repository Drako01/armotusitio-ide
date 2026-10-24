/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { HarnessWorkflow, nativeRun } = require('./workflow.ts');
const { toolArgs } = require('./catalog.ts');

/** Connect the webview to native lifecycle actions; never accept commands or filesystem paths from it. */
function createWorkspace(context, controller, projects) {
	const t = message => vscode.l10n.t(message);
	const output = vscode.window.createOutputChannel('ArmotuSitio Harness');
	const allowed = profile => profile?.id === 'redevent' && vscode.workspace.isTrusted && vscode.workspace.getConfiguration('atsHarness').get('enabled', true) &&
		(vscode.workspace.workspaceFolders || []).some(folder => folder.uri.scheme === 'file' && path.resolve(folder.uri.fsPath) === path.resolve(profile.root));
	const workflow = new HarnessWorkflow({
		storage: context.workspaceState,
		directory: path.join((context.storageUri || context.globalStorageUri).fsPath, 'harness-requests'),
		allowed, changed: () => controller.refresh(), log: text => output.append(text)
	});
	controller.getWorkflowActivity = () => workflow.all().map(entry => workflow.view(entry));
	let refreshing = false;
	let toolResult;
	const toolsBusy = new Set();
	async function refresh(manual = false) {
		if (refreshing || !vscode.workspace.isTrusted) { return; }
		refreshing = true;
		try {
			const all = await projects();
			const entries = workflow.all().filter(item => item.nativeId);
			const active = entries.filter(entry => workflow.children.has(entry.id) || entry.phase === 'running' || controller.progress.some(row => row.live && row.project === entry.project && row.id === entry.nativeId));
			const selected = manual ? entries : [...active, ...entries.filter(entry => !active.includes(entry) && ['interrupted', 'blocked'].includes(entry.phase)).slice(-4)];
			for (let offset = 0; offset < selected.length; offset += 4) {
				await Promise.allSettled(selected.slice(offset, offset + 4).map(async entry => {
					const project = all.find(item => item.profile.root === entry.project);
					if (project && allowed(project.profile)) { await workflow.refresh(entry.id, project.profile); }
				}));
			}
		} catch { /* Preserve the last measured progress; the adapter exposes stale reads separately. */ }
		finally { refreshing = false; }
	}
	controller.refreshWorkflowActivity = refresh;
	context.subscriptions.push(output, { dispose() { controller.refreshWorkflowActivity = undefined; void workflow.dispose(); } });
	return {
		refresh,
		views: () => workflow.all().map(entry => workflow.view(entry)),
		toolResult: () => toolResult,
		async receive(message) {
			if (message.action === 'workflowLogs') { output.show(true); return true; }
			if (!['prepareTask', 'answerTask', 'startTask', 'resumeTask', 'stopTask', 'observeTask', 'invokeTool', 'editTask'].includes(message.action)) { return false; }
			try {
				const project = (await projects()).find(item => item.profile.root === message.root);
				if (!project?.profile.workflow || !allowed(project.profile)) { throw new Error('HARNESS_WORKSPACE'); }
				if (toolsBusy.has(project.profile.root) && ['prepareTask', 'answerTask', 'startTask', 'resumeTask'].includes(message.action)) { throw new Error('HARNESS_BUSY'); }
				if (message.action === 'invokeTool') {
					const tool = project.profile.tools?.find(item => item.id === message.tool);
					if (!tool || toolsBusy.has(project.profile.root)) { throw new Error('HARNESS_BUSY'); }
					if ((tool.input === 'confirm' || tool.input === 'host') && workflow.busy.has(project.profile.root)) { throw new Error('HARNESS_BUSY'); }
					const args = toolArgs(tool.id, message.task, message.host);
					if (tool.input === 'confirm' || tool.input === 'host') {
						const run = t('Ejecutar');
						if (await vscode.window.showWarningMessage(t(tool.description), { modal: true }, run) !== run) { return true; }
					}
					if (!allowed(project.profile) || toolsBusy.has(project.profile.root)) { throw new Error('HARNESS_WORKSPACE'); }
					toolsBusy.add(project.profile.root);
					toolResult = { title: t(tool.title), running: true }; controller.refresh();
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
					const provider = await controller.getProvider(project.profile);
					if (provider.error || (provider.custom && message.host !== 'project')) { throw new Error('HARNESS_PROVIDER'); }
					await workflow.prepare(project.profile, message.text, message.host);
				} else if (message.action === 'answerTask') { await workflow.answer(message.id, project.profile, message.answers); }
				else if (message.action === 'editTask') { await controller.openTask(await workflow.edit(message.id, project.profile)); }
				else if (message.action === 'startTask') { await workflow.start(message.id, project.profile); }
				else if (message.action === 'observeTask') { await workflow.observe(project.profile, message.id); }
				else if (message.action === 'stopTask' || message.action === 'resumeTask') {
					const label = message.action === 'stopTask' ? t('Detener tarea') : t('Reanudar tarea');
					const explanation = message.action === 'stopTask' ? t('Se detendr\u00e1 la ejecuci\u00f3n iniciada desde este IDE. Los cambios ya realizados se conservan.') : t('El Harness volver\u00e1 a ejecutar trabajo pendiente. Revis\u00e1 los cambios existentes antes de continuar.');
					if (await vscode.window.showWarningMessage(explanation, { modal: true }, label) === label) {
						await workflow[message.action === 'stopTask' ? 'stop' : 'resume'](message.id, project.profile);
					}
				}
			} catch (error) {
				const label = error.message === 'HARNESS_BUSY' ? t('Hay una operaci\u00f3n del Harness en curso. Esper\u00e1 a que termine.') : error.message === 'HARNESS_PROVIDER' ? t('Revis\u00e1 la configuraci\u00f3n de IA. Si us\u00e1s un comando personalizado, eleg\u00ed \u00abConfiguraci\u00f3n del proyecto\u00bb.') : t('No se pudo completar la operaci\u00f3n. Revis\u00e1 el estado de la tarea y los detalles del Harness.');
				vscode.window.showErrorMessage(label);
			}
			controller.refresh();
			return true;
		}
	};
}

module.exports = { createWorkspace };
