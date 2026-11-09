/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Browser probe of the AI Accounts editor tab: states in words, long aliases, keyboard focus, closed operations, narrow windows. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { launchBrowser, theme } = require('./chat-webview-fixture.cts');
const { accountsHtml, accountsLabels } = require('../src/accounts-panel.ts');

const root = path.resolve(__dirname, '..');
const t = text => text.replace(/\{(\d+)\}/g, (_, index) => String(index));
const script = stripTypeScriptTypes(fs.readFileSync(path.join(root, 'resources/accounts.ts'), 'utf8'));
const css = fs.readFileSync(path.join(root, 'resources/accounts.css'), 'utf8');
// The production page carries a strict CSP; the probe injects tokens and CSS inline, so only that meta tag is removed.
const page = accountsHtml(text => text, 'self', 'nonce', '', '').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace('<link rel="stylesheet" href="">', '<style>' + theme + css + '</style>').replace(/<script[^>]*><\/script>/, '');

const providers = (long) => [
	{ id: 'claude', label: 'Claude Code', accounts: [
		{ id: 'a', alias: 'Personal', provider: 'claude', state: 'authenticated', isDefault: true, here: true, workspaces: ['tienda'] },
		{ id: 'b', alias: long ? 'Cuenta profesional del estudio con un alias extraordinariamente largo para forzar el ajuste de linea' : 'Trabajo', provider: 'claude', state: 'not-authenticated', isDefault: false, here: false, workspaces: [] }
	] },
	{ id: 'codex', label: 'OpenAI Codex', accounts: [] }
];

async function mount(browser, width, long) {
	const tab = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
	await tab.setContent(page);
	await tab.evaluate(code => { window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: value => window.sent.push(value) }); new Function(code)(); }, script);
	const push = value => tab.evaluate(message => window.postMessage(message, '*'), value).then(() => tab.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))));
	await push({ type: 'init', labels: accountsLabels(t) });
	await push({ type: 'state', root: 'demo', providers: providers(long) });
	return { tab, push };
}

test('accounts are drawn with their real state in words, an empty provider explains itself, and nothing overflows on a narrow window', async () => {
	const browser = await launchBrowser();
	try {
		const { tab } = await mount(browser, 360, true);
		const view = await tab.evaluate(() => ({
			ready: window.sent[0], cards: [...document.querySelectorAll('.card')].map(card => ({ name: card.querySelector('h3').textContent.slice(0, 12), state: card.querySelector('.state').textContent, badges: [...card.querySelectorAll('.badge')].map(badge => badge.textContent) })),
			empty: document.querySelector('.empty strong').textContent, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
		}));
		assert.deepEqual(view, {
			ready: { action: 'ready' },
			cards: [{ name: 'Personal', state: '\u2713Autenticada', badges: ['Predeterminada', 'Este workspace'] }, { name: 'Cuenta profe', state: '!Sin sesi\u00f3n', badges: [] }],
			empty: 'Sin cuentas', overflow: false
		});
	} finally { await browser.close(); }
});

test('operations are a closed set on a profile id, the default button is disabled for the default, and keyboard focus survives a redraw', async () => {
	const browser = await launchBrowser();
	try {
		const { tab, push } = await mount(browser, 900, false);
		await tab.focus('[data-key="rename:b"]');
		await tab.keyboard.press('Enter');
		await tab.click('[data-key="assign:b"]');
		await tab.click('#add');
		const sent = await tab.evaluate(() => window.sent.slice(1));
		await tab.focus('[data-key="remove:b"]');
		await push({ type: 'busy' });
		await push({ type: 'state', root: 'demo', providers: providers(false) });
		const after = await tab.evaluate(() => ({ focused: document.activeElement.dataset.key, defaultDisabled: document.querySelector('[data-key="default:a"]').disabled, otherEnabled: !document.querySelector('[data-key="default:b"]').disabled, stop: document.querySelector('[data-key="assign:a"]').textContent }));
		assert.deepEqual({ sent, after }, {
			sent: [{ action: 'op', op: 'rename', id: 'b' }, { action: 'op', op: 'assign', id: 'b' }, { action: 'add' }],
			after: { focused: 'remove:b', defaultDisabled: true, otherEnabled: true, stop: 'Dejar de usar aqu\u00ed' }
		});
	} finally { await browser.close(); }
});

test('a window with several folders shows a folder picker and tells the host which one to manage', async () => {
	const browser = await launchBrowser();
	try {
		const { tab, push } = await mount(browser, 900, false);
		const single = await tab.evaluate(() => document.getElementById('folder').hidden);
		await push({ type: 'state', root: 'api', rootPath: '/w/api', folders: [{ name: 'web', path: '/w/web' }, { name: 'api', path: '/w/api' }], providers: providers(false) });
		await tab.selectOption('#folder', '/w/web');
		const shown = await tab.evaluate(() => ({ hidden: document.getElementById('folder').hidden, label: document.getElementById('folder').getAttribute('aria-label'), options: [...document.getElementById('folder').options].map(option => option.textContent), sent: window.sent.at(-1) }));
		assert.deepEqual({ single, shown }, { single: true, shown: { hidden: false, label: 'Carpeta que se administra', options: ['Carpeta que se administra', 'web', 'api'], sent: { action: 'root', path: '/w/web' } } });
	} finally { await browser.close(); }
});
