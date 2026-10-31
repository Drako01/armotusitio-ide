/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Browser probes of the shipped Chat Harness webview: keyboard, screen-reader semantics, safe rendering and layout. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { stripTypeScriptTypes } = require('node:module');
const { chromium } = require('playwright-core');
const { labels } = require('../src/chat.ts');

const root = path.resolve(__dirname, '..');
const theme = ':root{--vscode-editor-background:#1f1f1f;--vscode-foreground:#ccc;--vscode-descriptionForeground:#9d9d9d;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-input-background:#313131;--vscode-focusBorder:#0078d4}';
const html = '<!doctype html><html lang="es-AR"><head><meta charset="utf-8"><style>' + theme + fs.readFileSync(path.join(root, 'resources/chat.css'), 'utf8') + '</style></head><body><div id="app" class="chat-app" data-logo=""></div></body></html>';
const sources = Object.fromEntries(['chat', 'markdown'].map(name => ['./' + name + '.ts', stripTypeScriptTypes(fs.readFileSync(path.join(root, 'resources/' + name + '.ts'), 'utf8'))]));
const t = (text, ...args) => text.replace(/\{(\d+)\}/g, (_, index) => String(args[index]));
const plan = { version: 1, digest: 'd'.repeat(64), title: 'CRUD', summary: '', steps: ['Modelo'], files: [], risks: [], skills: [] };
const at = new Date().toISOString();
const state = activity => ({
	type: 'state', trusted: true, project: { name: 'demo', id: 'a' }, projects: [{ name: 'demo', id: 'a' }],
	providers: { codex: { status: 'ready', version: '1' }, claude: { status: 'ready', version: '2' } },
	models: { claude: { options: [{ id: 'opus', label: 'Opus' }, { id: 'claude-opus-5-5', label: 'Opus 5.5' }], selected: 'claude-opus-5-5' }, codex: { options: [], selected: '' } },
	efforts: { claude: 'medium', codex: '' },
	mcp: { state: 'connected', tools: 3, endpoint: 'armotusitio.com.ar', enabled: true, checkedAt: at },
	chat: {
		provider: 'claude', revision: 1, writer: true, verification: [{ id: 'unit', command: 'npm test' }],
		messages: [
			{ id: 'u1', role: 'user', text: 'CRUD', at },
			{ id: 'a1', role: 'assistant', provider: 'claude', text: 'Plan:\n\n```html\n<script>window.pwned = true</script><img src=x onerror="window.pwned=true">\n```\n\n[link](javascript:alert(1)) <b>bold</b>', plan, at }
		],
		plan: { messageId: 'a1', version: 1, digest: plan.digest, approvable: true }, activity
	}
});

