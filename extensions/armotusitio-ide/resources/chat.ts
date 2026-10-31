/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Conversational Chat Harness. All content is rendered with textContent; the host owns every effect. */
'use strict';
const api = acquireVsCodeApi();
const { parseMarkdown, parseInline } = require('./markdown.ts');

const app = document.getElementById('app');
let L: any = null;
let state: any = null;
const rendered = new Map<string, HTMLElement>();
let ticker: number | undefined;

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) { node.className = className; }
	if (text !== undefined) { node.textContent = text; }
	return node;
}
function format(template: string, ...args: string[]): string { return template.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)] ?? ''); }
function providerName(provider: string): string { return provider === 'claude' ? L.claude : L.codex; }
function elapsed(from: string): string {
	const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(from)) / 1000));
	return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
function duration(ms: number): string { return ms < 60000 ? Math.round(ms / 1000) + ' s' : Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s'; }

const COPIED_FEEDBACK_MS = 1500;
function copyButton(text: string, className: string, label: string): HTMLButtonElement {
	const button = el('button', className, L.copy) as HTMLButtonElement; button.type = 'button'; button.setAttribute('aria-label', label);
	button.addEventListener('click', () => { void navigator.clipboard?.writeText(text).then(() => { button.textContent = L.copied; setTimeout(() => { button.textContent = L.copy; }, COPIED_FEEDBACK_MS); }); });
	return button;
}
function inlines(target: HTMLElement, parts: any[]): HTMLElement {
	for (const part of parts) {
		if (part.type === 'text') { target.append(document.createTextNode(part.text)); continue; }
		const node = el(part.type === 'link' ? 'span' : part.type, part.type === 'link' ? 'md-link' : undefined, part.text);
		if (part.type === 'link') { node.title = part.href; }
		target.append(node);
	}
	return target;
}
function markdown(source: string): HTMLElement {
	const root = el('div', 'markdown');
	for (const block of parseMarkdown(source)) {
		if (block.type === 'heading') { root.append(inlines(el('h' + Math.min(6, block.level + 2)), block.inlines)); }
		else if (block.type === 'paragraph') { root.append(inlines(el('p'), block.inlines)); }
		else if (block.type === 'quote') { root.append(inlines(el('blockquote'), block.inlines)); }
		else if (block.type === 'rule') { root.append(el('hr')); }
		else if (block.type === 'list') {
			const list = el(block.ordered ? 'ol' : 'ul');
			for (const item of block.items) { list.append(inlines(el('li'), item)); }
			root.append(list);
		} else if (block.type === 'table') {
			const wrap = el('div', 'table-wrap'); const table = el('table');
			const head = el('tr'); for (const cell of block.header) { head.append(inlines(el('th'), cell)); }
			table.append(head);
			for (const row of block.rows) { const tr = el('tr'); for (const cell of row) { tr.append(inlines(el('td'), cell)); } table.append(tr); }
			wrap.append(table); root.append(wrap);
		} else if (block.type === 'code') {
			const figure = el('div', 'code-block');
			const bar = el('div', 'code-bar'); bar.append(el('span', 'code-lang', block.language || 'text'));
			bar.append(copyButton(block.text, 'link-button', L.copyCode));
			const pre = el('pre'); pre.append(el('code', undefined, block.text));
			figure.append(bar, pre); root.append(figure);
		}
	}
	return root;
}

// ---------------------------------------------------------------- layout
function shell(): void {
	app.textContent = '';
	rendered.clear();
	const header = el('header', 'topbar');
	const brand = el('div', 'brand');
	const logo = document.createElement('img'); logo.src = app.dataset.logo; logo.alt = ''; logo.width = 24; logo.height = 24;
	const titles = el('div', 'brand-text');
	titles.append(el('h1', undefined, L.title));
	const project = el('select', 'project-select') as HTMLSelectElement; project.id = 'project'; project.setAttribute('aria-label', L.project);
	project.addEventListener('change', () => api.postMessage({ action: 'project', id: project.value }));
	const projectName = el('span', 'project-name'); projectName.id = 'project-name';
	titles.append(project, projectName);
	brand.append(logo, titles);

	const controls = el('div', 'controls');
	const switcher = el('div', 'provider-switch'); switcher.setAttribute('role', 'radiogroup'); switcher.setAttribute('aria-label', L.provider);
	for (const provider of ['codex', 'claude']) {
		const button = el('button', 'provider-option') as HTMLButtonElement; button.type = 'button'; button.dataset.provider = provider; button.setAttribute('role', 'radio');
		button.append(el('span', 'dot'), el('span', 'provider-name', providerName(provider)), el('span', 'provider-status'));
		button.addEventListener('click', () => api.postMessage({ action: 'provider', provider }));
		switcher.append(button);
	}
	switcher.addEventListener('keydown', event => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') { return; }
		const next = state?.chat?.provider === 'claude' ? 'codex' : 'claude';
		api.postMessage({ action: 'provider', provider: next });
		(switcher.querySelector('[data-provider="' + next + '"]') as HTMLElement)?.focus();
		event.preventDefault();
	});
	const mcp = el('button', 'mcp-pill') as HTMLButtonElement; mcp.type = 'button'; mcp.id = 'mcp-pill';
	mcp.setAttribute('aria-expanded', 'false'); mcp.setAttribute('aria-controls', 'mcp-details');
	mcp.append(el('span', 'dot'), el('span', 'mcp-label'));
	mcp.addEventListener('click', () => toggle('mcp-details', mcp));
	const more = el('button', 'icon-button', '\u22ef') as HTMLButtonElement; more.type = 'button'; more.id = 'menu-button';
	more.setAttribute('aria-label', L.menu); more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', 'menu');
	more.addEventListener('click', () => toggle('menu', more));
	controls.append(switcher, mcp, more);
	header.append(brand, controls);

	const details = el('section', 'popover mcp-details'); details.id = 'mcp-details'; details.hidden = true; details.setAttribute('aria-label', L.mcp);
	const menu = el('div', 'popover menu'); menu.id = 'menu'; menu.hidden = true; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', L.menu);
	for (const [action, label] of [['reset', L.newChat], ['commands', L.commands], ['providerCheck', L.refreshProviders], ['openTasks', L.openTasks]]) {
		const item = el('button', 'menu-item', label) as HTMLButtonElement; item.type = 'button';
		item.addEventListener('click', () => {
			closePopovers();
			if (action === 'commands') { submit('/comandos'); return; }
			api.postMessage({ action });
		});
		menu.append(item);
	}
	const banner = el('div', 'banner'); banner.id = 'banner'; banner.setAttribute('role', 'status');
	const log = el('main', 'log'); log.id = 'log'; log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-label', L.log); log.tabIndex = 0;
	const thread = el('div', 'thread'); thread.id = 'thread';
	// Live activity sits outside the log region: its clock would otherwise be announced every second.
	const activity = el('section', 'activity'); activity.id = 'activity'; activity.setAttribute('aria-label', L.activity);
	const empty = el('section', 'empty'); empty.id = 'empty';
	const announcer = el('div', 'visually-hidden'); announcer.id = 'announcer'; announcer.setAttribute('role', 'status');
	const conversation = el('div', 'conversation'); conversation.append(thread);
	log.append(empty, conversation, activity, announcer);

	const form = el('form', 'composer') as HTMLFormElement; form.id = 'composer';
	const box = el('div', 'composer-box');
	const input = el('textarea') as HTMLTextAreaElement; input.id = 'prompt'; input.rows = 1; input.maxLength = 10000; input.placeholder = L.placeholder;
	input.setAttribute('aria-label', L.placeholder); input.setAttribute('aria-describedby', 'composer-hint');
	const send = el('button', 'send', L.send) as HTMLButtonElement; send.type = 'submit'; send.id = 'send';
	const stop = el('button', 'secondary stop', L.cancel) as HTMLButtonElement; stop.type = 'button'; stop.id = 'stop'; stop.hidden = true;
	stop.addEventListener('click', () => api.postMessage({ action: 'cancel' }));
	box.append(input, stop, send);
	form.append(box, el('p', 'hint', L.keyboard));
	(form.lastElementChild as HTMLElement).id = 'composer-hint';
	form.addEventListener('submit', event => { event.preventDefault(); submit(input.value); });
	input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
	input.addEventListener('input', autosize);
	app.append(header, details, menu, banner, log, form);
}
// Registered once: `shell()` runs again whenever the host re-sends labels.
document.addEventListener('keydown', event => {
	if (event.key !== 'Escape') { return; }
	const open = ['mcp-details', 'menu'].find(id => document.getElementById(id)?.hidden === false);
	closePopovers();
	// Return focus to the control that opened the popover (WCAG 2.4.3).
	if (open) { document.getElementById(open === 'menu' ? 'menu-button' : 'mcp-pill')?.focus(); }
});
document.addEventListener('click', event => {
	const target = event.target as HTMLElement;
	if (L && !target.closest('.popover') && !target.closest('#mcp-pill') && !target.closest('#menu-button')) { closePopovers(); }
});
function autosize(): void { const input = document.getElementById('prompt') as HTMLTextAreaElement; input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 240) + 'px'; }
function toggle(id: string, trigger: HTMLElement): void {
	const panel = document.getElementById(id); const open = panel.hidden;
	closePopovers();
	panel.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
	if (open) { (panel.querySelector('button') as HTMLElement)?.focus(); }
}
function closePopovers(): void {
	for (const id of ['mcp-details', 'menu']) { const panel = document.getElementById(id); if (panel) { panel.hidden = true; } }
	document.getElementById('mcp-pill')?.setAttribute('aria-expanded', 'false');
	document.getElementById('menu-button')?.setAttribute('aria-expanded', 'false');
}
function busy(): boolean { return !!state?.chat?.activity; }
function submit(value: string): void {
	const text = value.trim();
	if (!text || busy() || !state?.chat) { return; }
	api.postMessage({ action: 'send', text });
	const input = document.getElementById('prompt') as HTMLTextAreaElement; input.value = ''; autosize();
}

