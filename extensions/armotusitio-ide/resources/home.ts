/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const ide = acquireVsCodeApi();
const renderWorkflow = require('./workflow.ts').workspaceUi(ide);
const renderTools = require('./tools.ts').toolsUi(ide);
document.addEventListener('click', event => {
	const button = event.target.closest('button[data-action]');
	if (button && !button.disabled && button.dataset.action === 'compose') {
		const composer = document.getElementById('task-composer') as HTMLDetailsElement;
		const project = document.getElementById('task-project') as HTMLSelectElement;
		if (![...project.options].some(option => option.value === button.dataset.root)) { return; }
		project.value = button.dataset.root; project.dispatchEvent(new Event('change', { bubbles: true })); composer.open = true;
		const input = document.getElementById('task-text'); input.scrollIntoView({ block: 'center' }); input.focus(); return;
	}
	if (button && !button.disabled) { ide.postMessage({ action: button.dataset.action, root: button.dataset.root, command: button.dataset.command, id: button.dataset.id }); }
});
window.addEventListener('message', event => {
	const state = event.data;
	if (state.type === 'restoreDraft') { const field = document.getElementById('task-text') as HTMLTextAreaElement; const project = document.getElementById('task-project') as HTMLSelectElement; if (project.value === state.root && !field.value && !field.dataset.userEdited && typeof state.text === 'string') { field.value = state.text; } return; }
	if (state.type === 'reveal') { require('./workflow.ts').revealTask(state.id, state.project); ide.postMessage({ action: 'refresh' }); return; }
	if (state.type === 'draft' && typeof state.text === 'string') { const field = document.getElementById('task-text') as HTMLTextAreaElement; const composer = document.getElementById('task-composer') as HTMLDetailsElement; if (composer) { composer.open = true; } field.value = state.text; field.dataset.userEdited = 'true'; field.scrollIntoView({ block: 'center' }); field.focus(); return; }
	if (state.type !== 'state') { return; }
	renderWorkflow(state);
	renderTools(state);
	document.getElementById('trust').textContent = state.labels.restricted;
	document.getElementById('trust').hidden = state.trusted;
	const projects = document.getElementById('projects');
	const focused = document.activeElement instanceof HTMLButtonElement && projects.contains(document.activeElement) ? { ...document.activeElement.dataset } : undefined;
	const expanded = new Set([...projects.querySelectorAll<HTMLDetailsElement>('details[open]')].map(details => details.dataset.project));
	const nativeLabels = state.nativeLabels;
	const element = (tag: string, text: string, className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
	const action = (label: string, project: string, kind: string, command?: string, id?: string, primary = false) => {
		const button = document.createElement('button'); button.textContent = label; button.className = primary ? '' : 'secondary';
		button.dataset.action = kind; button.dataset.root = project;
		if (command) { button.dataset.command = command; } if (id) { button.dataset.id = id; }
		button.disabled = !state.trusted && kind !== 'open'; return button;
	};
	const options = (root: string) => {
		const details = document.createElement('details'); details.className = 'project-options'; details.dataset.project = root; details.open = expanded.has(root);
		details.append(element('summary', nativeLabels.more)); return details;
	};
	projects.replaceChildren();
	if (!state.projects.length && !state.nativeProjects?.length) {
		projects.append(element('p', state.labels.emptyProjects, 'empty'), action(state.nativeLabels.open, '', 'open', undefined, undefined, true));
	}
	for (const project of state.projects) {
		const article = document.createElement('article'); article.className = 'project-overview';
		article.append(element('h3', project.name), element('p', nativeLabels.projectEngine, 'engine-label'));
		const unsupported = project.id === 'project-native' && !project.workflow;
		article.append(element('p', unsupported ? nativeLabels.unsupported : nativeLabels.projectHint, 'muted'));
		const actions = document.createElement('div'); actions.className = 'actions';
		if (project.workflow) { actions.append(action(nativeLabels.newTask, project.root, 'compose', undefined, undefined, true)); }
		else if (unsupported) { actions.append(action(nativeLabels.compatibility, project.root, 'projectInfo', undefined, undefined, true)); }
		article.append(actions);
		const details = options(project.root);
		details.append(element('p', project.root, 'muted path'));
		const tools = document.createElement('div'); tools.className = 'actions';
		if (project.providerSupported) { tools.append(action(project.provider, project.root, 'provider')); }
		for (const command of project.workflow ? [] : project.actions) { tools.append(action(command, project.root, 'execute', command)); }
		details.append(tools); article.append(details); projects.append(article);
	}
	for (const project of state.nativeProjects || []) {
		const article = document.createElement('article'); article.className = 'project-overview';
		article.append(element('h3', project.name), element('p', nativeLabels.engine, 'engine-label'));
		const current = project.tasks[0];
		const hint = project.error ? nativeLabels.error : !state.trusted ? nativeLabels.restricted : project.configured ? nativeLabels.readyHint : nativeLabels.setupHint;
		article.append(element('p', hint, 'muted'));
		const actions = document.createElement('div'); actions.className = 'actions';
		let command = project.configured ? 'nativeNewTask' : 'nativeConfigure';
		let label = project.configured ? nativeLabels.create : nativeLabels.setup;
		let taskId;
		if (current?.reconciliationRequired) { command = 'nativeReconcile'; label = nativeLabels.recover; }
		else if (current?.status === 'running') { command = 'nativeStatus'; label = nativeLabels.running; taskId = current.id; }
		else if (current?.status === 'pending') { command = 'nativeRunTask'; label = nativeLabels.approve; taskId = current.id; }
		actions.append(action(label, project.root, 'native', command, taskId, true)); article.append(actions);
		const taskRow = task => {
			const row = document.createElement('div'); row.className = 'local-task-row';
			const text = document.createElement('div');
			text.append(element('strong', task.title), element('p', `${task.reconciliationRequired ? nativeLabels.interrupted : state.labels.states[task.status] || task.status} \u00b7 ${nativeLabels.attempts}: ${task.attempts}`, 'muted'));
			row.append(text, action(nativeLabels.inspect, project.root, 'native', 'nativeStatus', task.id));
			if (task.gates?.length) {
				const checks = options(project.root + '/' + task.id); checks.querySelector('summary').textContent = nativeLabels.gates;
				const list = document.createElement('ol');
				for (const gate of task.gates) { const item = document.createElement('li'); item.textContent = `${gate.id}: ${state.labels.states[gate.status] || gate.status}`; if (gate.dependsOn.length) { item.append(element('span', ` \u00b7 ${nativeLabels.dependencies}: ${gate.dependsOn.join(', ')}`, 'muted')); } list.append(item); }
				checks.append(list); text.append(checks);
			}
			return row;
		};
		if (current) { article.append(taskRow(current)); } else { article.append(element('p', nativeLabels.empty, 'muted')); }
		if (project.workflows?.length) {
			const workflow = project.workflows[0];
			article.append(element('p', 'Último workflow multiagente: ' + workflow.status + (workflow.verification ? ' · verificación: ' + workflow.verification : ''), 'muted'));
		}
		if (project.agentMetrics?.count) {
			article.append(element('p', 'Agentes IA: ' + project.agentMetrics.count + ' ejecuciones · éxito: ' + project.agentMetrics.successRate + '% · p95: ' + project.agentMetrics.p95DurationMs + ' ms', 'muted'));
		}
		if (project.gatePerformance?.attempts) {
			const perf = project.gatePerformance;
			article.append(element('p', 'Gates locales: ' + perf.attempts + ' intentos · éxito: ' + perf.completionRate + '% · p95: ' + perf.p95WallMs + ' ms · paralelismo observado: ' + (perf.averageParallelFactor ?? 'sin datos') + '×', 'muted'));
		}
		const details = options(project.root);
		for (const task of project.tasks.slice(1)) { details.append(taskRow(task)); }
		details.append(element('p', project.root, 'muted path'));
		const tools = document.createElement('div'); tools.className = 'actions';
		const commands = { nativeNewTask: 'create', nativeConfigure: 'configure', nativeSupport: 'diagnostics', nativeStatus: 'history', nativeRemoveConfiguration: 'remove' };
		for (const [tool, key] of Object.entries(commands)) { if (tool !== command) { tools.append(action(nativeLabels[key], project.root, 'native', tool)); } }
		tools.append(action('Ejecutar agente IA', project.root, 'native', 'nativeAgentExecute'));
		tools.append(action('Workflow multiagente', project.root, 'native', 'nativeAgentWorkflow'));
		tools.append(action('Métricas IA', project.root, 'native', 'nativeAgentMetrics'));
		tools.append(action('Historial multiagente', project.root, 'native', 'nativeWorkflowHistory'));
		tools.append(action('Reconciliar workflows', project.root, 'native', 'nativeWorkflowReconcile'));
		if (project.agentActive) { tools.append(action('Cancelar agente o workflow', project.root, 'native', 'nativeCancel')); }
		if (current?.status === 'running' && !current.reconciliationRequired) { tools.append(action(nativeLabels.cancel, project.root, 'native', 'nativeCancel')); }
		if (project.lock === 'stale' && command !== 'nativeReconcile') { tools.append(action(nativeLabels.reconcile, project.root, 'native', 'nativeReconcile')); }
		details.append(tools); article.append(details); projects.append(article);
	}
	if (focused) { [...projects.querySelectorAll<HTMLButtonElement>('button[data-action]')].find(button => button.dataset.root === focused.root && button.dataset.action === focused.action && button.dataset.command === focused.command && button.dataset.id === focused.id && !button.disabled)?.focus({ preventScroll: true }); }
	const runs = document.getElementById('runs');
	runs.replaceChildren();
	if (!state.jobs.length) {
		const empty = document.createElement('p');
		empty.className = 'empty';
		empty.textContent = state.labels.emptyJobs;
		runs.append(empty);
	}
	const labels = state.labels.states;
	const progress = document.getElementById('progress');
	progress.replaceChildren();
	if (!state.progress.length) {
		const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = state.labels.emptyProgress; progress.append(empty);
	}
	for (const task of state.progress) {
		const article = document.createElement('article');
		const heading = document.createElement('h3');
		heading.textContent = task.error ? state.labels.progressError : `${task.id} \u00b7 ${labels[task.state] || task.state}${task.percent === undefined ? '' : ' \u00b7 ' + task.percent + '%'}`;
		const root = document.createElement('p'); root.className = 'muted path'; root.textContent = task.project;
		article.append(heading, root);
		if (!task.error) {
			const meter = document.createElement('progress'); meter.max = 100; meter.setAttribute('aria-label', heading.textContent);
			if (task.percent !== undefined) { meter.value = task.percent; }
			article.append(meter);
			if (task.elapsedMs !== undefined) { const duration = document.createElement('p'); duration.className = 'muted'; duration.textContent = `${state.labels.duration}: ${Math.floor(task.elapsedMs / 1000)} s`; article.append(duration); }
		}
		progress.append(article);
	}
	const preferences = state.preferences || ide.getState?.() || {};
	for (const job of [...state.jobs].reverse().filter(job => (!preferences.filterProject || job.project === preferences.filterProject) && (!preferences.filterState || (job.state === 'passed' ? 'completed' : job.state) === preferences.filterState) && (!preferences.filterHost || job.host === preferences.filterHost) && (!preferences.since || job.startedAt >= new Date(preferences.since + 'T00:00:00').getTime()) && (!preferences.search || `${job.action} ${job.id} ${job.project}`.toLocaleLowerCase().includes(preferences.search.toLocaleLowerCase())))) {
		const row = document.createElement('div');
		row.className = 'run';
		const name = document.createElement('strong');
		name.textContent = job.action + (job.host ? ' \u00b7 ' + job.host : '');
		const detail = document.createElement('span');
		detail.className = 'muted path';
		detail.textContent = job.project;
		const status = document.createElement('span');
		const elapsed = job.state === 'running' ? Date.now() - job.startedAt : job.endedAt === undefined ? undefined : job.endedAt - job.startedAt;
		status.textContent = `${labels[job.state] || job.state} \u00b7 ${new Date(job.startedAt).toLocaleString()}${elapsed === undefined ? '' : ' \u00b7 ' + state.labels.duration + ': ' + Math.max(0, Math.floor(elapsed / 1000)) + ' s'}`;
		const outcome = document.createElement('div'); outcome.className = 'actions'; outcome.append(status);
		if (job.repeatable) {
			const repeat = document.createElement('button'); repeat.className = 'secondary'; repeat.textContent = state.labels.repeat;
			repeat.dataset.action = 'repeat'; repeat.dataset.id = job.id; repeat.disabled = !state.trusted || job.repeatBlocked;
			outcome.append(repeat);
		}
		row.append(name, detail, outcome);
		runs.append(row);
	}
});
ide.postMessage({ action: 'ready' });
