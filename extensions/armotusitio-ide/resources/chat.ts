/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Conversational Chat Harness. All content is rendered with textContent; the host owns every effect. */
'use strict';
const api = acquireVsCodeApi();
const { parseMarkdown, parseInline } = require('./markdown.ts');
const { createSuggest } = require('./composer-suggest.ts');

const app = document.getElementById('app');
let L: any = null;
let state: any = null;
const rendered = new Map<string, HTMLElement>();
let ticker: number | undefined;
let suggest: ReturnType<typeof createSuggest> | undefined;

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
	const account = el('select', 'account-select') as HTMLSelectElement; account.id = 'account';
	account.addEventListener('change', () => {
		if (account.value === '__manage') { account.value = state?.accounts?.[state?.chat?.provider]?.selected ?? ''; api.postMessage({ action: 'accounts' }); return; }
		api.postMessage({ action: 'account', provider: state?.chat?.provider, profileId: account.value });
	});
	const accountNote = el('span', 'account-note'); accountNote.id = 'account-note'; accountNote.setAttribute('role', 'status');
	const model = el('select', 'model-select') as HTMLSelectElement; model.id = 'model';
	model.addEventListener('change', () => api.postMessage({ action: 'model', provider: state?.chat?.provider, model: model.value }));
	const effort = el('select', 'effort-select') as HTMLSelectElement; effort.id = 'effort';
	effort.addEventListener('change', () => api.postMessage({ action: 'effort', provider: state?.chat?.provider, effort: effort.value }));
	const mode = el('select', 'mode-select') as HTMLSelectElement; mode.id = 'mode';
	for (const [value, label] of [['act', L.modeAct], ['ask', L.modeAsk]]) { const item = el('option', '', label) as HTMLOptionElement; item.value = value; mode.append(item); }
	mode.setAttribute('aria-label', L.mode); mode.title = L.modeHint;
	mode.addEventListener('change', () => api.postMessage({ action: 'mode', mode: mode.value }));
	const sandbox = el('label', 'sandbox-switch'); sandbox.id = 'sandbox-switch'; sandbox.title = L.sandboxHint; sandbox.hidden = true;
	const sandboxBox = el('input') as HTMLInputElement; sandboxBox.type = 'checkbox'; sandboxBox.id = 'sandbox-full'; sandboxBox.setAttribute('role', 'switch');
	sandboxBox.addEventListener('change', () => api.postMessage({ action: 'sandbox', full: sandboxBox.checked }));
	sandbox.append(sandboxBox, el('span', '', L.sandboxFull));
	const mcp = el('button', 'mcp-pill') as HTMLButtonElement; mcp.type = 'button'; mcp.id = 'mcp-pill';
	mcp.setAttribute('aria-expanded', 'false'); mcp.setAttribute('aria-controls', 'mcp-details');
	mcp.append(el('span', 'dot'), el('span', 'mcp-label'));
	mcp.addEventListener('click', () => toggle('mcp-details', mcp));
	const more = el('button', 'icon-button', '\u22ef') as HTMLButtonElement; more.type = 'button'; more.id = 'menu-button';
	more.setAttribute('aria-label', L.menu); more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', 'menu');
	more.addEventListener('click', () => toggle('menu', more));
	const quota = el('span', 'quota'); quota.id = 'quota'; quota.hidden = true; quota.setAttribute('role', 'group'); quota.tabIndex = 0;
	quota.append(el('span', 'quota-icon'), el('span', 'quota-text'));
	controls.append(switcher, account, accountNote, quota, model, effort, mode, sandbox, mcp, more);
	header.append(brand, controls);

	const details = el('section', 'popover mcp-details'); details.id = 'mcp-details'; details.hidden = true; details.setAttribute('aria-label', L.mcp);
	const menu = el('div', 'popover menu'); menu.id = 'menu'; menu.hidden = true; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', L.menu);
	for (const [action, label] of [['reset', L.newChat], ['commands', L.commands], ['providerCheck', L.refreshProviders], ['setupCheck', L.setupCheck], ['openTasks', L.openTasks]]) {
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
	const approvals = el('section', 'approvals'); approvals.id = 'approvals'; approvals.setAttribute('aria-label', L.approvals); approvals.hidden = true;
	const empty = el('section', 'empty'); empty.id = 'empty';
	const announcer = el('div', 'visually-hidden'); announcer.id = 'announcer'; announcer.setAttribute('role', 'status');
	const conversation = el('div', 'conversation'); conversation.append(thread);
	log.append(empty, conversation);

	const form = el('form', 'composer') as HTMLFormElement; form.id = 'composer';
	const box = el('div', 'composer-box');
	const input = el('textarea') as HTMLTextAreaElement; input.id = 'prompt'; input.rows = 1; input.placeholder = L.placeholder;
	input.setAttribute('aria-label', L.placeholder); input.setAttribute('aria-describedby', 'composer-hint');
	const send = el('button', 'send', L.send) as HTMLButtonElement; send.type = 'submit'; send.id = 'send';
	const stop = el('button', 'secondary stop', L.cancel) as HTMLButtonElement; stop.type = 'button'; stop.id = 'stop'; stop.hidden = true;
	stop.addEventListener('click', () => api.postMessage({ action: 'cancel' }));
	box.append(input, stop, send);
	form.append(box, el('p', 'hint', L.keyboard));
	(form.lastElementChild as HTMLElement).id = 'composer-hint';
	form.addEventListener('submit', event => { event.preventDefault(); submit(input.value); });
	suggest = createSuggest(input, form, message => api.postMessage(message), { commands: L.commandsLabel, files: L.filesLabel, commandList: L.commandList });
	input.addEventListener('keydown', event => {
		if (suggest.key(event)) { event.preventDefault(); return; }
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
	});
	input.addEventListener('input', autosize);
	input.addEventListener('input', () => suggest.update());
	input.addEventListener('blur', () => suggest.close());
	app.append(header, details, menu, banner, log, approvals, activity, announcer, form);
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
	if (!text || !state?.chat) { return; }
	api.postMessage({ action: 'send', text });
	// An oversized message is answered with how many characters to remove; the text stays so it can be trimmed.
	if (text.length > L.maxMessageChars) { return; }
	const input = document.getElementById('prompt') as HTMLTextAreaElement; input.value = ''; autosize(); suggest?.close();
}

