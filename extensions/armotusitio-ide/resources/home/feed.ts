/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Inicio's control center: request field, attention, now and recent, rendered from the shared activity feed. */

const ACTIVE = ['queued', 'running', 'paused'];
/** Filters appear only when there is enough to filter. */
const FILTER_THRESHOLD = 8;
const RECENT_LIMIT = 20;
/** Icons make states distinguishable without color. */
const ICONS = { running: '\u25b6', queued: '•', paused: '\u23f8', completed: '✓', partial: '\u25d1', blocked: '⚠', unchanged: '\u2013', failed: '\u2717', cancelled: '\u2298', interrupted: '⚠' };

function feedUi(ide) {
	let L;
	let items = [];
	let folders = [];
	const rendered = new Map();

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) { node.className = className; }
		if (text !== undefined) { node.textContent = text; }
		return node;
	}
	const format = (template, ...args) => template.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)] ?? '');
	function ago(ms) {
		const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
		return format(L.elapsed, minutes < 1 ? '<1 min' : minutes < 60 ? minutes + ' min' : Math.round(minutes / 60) + ' h');
	}
	/** One line that says what happens and, when needed, what to do; detail stays one click away in the chat. */
	function itemNode(item) {
		const node = el('li', 'feed-item state-' + item.state + (item.needs ? ' needs' : '') + (item.stale ? ' stale' : ''));
		node.dataset.id = item.id;
		const head = el('div', 'feed-head');
		const status = item.needs ? L.needs[item.needs] : L.states[item.state] || item.state;
		const badge = el('span', 'feed-state', (ICONS[item.state] || '•') + ' ' + status);
		badge.title = L.kinds[item.kind] || '';
		head.append(badge, el('span', 'feed-title', item.title));
		node.append(head);
		const meta = [item.project, item.step ? (L.stages[item.step.label] || format(L.step, String(item.step.index), String(item.step.total))) : '', item.detail || '', item.stale ? L.stale : '', ago(item.updatedAt)].filter(Boolean);
		node.append(el('p', 'feed-meta muted', meta.join(' · ')));
		const actions = el('div', 'feed-actions');
		item.actions.forEach((action, index) => {
			const button = el('button', index === 0 && action !== 'open' ? 'primary' : 'secondary', L.actions[action] || action);
			button.type = 'button';
			button.addEventListener('click', () => { button.disabled = true; ide.postMessage({ action: 'act', id: item.id, command: action }); });
			actions.append(button);
		});
		node.append(actions);
		return node;
	}
	/** Keyed update: unchanged items keep their node, so focus and scroll survive live updates. */
	function fill(section, list, show) {
		const target = document.querySelector('#' + section + ' .feed-list');
		const keys = new Set(list.map(item => item.id + JSON.stringify(item)));
		for (const [key, node] of rendered) { if (node.parentElement === target && !keys.has(key)) { node.remove(); rendered.delete(key); } }
		list.forEach((item, index) => {
			const key = item.id + JSON.stringify(item);
			const node = rendered.get(key) || itemNode(item);
			rendered.set(key, node);
			if (target.children[index] !== node) { target.insertBefore(node, target.children[index] || null); }
		});
		document.getElementById(section).hidden = !show;
	}
	function render() {
		if (!L) { return; }
		const filter = (document.getElementById('feed-filter') as HTMLInputElement);
		const query = filter.value.trim().toLowerCase();
		const attention = items.filter(item => item.needs);
		const now = items.filter(item => !item.needs && ACTIVE.includes(item.state));
		const finished = items.filter(item => !item.needs && !ACTIVE.includes(item.state));
		filter.hidden = finished.length <= FILTER_THRESHOLD;
		const recent = finished.filter(item => !query || (item.title + ' ' + item.project).toLowerCase().includes(query)).slice(0, RECENT_LIMIT);
		fill('feed-attention', attention, attention.length > 0);
		fill('feed-now', now, true);
		fill('feed-recent', recent, true);
		const idle = document.querySelector('#feed-now .feed-empty') || el('p', 'feed-empty muted', L.idle);
		if (!now.length) { document.getElementById('feed-now').append(idle); } else { idle.remove(); }
		const none = document.querySelector('#feed-recent .feed-empty') || el('p', 'feed-empty muted', L.noRecent);
		if (!finished.length) { document.getElementById('feed-recent').append(none); } else { none.remove(); }
	}
	function renderAsk() {
		document.getElementById('ask-title').textContent = L.askTitle;
		const text = document.getElementById('ask-text') as HTMLTextAreaElement;
		text.placeholder = L.askPlaceholder; text.setAttribute('aria-label', L.askTitle);
		document.getElementById('ask-hint').textContent = L.askHint;
		document.getElementById('ask-send').textContent = L.ask;
		const holder = document.getElementById('ask-project');
		const current = (holder.querySelector('select') as HTMLSelectElement)?.value;
		holder.textContent = '';
		// The project is chosen only when there is a choice to make.
		if (folders.length > 1) {
			const select = el('select') as HTMLSelectElement; select.id = 'ask-folder'; select.setAttribute('aria-label', L.askProject);
			for (const folder of folders) { const option = el('option', undefined, folder.name) as HTMLOptionElement; option.value = folder.id; select.append(option); }
			if (current && folders.some(folder => folder.id === current)) { select.value = current; }
			holder.append(select);
		}
		for (const [id, key] of [['feed-attention-title', 'attention'], ['feed-now-title', 'now'], ['feed-recent-title', 'recent']]) { document.getElementById(id).textContent = L[key]; }
		(document.getElementById('feed-filter') as HTMLInputElement).placeholder = L.filter;
		(document.getElementById('feed-filter') as HTMLInputElement).setAttribute('aria-label', L.filter);
	}
	function renderProjects(projects) {
		const strip = document.getElementById('project-strip');
		strip.textContent = '';
		strip.hidden = !projects.length;
		for (const project of projects) { strip.append(el('span', 'project-chip' + (project.warning ? ' warning' : ''), project.name)); }
	}
	function wire() {
		document.getElementById('ask').addEventListener('submit', event => {
			event.preventDefault();
			const text = document.getElementById('ask-text') as HTMLTextAreaElement;
			const folder = (document.getElementById('ask-folder') as HTMLSelectElement)?.value || folders[0]?.id;
			if (!text.value.trim() || !folder) { return; }
			ide.postMessage({ action: 'ask', folder, text: text.value });
			text.value = '';
		});
		document.getElementById('ask-text').addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); (document.getElementById('ask') as HTMLFormElement).requestSubmit(); }
		});
		document.getElementById('feed-filter').addEventListener('input', render);
	}
	let wired = false;
	return {
		/** Full page state: labels, folders, projects and the feed. */
		state(state) {
			L = state.inicio; folders = state.folders || []; items = state.activity || [];
			if (!wired) { wire(); wired = true; }
			renderAsk(); render();
			const listed = state.projects || [];
			renderProjects([...listed.map(project => ({ name: project.name, warning: !project.providerSupported })), ...(state.nativeProjects || []).filter(project => !listed.some(other => other.root === project.root)).map(project => ({ name: project.name, warning: !!project.error }))]);
		},
		/** Live feed update: only the items. */
		feed(next) { items = next || []; render(); },
		draft(text) { const field = document.getElementById('ask-text') as HTMLTextAreaElement; field.value = text; field.focus(); },
		openMore() { (document.getElementById('more') as HTMLDetailsElement).open = true; }
	};
}

module.exports = { feedUi };
