/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const { sortActivity } = require('../src/presentation.ts');
const { reconcile } = require('./reconcile.ts');
let pendingNative;
function revealTask(id, project) { pendingNative = { id, project }; }

/** One activity surface: changes patch existing controls, while preferences belong to this workspace. */
function workspaceUi(ide) {
	const form = document.getElementById('task-form') as HTMLFormElement;
	const project = document.getElementById('task-project') as HTMLSelectElement;
	const host = document.getElementById('task-host') as HTMLSelectElement;
	const text = document.getElementById('task-text') as HTMLTextAreaElement;
	const feedback = document.getElementById('task-feedback');
	const container = document.getElementById('workflow-runs');
	let latest, labels, lastAnnouncement = '';
	const saved = ide.getState?.() || {};
	const preferences = { compact: saved.compact === true, focus: saved.focus === true, attention: false, filterProject: '', filterState: '', filterHost: '', since: '', pin: typeof saved.pin === 'string' ? saved.pin : '', search: typeof saved.search === 'string' ? saved.search : '', expanded: Array.isArray(saved.expanded) ? saved.expanded : [], project: typeof saved.project === 'string' ? saved.project : '' };
	const drafts = new Map();
	const requestedDrafts = new Set();
	let draftTimer;
	const cards = new Map();
	const logFilters = new Map();
	const following = new Set();
	const logSeen = new Map();
	let initialized = false, lastSaved = '';

	const element = (tag, content = '', className = '', key = '') => { const node = document.createElement(tag); node.textContent = content; node.className = className; if (key) { node.dataset.key = key; } return node; };
	const templateActions = element('div', '', 'actions'); form.append(templateActions);
	const toolbar = element('div', '', 'activity-toolbar');
	container.before(toolbar);
	const announcement = element('p', '', 'muted'); announcement.setAttribute('role', 'status'); container.before(announcement);
	// Repeated percentages are intentionally kept out of live announcements.
	container.removeAttribute('aria-live');
	function save() {
		const value = { ...preferences, project: project.value };
		const signature = JSON.stringify(value); if (signature === lastSaved) { return; } lastSaved = signature;
		ide.setState?.(value); ide.postMessage({ action: 'preferences', value });
	}
	function send(action, entry, extra = {}) { ide.postMessage({ action, root: entry.project, id: entry.id, attempt: entry.progress?.attempt, ...extra }); }
	function button(parent, label, action, entry, extra = {}) {
		const control = element('button', label, action === 'startTask' ? 'primary' : action === 'stopTask' ? 'destructive' : 'secondary', action);
		control.dataset.workflowAction = action; control.dataset.entry = entry.id; control.type = 'button';
		control.disabled = !latest.trusted && !['workflowLogs', 'pin', 'exportTask', 'reuseTask', 'inspectCard'].includes(action);
		control.onclick = event => {
			if ((event.currentTarget as HTMLButtonElement).disabled) { return; }
			if (action === 'pin') { preferences.pin = preferences.pin === entry.id ? '' : entry.id; save(); render(latest); return; }
			if (['startTask', 'stopTask', 'resumeTask', 'editTask'].includes(action)) { (event.currentTarget as HTMLButtonElement).disabled = true; }
			send(action, entry, extra);
		};
		parent.append(control);
	}
	function selection() {
		const selected = latest?.projects.find(item => item.root === project.value);
		const hostTitle = document.getElementById('task-host-title'); if (hostTitle && labels) { hostTitle.textContent = selected?.id === 'armotusitio' ? labels.executionEngine : labels.agentEngine; host.options[0].textContent = selected?.id === 'armotusitio' ? labels.projectEngine : labels.projectConfig; }
		for (const option of Array.from(host.options)) { option.disabled = (selected?.customProvider || selected?.id === 'armotusitio') && option.value !== 'project'; }
		if (selected?.customProvider || selected?.id === 'armotusitio') { host.value = 'project'; }
		const submit = document.getElementById('prepare-task') as HTMLButtonElement;
		submit.disabled = !latest?.trusted || !selected?.workflow || !!selected?.connection?.error || selected?.id === 'armotusitio' && !selected?.connection?.value || latest.workflows.some(entry => entry.project === project.value && (['preparing', 'creating', 'running', 'stopping'].includes(entry.phase) || entry.creationUncertain));
		submit.title = !latest?.trusted ? latest?.labels.restricted || '' : selected?.connection?.error ? labels.connectionError : '';
		preferences.project = project.value;
		if (project.value && latest?.trusted && !requestedDrafts.has(project.value)) { requestedDrafts.add(project.value); ide.postMessage({ action: 'loadDraft', root: project.value }); }
		save();
	}
	project.addEventListener('change', () => { drafts.set(preferences.project, text.value); preferences.project = project.value; text.value = drafts.get(project.value) || ''; text.dataset.userEdited = drafts.has(project.value) ? 'true' : ''; selection(); });
	text.addEventListener('input', () => { drafts.set(project.value, text.value); text.dataset.userEdited = 'true'; clearTimeout(draftTimer); const root = project.value, value = text.value; draftTimer = setTimeout(() => ide.postMessage({ action: 'saveDraft', root, text: value }), 500); });
	form.addEventListener('submit', event => {
		event.preventDefault(); if (!form.reportValidity() || (document.getElementById('prepare-task') as HTMLButtonElement).disabled) { return; }
		(document.getElementById('prepare-task') as HTMLButtonElement).disabled = true;
		feedback.textContent = labels.preparingHint;
		ide.postMessage({ action: 'prepareTask', root: project.value, host: host.value, text: text.value });
	});
	function details(parent, title, key) { const node = element('details', '', '', key); const preferenceKey = (parent.dataset.key || 'toolbar') + '/' + key; node.open = preferences.expanded.includes(preferenceKey); node.addEventListener('toggle', () => { if (!node.isConnected) { return; } preferences.expanded = node.open ? [...new Set([...preferences.expanded, preferenceKey])] : preferences.expanded.filter(item => item !== preferenceKey); save(); }); node.append(element('summary', title)); parent.append(node); return node; }
	function render(state) {
		latest = state; labels = state.labels.workflow;
		const composer = document.getElementById('task-composer') as HTMLDetailsElement; if (composer && !composer.dataset.initialized) { composer.open = !state.workflows.length; composer.dataset.initialized = 'true'; }
		if (!initialized) { initialized = true; const stored = state.preferences || saved; for (const key of ['compact', 'focus', 'pin', 'search', 'expanded', 'project', 'filterProject', 'filterState', 'filterHost', 'since']) { if (stored[key] !== undefined) { preferences[key] = stored[key]; } } }
		if (!templateActions.children.length) { for (const action of ['saveTemplate', 'useTemplate']) { const control = element('button', labels[action], 'quiet') as HTMLButtonElement; control.type = 'button'; control.onclick = () => ide.postMessage({ action, root: project.value, text: action === 'saveTemplate' ? text.value : undefined }); templateActions.append(control); } }
		const available = state.projects.filter(item => item.workflow);
		if (JSON.stringify(available.map(item => [item.root, item.name])) !== JSON.stringify(Array.from(project.options).map(option => [option.value, option.textContent]))) {
			const previous = preferences.project || project.value;
			project.replaceChildren(...available.map(item => { const option = document.createElement('option'); option.value = item.root; option.textContent = item.name; return option; }));
			if (Array.from(project.options).some(option => option.value === previous)) { project.value = previous; }
		}
		selection();
		const connection = state.projects.find(item => item.root === project.value)?.connection;
		feedback.textContent = !project.options.length ? labels.noProjects : connection?.error || connection?.observationError ? labels.connectionError : connection?.lastSuccess ? `${labels.checked}: ${new Date(connection.lastSuccess).toLocaleTimeString()} \u00b7 ${state.draftPersistence ? labels.draftPrivate : labels.draftSession}` : '';
		feedback.classList.toggle('notice', !!(connection?.error || connection?.observationError));
		feedback.title = connection?.lastOperationError || '';
		document.body.classList.toggle('focus-mode', preferences.focus);
		const controls = element('div', '', 'activity-toolbar');
		for (const [key, label] of [['focus', labels.focus], ['compact', labels.compact], ['attention', labels.attention]]) {
			const toggle = element('button', label, 'quiet', key); toggle.type = 'button'; toggle.setAttribute('aria-pressed', String(preferences[key]));
			toggle.onclick = () => { preferences[key] = !preferences[key]; save(); render(latest); }; controls.append(toggle);
		}
		const diagnose = element('button', labels.diagnose, 'quiet', 'diagnose') as HTMLButtonElement; diagnose.type = 'button'; diagnose.disabled = !state.trusted || !project.value; diagnose.onclick = () => ide.postMessage({ action: 'diagnoseProject', root: project.value }); controls.append(diagnose);
		const search = element('input', '', '', 'search') as HTMLInputElement; search.type = 'search'; search.placeholder = labels.search; search.setAttribute('aria-label', labels.search);
		search.value = preferences.search; search.oninput = event => { preferences.search = (event.target as HTMLInputElement).value; save(); render(latest); }; controls.append(search);
		const filters = details(controls, labels.filters, 'filters');
		const filterRow = element('div', '', 'activity-toolbar'); filters.append(filterRow);
		for (const [key, label, options] of [
			['filterProject', labels.projectFilter, state.projects.map(item => [item.root, item.name])],
			['filterState', labels.stateFilter, [...new Set([...state.workflows.map(entry => entry.phase), ...state.jobs.map(job => job.state === 'passed' ? 'completed' : job.state)])].map(phase => [phase, labels[phase] || phase])],
			['filterHost', labels.hostFilter, [...new Set([...state.workflows.map(entry => entry.host), ...state.jobs.map(job => job.host)])].filter(Boolean).map(host => [host, host])]
		]) {
			const select = element('select', '', '', key) as HTMLSelectElement; select.setAttribute('aria-label', label);
			for (const [value, text] of [['', label], ...options]) { const option = element('option', text) as HTMLOptionElement; option.value = value; select.append(option); }
			select.value = preferences[key]; select.onchange = event => { preferences[key] = (event.target as HTMLSelectElement).value; save(); render(latest); }; filterRow.append(select);
		}
		const since = element('input', '', '', 'since') as HTMLInputElement; since.type = 'date'; since.setAttribute('aria-label', labels.since); since.title = labels.since; since.value = preferences.since; since.onchange = event => { preferences.since = (event.target as HTMLInputElement).value; save(); render(latest); }; filterRow.append(since);
		// The search control remains stable, including its selection and event handler.
		reconcile(toolbar, controls); const actualSearch = toolbar.querySelector('input'); actualSearch.oninput = search.oninput;
		const attention = state.workflows.filter(entry => ['questions', 'review', 'blocked', 'interrupted', 'unknown'].includes(entry.phase));
		const summary = `${state.workflows.filter(entry => entry.progress?.live && !entry.progressError && (!entry.checkedAt || Date.now() - entry.checkedAt < 15000)).length} ${labels.activeCount} \u00b7 ${attention.length} ${labels.attentionCount}`;
		if (summary !== lastAnnouncement) { announcement.textContent = summary; lastAnnouncement = summary; }
		const ordered = sortActivity(state.workflows);
		if (pendingNative) { preferences.search = ''; preferences.attention = false; }
		const visible = ordered.filter(entry => (!preferences.attention || attention.includes(entry)) && (!preferences.filterProject || entry.project === preferences.filterProject) && (!preferences.filterState || entry.phase === preferences.filterState) && (!preferences.filterHost || entry.host === preferences.filterHost) && (!preferences.since || entry.startedAt >= new Date(preferences.since + 'T00:00:00').getTime()) && (!preferences.search || `${entry.title || ''} ${entry.nativeId || ''} ${entry.project} ${entry.phase}`.toLocaleLowerCase().includes(preferences.search.toLocaleLowerCase())));
		const pinned = ordered.find(entry => entry.id === preferences.pin);
		if (pinned && !visible.includes(pinned)) { visible.push(pinned); }
		const desired = [];
		if (!visible.length) { desired.push(element('p', labels.empty, 'muted')); }
		for (const entry of visible) {
			const article = element('article', '', `workflow-card ${preferences.compact ? 'compact' : ''}`, entry.id);
			article.dataset.entryId = entry.id; article.dataset.nativeId = entry.nativeId || ''; article.dataset.project = entry.project;
			const heading = element('div', '', 'section-heading', 'heading');
			heading.append(element('h3', entry.title || labels[entry.phase] || labels.blocked));
			const badge = element('span', labels[entry.phase] || labels.unknown, `status-badge ${entry.phase}`); heading.append(badge); article.append(heading);
			article.append(element('p', entry.project, 'muted path', 'project'));
			if (preferences.pin === entry.id) { article.append(element('p', labels.pinned, 'muted', 'pinned')); }
			if (entry.error === 'HARNESS_PLAN_CHANGED') { article.append(element('p', labels.planChanged, 'notice', 'plan-change')); }
			if (entry.phase === 'review') {
				article.append(element('p', entry.host === 'project' && state.projects.find(item => item.root === entry.project)?.id === 'armotusitio' ? labels.projectGates : labels.reviewHint, '', 'review-hint'));
				for (const plan of entry.plan || []) {
					const section = element('section', '', 'plan-domain', `plan/${plan.domain}`); section.append(element('h4', labels[plan.domain] || plan.domain));
					const steps = element('ol'); for (const node of plan.nodes) { steps.append(element('li', `${labels[node.agent] || node.agent || node.id}${node.id && node.agent !== node.id ? ' \u00b7 ' + node.id : ''}`)); } section.append(steps); article.append(section);
				}
				if (entry.previousPlan) {
					const comparison = details(article, labels.planComparison, 'plan-comparison');
					const steps = plans => new Map((plans || []).flatMap(plan => (plan.nodes || []).map(node => [`${plan.domain}/${node.id}`, { signature: JSON.stringify(node), title: `${labels[plan.domain] || plan.domain} \u00b7 ${labels[node.agent] || node.agent || node.id}${node.id !== node.agent ? ' / ' + node.id : ''}` }])));
					const previous = steps(entry.previousPlan), current = steps(entry.plan); let differences = 0;
					for (const [key, step] of previous) { if (current.get(key)?.signature !== step.signature) { comparison.append(element('p', '\u2212 ' + step.title, 'diff-removed')); differences++; } }
					for (const [key, step] of current) { if (previous.get(key)?.signature !== step.signature) { comparison.append(element('p', '+ ' + step.title, 'diff-added')); differences++; } }
					if (!differences) { comparison.append(element('p', labels.configurationChanged, 'notice')); }
				}
			}
			if (entry.progress) {
				const progress = entry.progress;
				const meter = element('progress', '', '', 'meter') as HTMLProgressElement; meter.max = 100; meter.setAttribute('aria-label', labels[entry.phase] || labels.unknown);
				if (progress.percent !== undefined) { meter.value = progress.percent; }
				article.append(meter);
				const current = progress.currentGate;
				article.append(element('p', [progress.percent === undefined ? '' : progress.percent + '%', current ? `${current.domain || ''} / ${current.id || ''}` : '', current?.elapsedMs === undefined ? '' : Math.floor(current.elapsedMs / 1000) + ' s', progress.attempt ? `${labels.attempt} ${progress.attempt}` : ''].filter(Boolean).join(' \u00b7 '), 'muted', 'measures'));
				if (progress.eta && state.projects.find(item => item.root === entry.project)?.id === 'redevent') { article.append(element('p', `${labels.estimate}: ~${Math.ceil(progress.eta.remainingMs / 60000)} min \u00b7 ${labels.estimateBasis}`, 'muted', 'eta')); }
				if (progress.cause) { article.append(element('p', progress.cause, 'notice', 'cause')); }
				const units = details(article, labels.verifications, 'units');
				for (const node of [...(progress.nodes || []), ...(progress.finalGates || [])]) {
					const row = element('p', `${node.domain ? node.domain + ' / ' : ''}${labels[node.agent] || node.agent || node.id}${node.id && node.agent !== node.id ? ' / ' + node.id : ''} \u00b7 ${labels[node.status] || node.status}${node.elapsedMs === undefined ? '' : ' \u00b7 ' + Math.floor(node.elapsedMs / 1000) + ' s'}`, 'step', `${node.domain}/${node.id}`); units.append(row); if (node.evidence) { button(units, labels.evidence + ' \u00b7 ' + node.id, 'openEvidence', entry, { node: `${node.domain || ''}/${node.id}` }); } if (node.gates) { units.append(element('p', `${node.gates.done} / ${node.gates.total} ${labels.gates}`, 'muted', `${node.domain}/${node.id}/gates`)); }
					if (node.gateDetail?.slow) { units.append(element('p', `${labels.slowGate}: ${Math.floor(node.gateDetail.elapsedMs / 1000)} s \u00b7 ${labels.typicalGate}: ${Math.floor(node.gateDetail.typicalMs / 1000)} s. ${labels.gateBasis}`, 'notice', `${node.domain}/${node.id}/slow`)); }
					if (node.failure) { units.append(element('p', `${node.failure.cause || ''} \u2192 ${node.failure.action || ''}`, 'notice', `${node.domain}/${node.id}/failure`)); }
					if (node.previousAttempt) { units.append(element('p', `${labels.previousAttempt}: ${node.previousAttempt}`, 'muted', `${node.domain}/${node.id}/previous`)); }
					if (node.cause) { units.append(element('p', node.cause, 'muted', `${node.domain}/${node.id}/cause`)); }
				}
				if ((progress.attempts || []).length) { const attempts = details(article, labels.attempts, 'attempts'); for (const attempt of progress.attempts) { attempts.append(element('p', `${attempt.number} \u00b7 ${attempt.kind || ''} \u00b7 ${labels[attempt.outcome] || attempt.outcome || labels.unknown}${attempt.endedAt && attempt.startedAt ? ' \u00b7 ' + Math.floor((attempt.endedAt - attempt.startedAt) / 1000) + ' s' : ''}`, 'muted', String(attempt.number))); } }
			}
			if (['completed', 'failed', 'cancelled'].includes(entry.phase) && entry.progress) {
				const units = [...(entry.progress.nodes || []), ...(entry.progress.finalGates || [])]; const summary = element('div', '', 'result-summary', 'result-summary'); summary.append(element('p', `${labels.result}: ${labels[entry.phase]} \u00b7 PASS ${units.filter(node => node.status === 'passed').length} \u00b7 FAIL ${units.filter(node => ['failed', 'blocked'].includes(node.status)).length} \u00b7 SKIP ${units.filter(node => node.status === 'skipped').length}`)); summary.append(element('p', labels.noAttribution, 'muted')); article.append(summary);
			}
			if (entry.checkedAt) { article.append(element('p', `${labels.checked}: ${new Date(entry.checkedAt).toLocaleTimeString()}`, 'muted', 'checked')); }
			const stale = element('p', labels.stale, 'notice', 'stale'); stale.hidden = !entry.progressError && !(entry.phase === 'running' && entry.checkedAt && Date.now() - entry.checkedAt > 15000); article.append(stale);
			if ((entry.warnings || []).length) { const warnings = details(article, labels.environmentNotes, 'warnings'); warnings.open = entry.warnings.some(warning => warning.blocking); for (const warning of entry.warnings) { warnings.append(element('p', `${warning.blocking ? labels.requirement + ' \u00b7 ' : ''}${warning.message}${warning.hint ? ' \u2192 ' + warning.hint : ''}`, warning.blocking ? 'notice' : 'muted', warning.id || warning.message)); } }
			if ((entry.plan || []).some(plan => plan.nodes.some(node => node.dependencies?.length))) { const graph = details(article, labels.dependencies, 'dependencies'); for (const plan of entry.plan) { for (const node of plan.nodes) { graph.append(element('p', `${plan.domain} / ${node.id} \u2190 ${(node.dependencies || []).join(', ') || labels.noDependencies}`, 'step', `${plan.domain}/${node.id}`)); } } }
			if (entry.timeline?.length) { const timeline = details(article, labels.timeline + ' \u00b7 ' + labels.observedTimeline, 'timeline'); for (const [index, event] of entry.timeline.entries()) { timeline.append(element('p', `${new Date(event.at).toLocaleTimeString()} \u00b7 ${labels[event.phase] || event.phase}${event.unit ? ' \u00b7 ' + event.unit : ''}${event.attempt ? ' \u00b7 ' + labels.attempt + ' ' + event.attempt : ''}`, 'muted', String(index))); } }
			if (entry.phase === 'blocked') { article.append(element('p', labels[entry.error] || labels.blockedHint, 'notice', 'error')); }
			if (entry.phase === 'unknown') { article.append(element('p', labels.unknownHint, 'notice', 'unknown')); }
			if (entry.phase === 'questions') {
				const questions = element('form', '', '', 'questions') as HTMLFormElement;
				for (const question of entry.questions) {
					const label = element('label', question.question, '', question.id);
					const input = (question.options.length ? element('select') : element('input')) as HTMLInputElement;
					input.name = question.id; input.required = true; input.disabled = !state.trusted;
					if (input.tagName === 'SELECT') { for (const value of question.options) { const option = element('option', value) as HTMLOptionElement; option.value = value; input.append(option); } }
					label.append(input); questions.append(label);
				}
				const submit = element('button', labels.answer) as HTMLButtonElement; submit.type = 'submit'; submit.disabled = !state.trusted; questions.append(submit);
				questions.onsubmit = event => { event.preventDefault(); const target = event.currentTarget as HTMLFormElement; if (target.reportValidity()) { target.querySelector('button').disabled = true; send('answerTask', entry, { answers: Object.fromEntries(new FormData(target).entries()) }); } }; article.append(questions);
			}
			if (entry.logs !== undefined) {
				const logs = details(article, labels.logs, 'logs'); logs.open = true;
				const search = element('input', '', '', 'log-search') as HTMLInputElement; search.type = 'search'; search.placeholder = labels.logSearch; search.setAttribute('aria-label', labels.logSearch); search.value = logFilters.get(entry.id) || ''; search.oninput = event => { logFilters.set(entry.id, (event.target as HTMLInputElement).value); render(latest); }; logs.append(search);
				const follow = element('button', labels.follow, 'quiet', 'follow') as HTMLButtonElement; const lines = entry.logs.split('\n'); if (!logSeen.has(entry.id) || following.has(entry.id)) { logSeen.set(entry.id, lines.length); } const unread = Math.max(0, lines.length - logSeen.get(entry.id)); follow.textContent = labels.follow + (unread ? ` \u00b7 ${unread} ${labels.newLines}` : '');
				follow.type = 'button'; follow.setAttribute('aria-pressed', String(following.has(entry.id))); follow.onclick = () => { if (following.has(entry.id)) { following.delete(entry.id); } else { following.add(entry.id); } render(latest); }; logs.append(follow);
				const query = logFilters.get(entry.id)?.toLocaleLowerCase() || ''; const output = element('pre', entry.logs ? '' : labels.noLogs, 'tool-output', 'log-output'); for (const [index, line] of lines.entries()) { if (line.toLocaleLowerCase().includes(query)) { output.append(element('span', line + '\n', '', String(index))); } } logs.append(output);
			}
			const actions = element('div', '', 'actions', 'actions');
			if (state.trusted) {
				if (entry.creationUncertain) { button(actions, labels.reconcile, 'reconcileCreation', entry); }
				if (entry.phase === 'review') { button(actions, labels.start, 'startTask', entry); }
				if (entry.editable && ['review', 'questions', 'blocked'].includes(entry.phase)) { button(actions, labels.edit, 'editTask', entry); }
				if ((entry.owned || state.projects.find(item => item.root === entry.project)?.id === 'armotusitio') && ['preparing', 'running', 'pending'].includes(entry.phase)) { button(actions, labels.stop, 'stopTask', entry); }
				if (entry.nativeId && entry.checkedAt && !entry.progressError && ['interrupted', 'failed', 'cancelled', 'pending'].includes(entry.phase)) { button(actions, ['failed', 'cancelled'].includes(entry.phase) ? labels.retry : labels.resume, 'resumeTask', entry); }
			}
			button(actions, preferences.pin === entry.id ? labels.unpin : labels.pin, 'pin', entry);
			button(actions, labels.logs, 'workflowLogs', entry);
			const more = details(article, labels.moreActions, 'more-actions'); const secondary = element('div', '', 'actions'); more.append(secondary);
			button(secondary, entry.issueKey ? labels.inspectCard + ' \u00b7 ' + entry.issueKey : labels.card, entry.issueKey ? 'inspectCard' : 'bindCard', entry);
			if (entry.nativeId) { button(secondary, labels.export, 'exportTask', entry); button(secondary, labels.reuse, 'reuseTask', entry); }
			article.append(actions);
			const cached = cards.get(entry.id);
			const node = cached ? reconcile(cached, article) : article; cards.set(entry.id, node); desired.push(node);
			const logSearch = node.querySelector<HTMLInputElement>('[data-key="log-search"]'); if (logSearch) { logSearch.oninput = article.querySelector<HTMLInputElement>('[data-key="log-search"]').oninput; }
			const output = node.querySelector<HTMLElement>('[data-key="log-output"]'); if (output) { output.onscroll = () => { if (output.scrollTop + output.clientHeight < output.scrollHeight - 8) { following.delete(entry.id); } }; if (following.has(entry.id)) { requestAnimationFrame(() => { output.scrollTop = output.scrollHeight; }); } }
		}
		for (const [id] of cards) { if (!state.workflows.some(entry => entry.id === id)) { cards.delete(id); } }
		for (const child of Array.from(container.children)) { if (!desired.includes(child)) { child.remove(); } }
		desired.forEach((node, index) => { if (container.children[index] !== node) { container.insertBefore(node, container.children[index] || null); } });
		if (pendingNative) { const target = desired.find(node => (node.dataset.nativeId === pendingNative.id || node.dataset.entryId === pendingNative.id) && node.dataset.project === pendingNative.project); if (target) { pendingNative = undefined; requestAnimationFrame(() => target.scrollIntoView({ block: 'start' })); } }
	}
	return render;
}
module.exports = { workspaceUi, revealTask };