// ---------------------------------------------------------------- provider quota
const QUOTA_WARN = 20, QUOTA_CRITICAL = 5;
const quotaLevel = (free: number): 'ok' | 'warn' | 'critical' => free < QUOTA_CRITICAL ? 'critical' : free < QUOTA_WARN ? 'warn' : 'ok';
/** "Sesion 95% libre - reinicia 20:40"; a reset more than a day away also names the weekday. */
function quotaLine(window: { id: string; label: string; usedPercent: number; resetsAt?: number }): string {
	const free = Math.max(0, 100 - window.usedPercent);
	const line = format(L.quotaFree, L.quotaWindow[window.id] ?? window.label, String(Math.round(free)));
	if (!window.resetsAt) { return line; }
	const at = new Date(window.resetsAt * 1000);
	const near = at.getTime() - Date.now() < 20 * 3600 * 1000;
	return line + ' \u00b7 ' + format(L.quotaResets, at.toLocaleString([], near ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' }));
}
/** Shows the shortest window of the active provider, the others in the tooltip; hidden when the provider reported nothing. */
function renderQuota(provider: string | undefined): void {
	const node = document.getElementById('quota');
	const windows = ((provider && state.chat?.quota?.[provider]?.windows) || []).filter(window => !window.resetsAt || window.resetsAt * 1000 > Date.now());
	node.hidden = !windows.length;
	if (!windows.length) { return; }
	const level = quotaLevel(Math.min(...windows.map(window => 100 - window.usedPercent)));
	node.dataset.level = level;
	node.querySelector('.quota-icon').textContent = level === 'critical' ? '\u2716' : level === 'warn' ? '\u26a0' : '\u25cf';
	node.querySelector('.quota-text').textContent = quotaLine(windows[0]);
	const detail = windows.map(quotaLine).join('\n');
	const text = format(L.quotaTitle, providerName(provider), detail) + (level === 'ok' ? '' : '\n' + L.quotaLevel[level]);
	node.title = text; node.setAttribute('aria-label', text.replace(/\n/g, '. '));
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
	(document.getElementById('mode') as HTMLSelectElement).value = state.chatMode === 'ask' ? 'ask' : 'act';
	(document.getElementById('sandbox-full') as HTMLInputElement).checked = !!state.codexFullAccess;
	(document.getElementById('sandbox-switch') as HTMLElement).hidden = state.chat?.provider !== 'codex';
	const selected = state.chat?.provider;
	for (const button of document.querySelectorAll<HTMLButtonElement>('.provider-option')) {
		const provider = button.dataset.provider; const info = state.providers[provider] || { status: 'unknown' };
		button.setAttribute('aria-checked', String(provider === selected)); button.tabIndex = provider === selected ? 0 : -1;
		button.disabled = !state.chat;
		button.dataset.status = info.status;
		button.querySelector('.provider-status').textContent = L.providerStatus[info.status] || info.status;
		button.title = providerName(provider) + ' \u00b7 ' + (L.providerStatus[info.status] || info.status) + (info.version ? ' \u00b7 v' + info.version : '');
	}
	renderModel(selected);
	renderAccount(selected);
	renderEffort(selected);
	renderQuota(selected);
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

/** Accounts of the selected provider: the real login state is written in words, never only as a color. */
function renderAccount(provider: string | undefined): void {
	const select = document.getElementById('account') as HTMLSelectElement;
	const info = provider ? state.accounts?.[provider] : undefined;
	select.hidden = !info;
	if (!info) { return; }
	select.textContent = '';
	select.setAttribute('aria-label', format(L.account, providerName(provider)));
	const option = (value: string, label: string) => { const item = el('option', undefined, label) as HTMLOptionElement; item.value = value; select.append(item); };
	option('', L.accountIde);
	for (const account of info.options) { option(account.id, account.alias + ' \u00b7 ' + (L.authState[account.state] ?? account.state)); }
	option('__manage', L.accountManage);
	select.value = info.options.some((account: any) => account.id === info.selected) ? info.selected : '';
	select.disabled = !state.chat || busy();
	select.title = format(L.account, providerName(provider)) + ': ' + (select.selectedOptions[0]?.textContent ?? '');
	// A session keeps the account it started with: say so when the selection now points elsewhere.
	const note = document.getElementById('account-note') as HTMLElement;
	const ran: string | undefined = state.ranWith?.[provider!];
	const name = (id: string) => info.options.find((account: any) => account.id === id)?.alias ?? L.accountIde;
	note.textContent = ran !== undefined && ran !== select.value ? format(L.accountSplit, name(ran), name(select.value)) : '';
}

/** Models of the selected provider; the empty value is the CLI default, named when its configuration says which. */
function renderModel(provider: string | undefined): void {
	const select = document.getElementById('model') as HTMLSelectElement;
	const info = provider ? state.models?.[provider] : undefined;
	select.hidden = !info;
	if (!info) { return; }
	select.textContent = '';
	select.setAttribute('aria-label', format(L.model, providerName(provider)));
	const option = (value: string, label: string) => { const item = el('option', undefined, label) as HTMLOptionElement; item.value = value; select.append(item); };
	option('', info.defaultModel ? format(L.modelDefault, info.defaultModel) : L.modelCliDefault);
	for (const model of info.options) { option(model.id, model.label); }
	// A model set by hand in settings stays visible even when the CLI does not advertise it.
	if (info.selected && !info.options.some((model: any) => model.id === info.selected)) { option(info.selected, info.selected); }
	select.value = info.selected || '';
	select.disabled = !state.chat || busy();
	select.title = format(L.model, providerName(provider)) + ': ' + (select.selectedOptions[0]?.textContent ?? '');
}

/** A separate explicit effort override; empty means the CLI/model's own default. */
function renderEffort(provider: string | undefined): void {
	const select = document.getElementById('effort') as HTMLSelectElement;
	select.hidden = !provider;
	if (!provider) { return; }
	select.textContent = '';
	select.setAttribute('aria-label', format(L.effort, providerName(provider)));
	const option = (value: string, label: string) => {
		const item = el('option', undefined, label) as HTMLOptionElement;
		item.value = value;
		select.append(item);
	};
	option('', L.effortDefault);
	for (const level of ['low', 'medium', 'high', 'xhigh', ...(provider === 'claude' ? ['max'] : [])]) {
		option(level, L.effortShort + ': ' + L.effortLevels[level]);
	}
	select.value = state.efforts?.[provider] || '';
	select.disabled = !state.chat || busy();
	select.title = format(L.effort, providerName(provider)) + ': ' + (select.selectedOptions[0]?.textContent ?? '') + '. ' + L.effortHint;
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
		const isolation = state.chat.isolation ? ' ' + format(L.isolation, L.isolationLevel[state.chat.isolation.writes] || state.chat.isolation.writes) : '';
		const hint = el('p', 'muted', current.blockedReason || L.approveHint + isolation); hint.id = 'plan-hint-' + current.messageId;
		approve.setAttribute('aria-describedby', hint.id);
		approve.addEventListener('click', () => { if (!approve.disabled) { approve.disabled = true; api.postMessage({ action: 'approve', digest: current.digest }); } });
		const change = el('button', 'secondary', L.requestChanges) as HTMLButtonElement; change.type = 'button';
		change.disabled = busy();
		change.addEventListener('click', () => { const input = document.getElementById('prompt') as HTMLTextAreaElement; input.value = L.requestPrefix; input.focus(); autosize(); });
		actions.append(approve, change);
		footer.append(actions, hint);
	}
}
/** What the outcome means for the user, in one line; runs stored before outcomes existed show none. */
function outcomeHint(outcome: any): string | undefined {
	if (!outcome) { return undefined; }
	// A block always says what to do next, so the user is never left with a dead end.
	if (outcome.kind === 'blocked') { return format(L.outcomeHint.blocked, outcome.reason + (outcome.needs ? ' (' + L.needs[outcome.needs] + ')' : '')) + (outcome.needs ? ' ' + L.needsNext[outcome.needs] : ''); }
	if (outcome.kind === 'unchanged') { return L.outcomeHint.unchanged; }
	return outcome.reason ? L.outcomeHint[outcome.reason] : undefined;
}
function fileButton(label: string, path: string, action: string, messageId: string): HTMLButtonElement {
	const button = el('button', 'link-button', label) as HTMLButtonElement; button.type = 'button'; button.setAttribute('aria-label', label + ': ' + path);
	button.addEventListener('click', () => api.postMessage({ action, messageId, path }));
	return button;
}
function changedFiles(message: any, current: any): HTMLElement | undefined {
	const diff = message.run?.outcome?.diff;
	if (!diff?.available || !diff.count) { return undefined; }
	const reverted: string[] = message.run.reverted ?? [];
	const canRevert = !!current && current.messageId === message.id && current.discardable;
	const box = el('details', 'run-files');
	box.append(el('summary', undefined, format(L.changedFiles, String(diff.count))));
	const list = el('ul', 'commands');
	for (const file of diff.files) {
		const item = el('li', 'run-file');
		const done = reverted.includes(file.path);
		item.append(el('code', undefined, file.path), el('span', 'muted', ' ' + L.change[file.change] + (file.preexisting ? ' \u00b7 ' + L.preexisting : '') + (done ? ' \u00b7 ' + L.reverted : '')));
		const actions = el('span', 'file-actions');
		if (!done) { actions.append(fileButton(L.viewChanges, file.path, 'openDiff', message.id)); }
		if (!done && canRevert) { actions.append(fileButton(L.revertFile, file.path, 'revertFile', message.id)); }
		item.append(actions);
		list.append(item);
	}
	if (diff.count > diff.files.length) { list.append(el('li', 'muted', format(L.changedMore, String(diff.count - diff.files.length)))); }
	box.append(list);
	return box;
}
/** One line per step: what kind of action, its target and how it ended. Targets are text, never markup. */
function stepList(steps: any[]): HTMLElement {
	const list = el('ol', 'steps');
	list.setAttribute('aria-label', L.steps);
	for (const step of steps) {
		const item = el('li', 'step ' + step.status);
		const label = el('code', 'step-label', step.label); if (step.detail) { label.title = step.detail; }
		item.append(el('span', 'step-icon'), el('span', 'step-kind', L.stepKind[step.kind] || step.kind), label, el('span', 'visually-hidden', L.stepStatus[step.status] || step.status));
		list.append(item);
	}
	return list;
}
function runSummary(run: any, messageId: string): HTMLElement {
	const box = el('div', 'run-summary');
	box.dataset.messageId = messageId;
	const head = el('div', 'run-head');
	const kind = run.outcome?.kind;
	const badge = kind ? el('span', 'status-badge ' + kind, L.outcome[kind] || kind) : el('span', 'status-badge ' + run.status, L.run[run.status] || run.status);
	head.append(badge, el('span', 'muted', (run.planVersion === 0 ? L.directRun : format(L.plan, String(run.planVersion))) + (run.continued ? ' \u00b7 ' + L.continuedRun : '') + ' \u00b7 ' + providerName(run.provider) + ' \u00b7 ' + L.duration + ' ' + duration(run.durationMs)));
	box.append(head);
	const hint = outcomeHint(run.outcome);
	if (hint) { box.append(el('p', kind === 'failed' || kind === 'blocked' ? 'error-text' : 'muted', hint)); }
	box.append(el('div', 'run-files-slot'));
	if (run.steps?.length) {
		const summary = el('details', 'run-files');
		summary.append(el('summary', undefined, format(L.stepsSummary, String(run.steps.length))), stepList(run.steps));
		box.append(summary);
	}
	if (run.searches?.length) {
		const searches = el('details', 'run-files');
		searches.append(el('summary', undefined, format(L.searches, String(run.searches.length))));
		const list = el('ul', 'commands');
		for (const query of run.searches) { const item = el('li'); item.append(el('code', undefined, query)); list.append(item); }
		searches.append(list);
		box.append(searches);
	}
	box.append(el('h4', undefined, L.verification));
	if (run.verification.status === 'skipped') { box.append(el('p', 'muted', L.verificationSkipped)); }
	else {
		box.append(gateList(run.verification.gates));
		if (run.verification.error) { box.append(el('p', 'error-text', run.verification.error)); }
	}
	box.append(el('div', 'actions run-actions'));
	return box;
}
/** Only the latest run of the latest plan offers Continue or Retry, and only while the session allows it. */
function updateRunActions(): void {
	const current = state.chat?.run;
	for (const box of document.querySelectorAll<HTMLElement>('.run-summary')) {
		const actions = box.querySelector('.run-actions'); actions.textContent = '';
		if (!current || box.dataset.messageId !== current.messageId) { continue; }
		if (current.continuable) {
			const resume = el('button', 'approve', L.continueRun) as HTMLButtonElement; resume.type = 'button';
			resume.addEventListener('click', () => { resume.disabled = true; api.postMessage({ action: 'continue', messageId: current.messageId }); });
			actions.append(resume);
		}
		if (current.retryable && state.chat.plan) {
			const digest = state.chat.plan.digest;
			const retry = el('button', current.continuable ? 'secondary' : 'approve', L.retry) as HTMLButtonElement; retry.type = 'button';
			retry.addEventListener('click', () => { retry.disabled = true; api.postMessage({ action: 'approve', digest }); });
			actions.append(retry);
		}
		if (current.discardable) {
			const discard = el('button', 'secondary', L.discardRun) as HTMLButtonElement; discard.type = 'button';
			discard.addEventListener('click', () => api.postMessage({ action: 'discard', messageId: current.messageId }));
			actions.append(discard);
		}
		// Round trip with Inicio (AC): the same run, seen from the control center.
		const home = el('button', 'link-button', L.openHome) as HTMLButtonElement; home.type = 'button';
		home.addEventListener('click', () => api.postMessage({ action: 'openHome' }));
		actions.append(home);
	}
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
	if (message.run) { node.append(runSummary(message.run, message.id)); }
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
	updateRunActions();
	updateRunFiles();
}
/** Rebuilt only when what it shows changes, so a progress update never takes focus from a button. */
function updateRunFiles(): void {
	const messages = new Map<string, any>((state.chat?.messages ?? []).map(message => [message.id, message]));
	for (const box of document.querySelectorAll<HTMLElement>('.run-summary')) {
		const slot = box.querySelector<HTMLElement>('.run-files-slot'); const message = messages.get(box.dataset.messageId);
		if (!slot || !message) { continue; }
		const current = state.chat.run;
		const signature = JSON.stringify([message.run.reverted, message.run.outcome?.diff?.count, current?.messageId === message.id && current.discardable]);
		if (slot.dataset.signature === signature) { continue; }
		slot.dataset.signature = signature;
		const open = slot.querySelector('details')?.open;
		slot.textContent = '';
		const files = changedFiles(message, current);
		if (files) { (files as HTMLDetailsElement).open = !!open; slot.append(files); }
	}
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
	const queued = state?.chat?.queue?.length ? '. ' + format(L.queued, String(state.chat.queue.length)) : '';
	const phase = !activity ? '' : (activity.kind === 'thinking' ? format(L.thinking, providerName(activity.provider))
		: [L.stage[activity.stage], ...(activity.gates || []).filter(gate => gate.status !== 'pending').map(gate => gate.id + ': ' + (L.gate[gate.status] || gate.status))].join('. ')) + queued;
	if (phase === announced) { return; }
	announced = phase;
	document.getElementById('announcer').textContent = phase || L.idle;
}
function renderActivity(): void {
	const box = document.getElementById('activity');
	// Keep the reader's place in the timeline across rebuilds: follow the newest step only when already at the end.
	const before = box.querySelector<HTMLElement>('.steps');
	const following = !before || before.scrollHeight - before.scrollTop - before.clientHeight < 24;
	const scrolled = before?.scrollTop ?? 0;
	box.textContent = '';
	const activity = state.chat?.activity;
	announce(activity);
	window.clearInterval(ticker); ticker = undefined;
	if (!activity) { box.hidden = true; return; }
	box.hidden = false;
	const head = el('div', 'activity-head');
	const spinner = el('span', 'spinner'); spinner.setAttribute('aria-hidden', 'true');
	const title = activity.kind === 'thinking' ? format(L.thinking, providerName(activity.provider)) : (activity.planVersion === 0 ? format(L.executingDirect, providerName(activity.provider)) : format(L.executing, String(activity.planVersion), providerName(activity.provider)));
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
	if (activity.steps?.length) {
		const timeline = stepList(activity.steps);
		box.append(timeline);
		timeline.scrollTop = following ? timeline.scrollHeight : scrolled;
	}
	const queue: Array<{ id: string; text: string }> = state.chat.queue ?? [];
	if (queue.length) {
		const waiting = el('div', 'queue');
		waiting.append(el('p', 'muted', format(L.queued, String(queue.length)) + ' \u00b7 ' + L.queueHint));
		const list = el('ul', 'commands');
		for (const entry of queue) {
			const item = el('li', 'queued'); item.append(el('span', 'queued-text', entry.text));
			const remove = el('button', 'link-button', L.unqueue) as HTMLButtonElement; remove.type = 'button'; remove.setAttribute('aria-label', L.unqueue + ': ' + entry.text.slice(0, 60));
			remove.addEventListener('click', () => api.postMessage({ action: 'unqueue', id: entry.id }));
			item.append(remove); list.append(item);
		}
		waiting.append(list); box.append(waiting);
	}
	if (activity.observedBytes) { const bytes = el('p', 'muted', format(L.observed, String(Math.round(activity.observedBytes / 1024)))); bytes.setAttribute('aria-hidden', 'true'); box.append(bytes); }
	ticker = window.setInterval(() => { clock.textContent = elapsed(activity.startedAt); }, 1000);
}
let renderedApprovals = '';
/** One keyboard-reachable card per pending tool approval. Rebuilt only when the set changes, so progress updates never steal focus. */
function renderApprovals(): void {
	const box = document.getElementById('approvals');
	const pending: any[] = state.chat?.approvals ?? [];
	const questions: any[] = state.chat?.questions ?? [];
	const key = [...pending, ...questions].map(item => item.id).join(',');
	if (key === renderedApprovals) { return; }
	renderedApprovals = key; box.textContent = ''; box.hidden = !pending.length && !questions.length;
	for (const item of pending) {
		const card = el('div', 'approval' + (item.risk ? ' risk-' + item.risk : '')); card.setAttribute('role', 'group'); card.setAttribute('aria-labelledby', 'title-' + item.id); card.setAttribute('aria-describedby', 'rule-' + item.id);
		const title = el('strong', 'approval-title', item.title); title.id = 'title-' + item.id;
		// What, where (detail lines), for how long (the buttons) and how risky: the four things a card must say.
		const risk = el('p', 'approval-risk', item.risk ? L.risk[item.risk] ?? '' : ''); risk.id = 'risk-' + item.id; risk.hidden = !risk.textContent;
		const detail = el('ul', 'approval-detail'); for (const line of item.detail) { detail.append(el('li', undefined, line)); }
		// Without a rule the card says why it can only be allowed once, instead of silently hiding the other options.
		const rule = el('p', 'muted approval-rule', item.rule ? format(L.alwaysRule, item.rule, L.permissionsFile) : (L.noRemember[item.noRemember] ?? '')); rule.id = 'rule-' + item.id;
		if (item.global) { rule.textContent += ' ' + L.globalRule; }
		rule.hidden = !rule.textContent;
		const actions = el('div', 'approval-actions');
		for (const [answer, label, className] of [['once', L.allowOnce, ''], ['task', L.allowTask, 'secondary'], ['session', L.allowSession, 'secondary'], ['always', L.allowAlways, 'secondary'], ['global', L.allowGlobal, 'secondary'], ['deny', L.denyApproval, 'secondary']]) {
			if (answer !== 'once' && answer !== 'deny' && !item.rule) { continue; }
			if (answer === 'global' && !item.global) { continue; }
			const button = el('button', className, label) as HTMLButtonElement; button.type = 'button';
			button.addEventListener('click', () => { button.disabled = true; api.postMessage({ action: 'approval', id: item.id, answer }); });
			actions.append(button);
		}
		card.append(title, risk, detail, rule, actions); box.append(card);
	}
	for (const item of questions) { box.append(questionCard(item)); }
	if (pending.length || questions.length) {
		document.getElementById('announcer').textContent = pending.length ? pending[0].title : questions[0].questions[0].question;
		(box.querySelector('button, input') as HTMLElement | null)?.focus();
	}
}
/** One card per agent question set: options as radio buttons or checkboxes, an optional free answer, answer or skip. */
function questionCard(item: { id: string; questions: any[] }): HTMLElement {
	const card = el('form', 'approval question'); card.setAttribute('aria-label', L.questions);
	const read: Array<() => string[]> = [];
	item.questions.forEach((question, index) => {
		const group = el('fieldset', 'question-group');
		group.append(el('legend', 'approval-title', (question.header ? question.header + ': ' : '') + question.question));
		const name = item.id + '-' + index;
		const inputs: HTMLInputElement[] = [];
		for (const option of question.options) {
			const label = el('label', 'question-option');
			const input = document.createElement('input'); input.type = question.multiSelect ? 'checkbox' : 'radio'; input.name = name; input.value = option.label;
			label.append(input, document.createTextNode(' ' + option.label + (option.description ? ' \u2014 ' + option.description : '')));
			inputs.push(input); group.append(label);
		}
		let other: HTMLInputElement | undefined;
		if (question.allowOther) {
			other = document.createElement('input'); other.type = question.secret ? 'password' : 'text'; other.placeholder = L.questionOther; other.setAttribute('aria-label', L.questionOther); other.maxLength = 2000;
			group.append(other);
		}
		read.push(() => {
			const chosen = inputs.filter(input => input.checked).map(input => input.value);
			const free = other?.value.trim();
			return free ? (question.multiSelect ? [...chosen, free] : [free]) : chosen;
		});
		card.append(group);
	});
	const actions = el('div', 'approval-actions');
	const send = el('button', '', L.questionSend) as HTMLButtonElement; send.type = 'submit';
	const skip = el('button', 'secondary', L.questionSkip) as HTMLButtonElement; skip.type = 'button';
	skip.addEventListener('click', () => { skip.disabled = true; api.postMessage({ action: 'questionSkip', id: item.id }); });
	card.addEventListener('submit', event => {
		event.preventDefault();
		const answers = Object.fromEntries(item.questions.map((question, index) => [question.id, read[index]()]));
		if (Object.values(answers).some(values => !values.length)) { return; }
		send.disabled = true;
		api.postMessage({ action: 'question', id: item.id, answers });
	});
	actions.append(send, skip); card.append(actions);
	return card;
}
function renderComposer(): void {
	const running = busy();
	const send = document.getElementById('send') as HTMLButtonElement;
	send.textContent = running ? L.queueSend : L.send; send.disabled = !state.chat || (running && (state.chat.queue?.length ?? 0) >= 5);
	const stop = document.getElementById('stop') as HTMLButtonElement;
	stop.hidden = !running; stop.disabled = !!state.chat?.activity?.cancelling;
	stop.textContent = state.chat?.activity?.cancelling ? L.cancelling : L.cancel; stop.title = L.stopHint;
	(document.getElementById('prompt') as HTMLTextAreaElement).disabled = !state.chat;
	document.getElementById('composer').setAttribute('aria-busy', String(running));
	const banner = document.getElementById('banner');
	const text = !state.project ? L.noProject : !state.trusted ? L.untrusted : state.chat && !state.chat.writer ? L.hybrid : '';
	banner.textContent = text; banner.hidden = !text;
}
function render(): void {
	const log = document.getElementById('log');
	const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
	renderHeader(); renderThread(); renderEmpty(); renderApprovals(); renderActivity(); renderComposer();
	if (pinned) { log.scrollTop = log.scrollHeight; }
}

window.addEventListener('message', event => {
	const data = event.data;
	if (data?.type === 'completions' && data.kind === 'mention') { suggest?.complete(data); return; }
	if (data?.type === 'init') { L = data.labels; shell(); if (state) { render(); } return; }
	if (data?.type === 'state') {
		if (data.chat && data.chat.messages === undefined) { data.chat.messages = state?.chat?.messages ?? []; }
		state = data;
		if (L) { render(); }
	}
});
api.postMessage({ action: 'ready' });
