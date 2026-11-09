/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* AI Accounts webview. It only draws what the host sends (text nodes, never HTML) and posts a closed set of operations. */
const vscodeApi = acquireVsCodeApi();
let labels: any;
let current: any;
let loading = true;
/** Redundant with color: every state has a symbol and a word. */
const SYMBOLS: Record<string, string> = { authenticated: '\u2713', 'not-authenticated': '!', unknown: '?', 'cli-unavailable': '\u2715' };

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) { node.className = className; }
	if (text !== undefined) { node.textContent = text; }
	return node;
}

function format(template: string, ...values: Array<string | number>): string {
	return template.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)]));
}

function button(label: string, className: string, key: string, onClick: () => void): HTMLButtonElement {
	const node = el('button', className, label) as HTMLButtonElement;
	node.type = 'button';
	node.dataset.key = key;
	node.addEventListener('click', onClick);
	return node;
}

function card(account: any): HTMLElement {
	const node = el('article', 'card');
	const heading = el('h3', 'alias', account.alias); heading.id = 'alias-' + account.id;
	node.setAttribute('aria-labelledby', heading.id);
	const badges = el('div', 'badges');
	if (account.isDefault) { badges.append(el('span', 'badge', labels.isDefault)); }
	if (account.here) { badges.append(el('span', 'badge accent', labels.here)); }
	const state = el('p', 'state state-' + account.state);
	const symbol = el('span', 'symbol', loading ? '\u2026' : SYMBOLS[account.state] ?? '?'); symbol.setAttribute('aria-hidden', 'true');
	state.append(symbol, el('span', undefined, loading ? labels.checking : labels.states[account.state] ?? account.state));
	const where = el('p', 'muted workspaces', labels.workspace + ': ' + (account.workspaces.length ? account.workspaces.join(', ') : labels.noWorkspace));
	const actions = el('div', 'actions');
	const post = (op: string) => () => vscodeApi.postMessage({ action: 'op', op, id: account.id });
	actions.append(
		button(labels.signIn, '', 'signIn:' + account.id, post('signIn')),
		button(labels.makeDefault, 'quiet', 'default:' + account.id, post('default')),
		button(account.here ? labels.stopHere : labels.useHere, 'quiet', 'assign:' + account.id, post(account.here ? 'unassign' : 'assign')),
		button(labels.rename, 'quiet', 'rename:' + account.id, post('rename')),
		button(labels.remove, 'destructive', 'remove:' + account.id, post('remove'))
	);
	if (account.isDefault) { (actions.querySelector('[data-key^="default:"]') as HTMLButtonElement).disabled = true; }
	node.append(heading, badges, state, where, actions);
	return node;
}

function render(): void {
	if (!labels || !current) { return; }
	// Re-drawing replaces the nodes: put the focus back on the same control so keyboard use is not interrupted.
	const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
	document.getElementById('accounts-description')!.textContent = labels.description;
	const total = current.providers.reduce((sum: number, provider: any) => sum + provider.accounts.length, 0);
	document.getElementById('accounts-summary')!.textContent = current.root ? format(labels.summary, total, current.providers.length) + ' \u00b7 ' + current.root : format(labels.summary, total, current.providers.length);
	const add = document.getElementById('add') as HTMLButtonElement; add.textContent = labels.add;
	const refresh = document.getElementById('refresh') as HTMLButtonElement; refresh.textContent = labels.refresh; refresh.disabled = loading; refresh.setAttribute('aria-busy', String(loading));
	const root = document.getElementById('providers')!;
	root.textContent = '';
	for (const provider of current.providers) {
		const section = el('section', 'provider'); section.setAttribute('aria-labelledby', 'provider-' + provider.id);
		const head = el('div', 'provider-head');
		const title = el('h2', undefined, provider.label); title.id = 'provider-' + provider.id;
		head.append(title, el('span', 'muted', String(provider.accounts.length)));
		section.append(head);
		if (!provider.accounts.length) {
			const empty = el('div', 'empty'); empty.append(el('strong', undefined, labels.empty), el('p', 'muted', labels.emptyHint)); section.append(empty);
		} else {
			const grid = el('div', 'grid'); for (const account of provider.accounts) { grid.append(card(account)); } section.append(grid);
		}
		root.append(section);
	}
	if (focused) { (document.querySelector('[data-key="' + CSS.escape(focused) + '"]') as HTMLElement | null)?.focus(); }
}

window.addEventListener('message', event => {
	const message = event.data;
	if (message?.type === 'init') { labels = message.labels; render(); }
	if (message?.type === 'busy') { loading = true; render(); }
	if (message?.type === 'state') { current = message; loading = false; render(); }
});
document.getElementById('add')!.addEventListener('click', () => vscodeApi.postMessage({ action: 'add' }));
document.getElementById('refresh')!.addEventListener('click', () => vscodeApi.postMessage({ action: 'refresh' }));
vscodeApi.postMessage({ action: 'ready' });
