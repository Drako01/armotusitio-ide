/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Shared fixture for browser probes of the shipped Chat Harness webview: the real CSS and renderer in Chromium. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
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

/** Chrome from the environment: ATS_TEST_BROWSER, the Windows install or the `chrome` channel. */
function launchBrowser() {
	return chromium.launch({ headless: true, ...(process.env.ATS_TEST_BROWSER ? { executablePath: process.env.ATS_TEST_BROWSER } : process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : { channel: 'chrome' }) });
}

/** Load the webview in a page and return a `push` that delivers host messages like VS Code does. */
async function mountChat(page, themeCss) {
	await page.setContent(themeCss ? html.replace(theme, themeCss) : html);
	await page.evaluate(code => {
		window.sent = [];
		window.acquireVsCodeApi = () => ({ postMessage: value => window.sent.push(value) });
		const cache = {};
		const load = name => { if (cache[name]) { return cache[name].exports; } const module = { exports: {} }; cache[name] = module; new Function('module', 'require', code[name])(module, load); return module.exports; };
		load('./chat.ts');
	}, sources);
	const push = async value => { await page.evaluate(message => window.postMessage(message, '*'), value); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))); };
	await push({ type: 'init', labels: labels(t) });
	return push;
}

module.exports = { html, theme, state, t, plan, at, launchBrowser, mountChat };
