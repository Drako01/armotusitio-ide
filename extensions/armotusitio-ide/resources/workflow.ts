/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
let pendingNative;
function revealTask(id, project) { pendingNative = { id, project }; }

/** Render measured native lifecycle state using text nodes, never task-provided HTML. */
function workspaceUi(ide) {
	const form = document.getElementById('task-form') as HTMLFormElement;
	const project = document.getElementById('task-project') as HTMLSelectElement;
	const host = document.getElementById('task-host') as HTMLSelectElement;
	const text = document.getElementById('task-text') as HTMLTextAreaElement;
	const feedback = document.getElementById('task-feedback');
	const container = document.getElementById('workflow-runs');
	let latest;
	const cards = new Map();
	const element = (tag, content, className = '') => { const node = document.createElement(tag); node.textContent = content; node.className = className; return node; };
	function send(action, entry, extra = {}) { if (action === 'observeTask') { revealTask(entry.id, entry.project); } ide.postMessage({ action, root: entry.project, id: entry.id, ...extra }); }
	function button(parent, label, action, entry, extra = {}) {
		const control = element('button', label, action === 'startTask' ? '' : 'secondary');
		control.dataset.workflowAction = action; control.dataset.entry = entry.id;
		control.type = 'button'; control.addEventListener('click', () => { send(action, entry, extra); }); parent.append(control);
	}
	function selection() {
		const selected = latest?.projects.find(item => item.root === project.value);
		for (const option of Array.from(host.options)) { option.disabled = selected?.customProvider && option.value !== 'project'; }
		if (selected?.customProvider) { host.value = 'project'; }
		(document.getElementById('prepare-task') as HTMLButtonElement).disabled = !latest?.trusted || !selected?.workflow || latest.workflows.some(entry => entry.project === project.value && ['preparing', 'creating', 'running', 'stopping'].includes(entry.phase));
	}
	project.addEventListener('change', selection);
	form.addEventListener('submit', event => {
		event.preventDefault();
		if (!form.reportValidity()) { return; }
		(document.getElementById('prepare-task') as HTMLButtonElement).disabled = true;
		feedback.textContent = latest.labels.workflow.preparingHint;
		ide.postMessage({ action: 'prepareTask', root: project.value, host: host.value, text: text.value });
	});
	return state => {
		const focused = document.activeElement as HTMLElement;
		const focusKey = document.hasFocus() && focused?.dataset.workflowAction ? { action: focused.dataset.workflowAction, id: focused.dataset.entry } : undefined;
		latest = state;
		const labels = state.labels.workflow;
		const available = state.projects.filter(item => item.workflow);
		if (JSON.stringify(available.map(item => [item.root, item.name])) !== JSON.stringify(Array.from(project.options).map(option => [option.value, option.textContent]))) {
			const previous = project.value;
			project.replaceChildren(...available.map(item => { const option = document.createElement('option'); option.value = item.root; option.textContent = item.name; return option; }));
			if (Array.from(project.options).some(option => option.value === previous)) { project.value = previous; }
		}
		selection();
		feedback.textContent = project.options.length ? '' : labels.noProjects;
		const desired = [];
		if (!state.workflows.length) { desired.push(element('p', labels.empty, 'muted')); }
		for (const entry of [...state.workflows].reverse()) {
			const signature = JSON.stringify([entry, state.trusted]);
			const cached = cards.get(entry.id);
			if (cached?.signature === signature) { desired.push(cached.node); continue; }
			const article = document.createElement('article');
			article.dataset.nativeId = entry.nativeId || ''; article.dataset.project = entry.project;
			article.append(element('h3', entry.title || labels[entry.phase] || labels.blocked));
			if (entry.title) { article.append(element('p', labels[entry.phase] || labels.blocked)); }
			article.append(element('p', entry.project, 'muted path'));
			if (entry.nativeId) { article.append(element('p', entry.nativeId, 'muted')); }
			if (entry.phase === 'review') {
				article.append(element('p', labels.reviewHint));
				if (entry.mode === 'direct') { article.append(element('p', labels.direct, 'notice')); }
				for (const plan of entry.plan || []) {
					article.append(element('h4', labels[plan.domain] || plan.domain));
					const steps = document.createElement('ol');
					for (const node of plan.nodes) { steps.append(element('li', labels[node.agent] || node.agent || node.id)); }
					article.append(steps);
				}
			}
			if (entry.progress) {
				const meter = document.createElement('progress'); meter.max = 100; meter.setAttribute('aria-label', labels[entry.phase]);
				if (entry.progress.percent !== undefined) { meter.value = entry.progress.percent; article.append(element('p', entry.progress.percent + '%')); }
				article.append(meter);
				for (const node of entry.progress.nodes) { article.append(element('p', `${labels[node.agent] || node.agent || node.id} \u00b7 ${labels[node.status] || node.status}`, 'step')); }
				if (entry.progress.cause) { article.append(element('p', entry.progress.cause, 'notice')); }
			}
			if (entry.checkedAt) { article.append(element('p', `${labels.checked}: ${new Date(entry.checkedAt).toLocaleTimeString()}`, 'muted')); }
			if (entry.progressError || (entry.phase === 'running' && entry.checkedAt && Date.now() - entry.checkedAt > 15000)) { article.append(element('p', labels.stale, 'notice')); }
			const informational = (entry.warnings || []).filter(warning => !warning.blocking);
			for (const warning of (entry.warnings || []).filter(warning => warning.blocking)) { article.append(element('p', warning.message, 'notice')); }
			if (informational.length) {
				const details = document.createElement('details'); details.className = 'environment-notes';
				details.append(element('summary', `${labels.environmentNotes} (${informational.length})`));
				const categories = new Set();
				for (const warning of informational) {
					const category = warning.id?.startsWith('failed-with-running-nodes-') ? 'previousFailures' : warning.id;
					if (labels[category] && !categories.has(category)) { details.append(element('p', labels[category])); categories.add(category); }
					const technical = document.createElement('details'); technical.append(element('summary', labels.technical), element('p', `${warning.message} ${warning.hint}`, 'muted path')); details.append(technical);
				}
				article.append(details);
			}
			if (entry.phase === 'blocked') { article.append(element('p', labels[entry.error] || labels.blockedHint, 'notice')); }
			const actions = element('div', '', 'actions');
			if (entry.phase === 'questions') {
				const questions = document.createElement('form');
				const fields = [];
				for (const question of entry.questions) {
					const label = element('label', question.question);
					const input = question.options.length ? document.createElement('select') : document.createElement('input');
					input.required = true;
					input.disabled = !state.trusted;
					if (input.tagName === 'SELECT') { for (const value of question.options) { const option = document.createElement('option'); option.value = value; option.textContent = value; input.append(option); } }
					label.append(input); questions.append(label); fields.push([question.id, input]);
				}
				const submit = element('button', labels.answer); submit.type = 'submit'; submit.disabled = !state.trusted; questions.append(submit);
				questions.addEventListener('submit', event => { event.preventDefault(); if (questions.reportValidity()) { send('answerTask', entry, { answers: Object.fromEntries(fields.map(([id, input]) => [id, input.value])) }); } });
				article.append(questions);
			}
			if (state.trusted) {
				if (entry.phase === 'review') { button(actions, labels.start, 'startTask', entry); }
				if (entry.editable && ['review', 'questions', 'blocked'].includes(entry.phase)) { button(actions, labels.edit, 'editTask', entry); }
				if (entry.owned && ['preparing', 'running', 'blocked'].includes(entry.phase)) { button(actions, labels.stop, 'stopTask', entry); }
				if (entry.nativeId && ['interrupted', 'failed'].includes(entry.phase)) { button(actions, entry.phase === 'failed' ? labels.retry : labels.resume, 'resumeTask', entry); }
			}
			button(actions, labels.logs, 'workflowLogs', entry); button(actions, labels.changes, 'changes', entry);
			article.append(actions); desired.push(article); cards.set(entry.id, { signature, node: article });
			if (!cached && !entry.restored) { requestAnimationFrame(() => article.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })); }
		}
		for (const item of state.progress.filter(item => !item.error && !state.workflows.some(entry => entry.nativeId === item.id && entry.project === item.project))) {
			const row = element('div', '', 'actions'); row.append(element('p', `${item.id} \u00b7 ${state.labels.states[item.state] || item.state}`));
			button(row, labels.observed, 'observeTask', { id: item.id, project: item.project }); desired.push(row);
		}
		for (const [id] of cards) { if (!state.workflows.some(entry => entry.id === id)) { cards.delete(id); } }
		for (const child of Array.from(container.children)) { if (!desired.includes(child)) { child.remove(); } }
		desired.forEach((node, index) => { if (container.children[index] !== node) { container.insertBefore(node, container.children[index] || null); } });
		if (pendingNative) {
			const target = desired.find(node => node.dataset.nativeId === pendingNative.id && node.dataset.project === pendingNative.project);
			if (target) { pendingNative = undefined; requestAnimationFrame(() => target.scrollIntoView({ block: 'start' })); }
		}
		if (focusKey && document.hasFocus()) { const control = Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-workflow-action]')).find(button => button.dataset.entry === focusKey.id && button.dataset.workflowAction === focusKey.action); control?.focus({ preventScroll: true }); }
	};
}

module.exports = { workspaceUi, revealTask };
