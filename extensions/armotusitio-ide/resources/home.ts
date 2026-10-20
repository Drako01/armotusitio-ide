/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const ide = acquireVsCodeApi();
document.addEventListener('click', event => {
	const button = event.target.closest('button[data-action]');
	if (button && !button.disabled) { ide.postMessage({ action: button.dataset.action, root: button.dataset.root, command: button.dataset.command, id: button.dataset.id }); }
});
window.addEventListener('message', event => {
	const state = event.data;
	if (state.type !== 'state') { return; }
	document.getElementById('trust').textContent = state.trusted ? state.labels.trusted : state.labels.restricted;
	const projects = document.getElementById('projects');
	projects.replaceChildren();
	if (!state.projects.length) {
		const empty = document.createElement('p');
		empty.className = 'empty';
		empty.textContent = state.labels.emptyProjects;
		projects.append(empty);
	}
	for (const project of state.projects) {
		const article = document.createElement('article');
		const heading = document.createElement('h3');
		heading.textContent = project.name;
		const root = document.createElement('p');
		root.className = 'muted path';
		root.textContent = project.root;
		const actions = document.createElement('div');
		actions.className = 'actions';
		for (const action of project.actions) {
			const button = document.createElement('button');
			button.textContent = action;
			button.className = 'secondary';
			button.dataset.action = 'execute';
			button.dataset.root = project.root;
			button.dataset.command = action;
			button.disabled = !state.trusted;
			actions.append(button);
		}
		article.append(heading, root, actions);
		projects.append(article);
	}
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
	for (const job of [...state.jobs].reverse()) {
		const row = document.createElement('div');
		row.className = 'run';
		const name = document.createElement('strong');
		name.textContent = job.action;
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