test('Chat Harness webview is keyboard operable, announces phases only and renders model output inertly', async () => {
	const browser = await chromium.launch({ headless: true, ...(process.env.ATS_TEST_BROWSER ? { executablePath: process.env.ATS_TEST_BROWSER } : process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : { channel: 'chrome' }) });
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		await page.setContent(html);
		await page.evaluate(code => {
			window.sent = [];
			window.acquireVsCodeApi = () => ({ postMessage: value => window.sent.push(value) });
			const cache = {};
			const load = name => { if (cache[name]) { return cache[name].exports; } const module = { exports: {} }; cache[name] = module; new Function('module', 'require', code[name])(module, load); return module.exports; };
			load('./chat.ts');
		}, sources);
		const push = async value => { await page.evaluate(message => window.postMessage(message, '*'), value); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))); };
		await push({ type: 'init', labels: labels(t) });
		await push(state(undefined));

		// Model output: no element, handler or navigation is ever created from text.
		assert.deepEqual(await page.evaluate(() => ({ pwned: window.pwned === true, scripts: document.querySelectorAll('#thread script, #thread img, #thread a, #thread b').length })), { pwned: false, scripts: 0 });

		// Version and reasoning effort are separate accessible selectors.
		assert.equal(await page.locator('#model').inputValue(), 'claude-opus-5-5');
		assert.equal(await page.locator('#effort').inputValue(), 'medium');
		assert.match(await page.getAttribute('#effort', 'aria-label'), /Razonamiento de Claude/);
		await page.selectOption('#effort', 'low');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'effort', provider: 'claude', effort: 'low' });
		// Provider selector follows the radio-group pattern: one tab stop, arrows change the selection.
		await page.focus('.provider-option[aria-checked="true"]');
		await page.keyboard.press('ArrowLeft');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'provider', provider: 'codex' });
		assert.deepEqual(await page.$$eval('.provider-option', nodes => nodes.map(node => node.tabIndex)), [-1, 0]);

		// Popovers expose their state, and Escape returns focus to the control that opened them.
		await page.click('#mcp-pill');
		assert.equal(await page.getAttribute('#mcp-pill', 'aria-expanded'), 'true');
		await page.keyboard.press('Escape');
		assert.deepEqual(await page.evaluate(() => ({ hidden: document.getElementById('mcp-details').hidden, focus: document.activeElement.id })), { hidden: true, focus: 'mcp-pill' });
		assert.equal(await page.locator('#menu [role="menuitem"]').count(), 0);

		// Plan approval is a described, focusable control that posts the exact digest.
		const approve = page.locator('.plan-card .approve');
		const describedBy = await approve.getAttribute('aria-describedby');
		assert.equal(await page.locator('#' + describedBy).count(), 1);
		await approve.focus(); await page.keyboard.press('Enter');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'approve', digest: 'd'.repeat(64) });

		// Composer: Enter sends, Shift+Enter inserts a line break.
		await page.fill('#prompt', 'primera');
		await page.keyboard.press('Shift+Enter');
		await page.focus('#prompt'); await page.keyboard.press('Shift+Enter');
		assert.equal(await page.evaluate(() => window.sent.filter(item => item.action === 'send').length), 0);
		await page.keyboard.press('Enter');
		assert.equal(await page.evaluate(() => window.sent.at(-1).action), 'send');

		// Live activity: timers are hidden from assistive technology and outside the log region; phases are announced once.
		await push(state({ kind: 'executing', provider: 'claude', startedAt: at, observedBytes: 9000, stage: 'verifying', planVersion: 1, gates: [{ id: 'unit', status: 'running' }] }));
		const live = await page.evaluate(() => ({
			inLog: !!document.querySelector('[role="log"] #activity, [role="log"] #announcer, [aria-live] #activity'),
			clockHidden: document.querySelector('#activity .clock').getAttribute('aria-hidden'),
			announcer: document.getElementById('announcer').textContent,
			stopVisible: !document.getElementById('stop').hidden
		}));
		assert.deepEqual(live, { inLog: false, clockHidden: 'true', announcer: 'Ejecutando verificaciones. unit: En curso', stopVisible: true });
		await push(state({ kind: 'executing', provider: 'claude', startedAt: at, observedBytes: 18000, stage: 'verifying', planVersion: 1, gates: [{ id: 'unit', status: 'running' }], cancelling: true }));
		assert.deepEqual(await page.evaluate(() => ({ announcer: document.getElementById('announcer').textContent, stop: document.getElementById('stop').disabled })), { announcer: 'Ejecutando verificaciones. unit: En curso', stop: true });

		// Progress-only updates omit the history; the rendered conversation must not be lost.
		const progressOnly = state({ kind: 'thinking', provider: 'claude', startedAt: at, observedBytes: 100 });
		delete progressOnly.chat.messages;
		await push(progressOnly);
		assert.equal(await page.locator('#thread article').count(), 2);

		// Narrow layout (phone width): no horizontal page scroll.
		await page.setViewportSize({ width: 360, height: 800 });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	} finally { await browser.close(); }
});