// ---------------------------------------------------------------- header state
function renderHeader(): void {
	const select = document.getElementById('project') as HTMLSelectElement;
	const name = document.getElementById('project-name');
	select.textContent = '';
	for (const project of state.projects) { const option = el('option', undefined, project.name) as HTMLOptionElement; option.value = project.id; select.append(option); }
	if (state.project) { select.value = state.project.id; }
	select.hidden = state.projects.length < 2; name.hidden = state.projects.length >= 2;
	name.textContent = state.project?.name ?? '';
	const selected = state.chat?.provider;
	for (const button of document.querySelectorAll<HTMLButtonElement>('.provider-option')) {
		const provider = button.dataset.provider; const info = state.providers[provider] || { status: 'unknown' };
		button.setAttribute('aria-checked', String(provider === selected)); button.tabIndex = provider === selected ? 0 : -1;
		button.disabled = !state.chat;
		button.dataset.status = info.status;
		button.querySelector('.provider-status').textContent = L.providerStatus[info.status] || info.status;
		button.title = providerName(provider) + ' \u00b7 ' + (L.providerStatus[info.status] || info.status) + (info.version ? ' \u00b7 v' + info.version : '');
	}
	const mcp = state.mcp; const pill = document.getElementById('mcp-pill');
	pill.dataset.state = mcp.state;
	pill.querySelector('.mcp-label').textContent = L.mcp + ': ' + L.mcpState[mcp.state];
	const details = document.getElementById('mcp-details'); details.textContent = '';
	details.append(el('h2', undefined, L.mcp + ' \u00b7 ' + L.mcpState[mcp.state]));
	const facts = el('dl', 'facts');
	const fact = (term: string, value: string) => { facts.append(el('dt', undefined, term), el('dd', undefined, value)); };
	fact(L.mcpEndpoint, mcp.endpoint);
	if (mcp.state === 'connected') { fact(L.toolsTerm, format(L.mcpTools, String(mcp.tools))); }
	if (mcp.reason) { fact(L.mcpState[mcp.state], L.mcpReason[mcp.reason] || mcp.reason); }
	if (mcp.checkedAt) { fact(L.mcpChecked, new Date(mcp.checkedAt).toLocaleTimeString()); }
	details.append(facts, el('p', 'muted', L.mcpOptional));
	const actions = el('div', 'actions');
	const action = (name: string, label: string, primary = false) => {
		const button = el('button', primary ? '' : 'secondary', label) as HTMLButtonElement; button.type = 'button';
		button.disabled = mcp.state === 'checking' && name === 'mcpCheck';
		button.addEventListener('click', () => api.postMessage({ action: name })); actions.append(button);
	};
	if (!mcp.enabled && state.trusted) { action('mcpEnable', L.mcpEnable, true); }
	else if (mcp.reason === 'missing-key') { action('mcpConfigure', L.mcpConfigure, true); }
	else if (mcp.reason === 'auth') { action('mcpChangeKey', L.mcpChangeKey, true); }
	action('mcpCheck', L.mcpCheck);
	action('mcpSettings', L.mcpSettings);
	details.append(actions);
}

