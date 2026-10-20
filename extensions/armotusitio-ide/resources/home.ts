/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const ide = acquireVsCodeApi();
document.addEventListener('click', event => {
	const button = event.target.closest('button[data-action]');
	if (button) { ide.postMessage({ action: button.dataset.action, root: button.dataset.root, command: button.dataset.command }); }
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
	for (const job of [...state.jobs].reverse()) {
		const row = document.createElement('div');
		row.className = 'run';
		const name = document.createElement('strong');
		name.textContent = job.action;
		const detail = document.createElement('span');
		detail.className = 'muted path';
		detail.textContent = job.project;
		const status = document.createElement('span');
		status.textContent = `${labels[job.state] || job.state} \u00b7 ${job.started}`;
		row.append(name, detail, status);
		runs.append(row);
	}
});
ide.postMessage({ action: 'ready' });