// ---------------------------------------------------------------- messages
function planCard(message: any): HTMLElement {
	const plan = message.plan;
	const card = el('section', 'plan-card'); card.dataset.messageId = message.id; card.setAttribute('aria-label', format(L.plan, String(plan.version)) + ': ' + plan.title);
	const head = el('div', 'plan-head');
	head.append(el('span', 'badge', format(L.plan, String(plan.version))), el('h3', undefined, plan.title));
	card.append(head);
	if (plan.summary) { card.append(markdown(plan.summary)); }
	const section = (title: string, items: string[], ordered = false) => {
		if (!items.length) { return; }
		card.append(el('h4', undefined, title));
		const list = el(ordered ? 'ol' : 'ul');
		for (const item of items) { list.append(inlines(el('li'), parseInline(item))); }
		card.append(list);
	};
	section(L.planSteps, plan.steps, true);
	section(L.planFiles, plan.files);
	section(L.planRisks, plan.risks);
	section(L.planSkills, plan.skills);
	const verification = el('div', 'plan-verification'); card.append(verification);
	card.append(el('div', 'plan-footer'));
	return card;
}
function updatePlanCards(): void {
	const current = state.chat?.plan;
	for (const card of document.querySelectorAll<HTMLElement>('.plan-card')) {
		const latest = current && card.dataset.messageId === current.messageId;
		card.classList.toggle('superseded', !latest);
		const verification = card.querySelector('.plan-verification'); verification.textContent = '';
		const footer = card.querySelector('.plan-footer'); footer.textContent = '';
		if (!latest) { footer.append(el('p', 'muted', L.superseded)); continue; }
		verification.append(el('h4', undefined, L.planVerification));
		if (state.chat.verification.length) {
			const list = el('ul', 'commands');
			for (const gate of state.chat.verification) { const item = el('li'); item.append(el('code', undefined, gate.command)); list.append(item); }
			verification.append(list);
		} else { verification.append(el('p', 'muted', L.planNoVerification)); }
		const actions = el('div', 'actions');
		const approve = el('button', 'approve', L.approve) as HTMLButtonElement; approve.type = 'button';
		approve.disabled = !current.approvable;
		const hint = el('p', 'muted', current.blockedReason || L.approveHint); hint.id = 'plan-hint-' + current.messageId;
		approve.setAttribute('aria-describedby', hint.id);
		approve.addEventListener('click', () => { if (!approve.disabled) { approve.disabled = true; api.postMessage({ action: 'approve', digest: current.digest }); } });
		const change = el('button', 'secondary', L.requestChanges) as HTMLButtonElement; change.type = 'button';
		change.disabled = busy();
		change.addEventListener('click', () => { const input = document.getElementById('prompt') as HTMLTextAreaElement; input.value = L.requestPrefix; input.focus(); autosize(); });
		actions.append(approve, change);
		footer.append(actions, hint);
	}
}
function runSummary(run: any): HTMLElement {
	const box = el('div', 'run-summary');
	const head = el('div', 'run-head');
	head.append(el('span', 'status-badge ' + run.status, L.run[run.status] || run.status), el('span', 'muted', format(L.plan, String(run.planVersion)) + ' \u00b7 ' + providerName(run.provider) + ' \u00b7 ' + L.duration + ' ' + duration(run.durationMs)));
	box.append(head);
	box.append(el('h4', undefined, L.verification));
	if (run.verification.status === 'skipped') { box.append(el('p', 'muted', L.verificationSkipped)); }
	else {
		box.append(gateList(run.verification.gates));
		if (run.verification.error) { box.append(el('p', 'error-text', run.verification.error)); }
	}
	return box;
}
function gateList(gates: any[]): HTMLElement {
	const list = el('ul', 'gates');
	for (const gate of gates) {
		const item = el('li', 'gate ' + gate.status);
		item.append(el('span', 'gate-icon'), el('span', 'gate-id', gate.id), el('span', 'gate-status', L.gate[gate.status] || gate.status));
		list.append(item);
	}
	return list;
}
function messageNode(message: any): HTMLElement {
	const node = el('article', 'message ' + message.role + (message.tone ? ' ' + message.tone : ''));
	node.dataset.id = message.id;
	const meta = el('div', 'meta');
	const who = message.role === 'user' ? L.you : message.role === 'notice' ? L.notice : providerName(message.provider || 'claude');
	meta.append(el('span', 'author', who), el('time', 'muted', new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
	node.setAttribute('aria-label', who);
	node.append(meta);
	if (message.role === 'user') { node.append(el('div', 'bubble', message.text)); return node; }
	if (message.run) { node.append(runSummary(message.run)); }
	if (message.text) { node.append(markdown(message.text)); }
	if (message.plan) { node.append(planCard(message)); }
	if (message.role === 'assistant' || message.run) {
		node.append(copyButton(message.text, 'link-button copy', L.copyMessage));
	}
	return node;
}
function renderThread(): void {
	const thread = document.getElementById('thread');
	const messages = state.chat?.messages ?? [];
	const ids = new Set(messages.map(message => message.id));
	if ([...rendered.keys()].some(id => !ids.has(id))) { thread.textContent = ''; rendered.clear(); }
	for (const message of messages) {
		if (rendered.has(message.id)) { continue; }
		const node = messageNode(message); rendered.set(message.id, node); thread.append(node);
	}
	updatePlanCards();
}
function renderEmpty(): void {
	const empty = document.getElementById('empty'); empty.textContent = '';
	const show = !!state.chat && !state.chat.messages.length && !state.chat.activity;
	empty.hidden = !show;
	if (!show) { return; }
	empty.append(el('h2', undefined, L.emptyTitle), el('p', 'muted', L.emptyBody));
	const chips = el('div', 'chips');
	for (const suggestion of L.suggestions) {
		const chip = el('button', 'chip', suggestion) as HTMLButtonElement; chip.type = 'button';
		chip.addEventListener('click', () => submit(suggestion)); chips.append(chip);
	}
	empty.append(chips);
}
let announced = '';
/** Speak only phase changes (start, stage, gate results, end), never timers or byte counters. */
function announce(activity: any): void {
	const phase = !activity ? '' : activity.kind === 'thinking' ? format(L.thinking, providerName(activity.provider))
		: [L.stage[activity.stage], ...(activity.gates || []).filter(gate => gate.status !== 'pending').map(gate => gate.id + ': ' + (L.gate[gate.status] || gate.status))].join('. ');
	if (phase === announced) { return; }
	announced = phase;
	document.getElementById('announcer').textContent = phase || L.idle;
}
function renderActivity(): void {
	const box = document.getElementById('activity'); box.textContent = '';
	const activity = state.chat?.activity;
	announce(activity);
	window.clearInterval(ticker); ticker = undefined;
	if (!activity) { box.hidden = true; return; }
	box.hidden = false;
	const head = el('div', 'activity-head');
	const spinner = el('span', 'spinner'); spinner.setAttribute('aria-hidden', 'true');
	const title = activity.kind === 'thinking' ? format(L.thinking, providerName(activity.provider)) : format(L.executing, String(activity.planVersion), providerName(activity.provider));
	const clock = el('span', 'muted clock', elapsed(activity.startedAt)); clock.setAttribute('aria-hidden', 'true');
	head.append(spinner, el('strong', undefined, title), clock);
	box.append(head);
	if (activity.partial) {
		// Real intermediate message from the provider stream; replaced by the final answer when the turn ends.
		const partial = el('div', 'partial'); partial.append(el('p', 'partial-label', L.partial), markdown(activity.partial));
		box.append(partial);
	}
	if (activity.kind === 'executing') {
		const stages = el('ol', 'stages');
		const order = ['preparing', 'agent', 'verifying'];
		const position = order.indexOf(activity.stage);
		for (const [index, stage] of order.entries()) {
			const item = el('li', 'stage ' + (index < position ? 'done' : index === position ? 'current' : 'pending'), L.stage[stage]);
			if (index === position) { item.setAttribute('aria-current', 'step'); }
			stages.append(item);
		}
		box.append(stages);
		if (activity.gates?.length) { box.append(gateList(activity.gates)); }
	}
	if (activity.observedBytes) { const bytes = el('p', 'muted', format(L.observed, String(Math.round(activity.observedBytes / 1024)))); bytes.setAttribute('aria-hidden', 'true'); box.append(bytes); }
	ticker = window.setInterval(() => { clock.textContent = elapsed(activity.startedAt); }, 1000);
}
function renderComposer(): void {
	const running = busy();
	(document.getElementById('send') as HTMLButtonElement).hidden = running;
	(document.getElementById('send') as HTMLButtonElement).disabled = !state.chat;
	const stop = document.getElementById('stop') as HTMLButtonElement;
	stop.hidden = !running; stop.disabled = !!state.chat?.activity?.cancelling;
	stop.textContent = state.chat?.activity?.cancelling ? L.cancelling : L.cancel;
	(document.getElementById('prompt') as HTMLTextAreaElement).disabled = !state.chat;
	document.getElementById('composer').setAttribute('aria-busy', String(running));
	const banner = document.getElementById('banner');
	const text = !state.project ? L.noProject : !state.trusted ? L.untrusted : state.chat && !state.chat.writer ? L.hybrid : '';
	banner.textContent = text; banner.hidden = !text;
}
function render(): void {
	const log = document.getElementById('log');
	const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
	renderHeader(); renderThread(); renderEmpty(); renderActivity(); renderComposer();
	if (pinned) { log.scrollTop = log.scrollHeight; }
}

window.addEventListener('message', event => {
	const data = event.data;
	if (data?.type === 'init') { L = data.labels; shell(); if (state) { render(); } return; }
	if (data?.type === 'state') {
		if (data.chat && data.chat.messages === undefined) { data.chat.messages = state?.chat?.messages ?? []; }
		state = data;
		if (L) { render(); }
	}
});
api.postMessage({ action: 'ready' });
