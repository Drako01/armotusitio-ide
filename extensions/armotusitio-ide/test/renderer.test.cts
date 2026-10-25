/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Isolated browser probes of the shipped renderer. No IDE window or user profile is controlled. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const { chromium } = require('playwright-core');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const noop = () => ({ dispose() {} });
async function main() {
	const commands = new Map();
	let state, receive;
	const panel = { reveal() {}, onDidDispose: noop, webview: { cspSource: 'https://audit.invalid', asWebviewUri: value => value, onDidReceiveMessage: fn => { receive = fn; return noop(); }, postMessage: value => { state = value; } } };
	const vscode = { l10n: { t: value => value }, ViewColumn: { One: 1 }, Uri: { joinPath: (base, ...parts) => base + '/' + parts.join('/') }, workspace: { isTrusted: true, onDidGrantWorkspaceTrust: noop }, window: { createWebviewPanel: () => panel }, commands: { registerCommand: (id, fn) => { commands.set(id, fn); return noop(); }, executeCommand() {} } };
	const workspace = { views: () => [], toolResult: () => undefined, receive: async () => false };
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(path.join(root, 'src/home.ts'), 'utf8'), { module, require: name => name === 'vscode' ? vscode : name === './workspace.ts' ? { createWorkspace: () => workspace } : require(name) });
	module.exports.registerHome({ extensionUri: 'https://audit.invalid', subscriptions: [] }, { getProvider: async () => ({ label: 'Codex', supported: true }), getHistory: () => [], progress: [], onDidChangeTreeData: noop }, async () => [{ profile: { id: 'redevent', name: 'RedEvent', root: '/repo', actions: [], workflow: true, tools: [] } }]);
	commands.get('atsIde.home')(); await receive({ action: 'ready' });
	let html = panel.webview.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<script[^>]*src=[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
	html = html.replace('</head>', '<style>:root{--vscode-editor-background:#181818;--vscode-editor-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#333;--vscode-font-family:Segoe UI;--vscode-button-background:#0078d4;--vscode-button-foreground:white;--vscode-button-secondaryBackground:#333;--vscode-input-background:#222;--vscode-input-foreground:#eee;--vscode-progressBar-background:#0078d4;--vscode-editorWarning-foreground:#d7ba7d;--vscode-textLink-foreground:#4daafc}' + fs.readFileSync(path.join(root, 'resources/home.css'), 'utf8') + '</style></head>');
	html = html.replace(/<img[^>]*>/g, '');
	const sources = Object.fromEntries(['home', 'workflow', 'tools', 'reconcile'].map(name => ['./' + name + '.ts', stripTypeScriptTypes(fs.readFileSync(path.join(root, 'resources/' + name + '.ts'), 'utf8'))]));
	sources['../src/presentation.ts'] = stripTypeScriptTypes(fs.readFileSync(path.join(root, 'src/presentation.ts'), 'utf8'));
	const browser = await chromium.launch({ headless: true, ...(process.env.ATS_TEST_BROWSER ? { executablePath: process.env.ATS_TEST_BROWSER } : process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : { channel: 'chrome' }) });
	const results = [];
	try {
		const page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, reducedMotion: 'reduce' });
		await page.setContent(html);
		await page.evaluate(sources => {
			window.atsMessages = [];
			let saved; window.acquireVsCodeApi = () => ({ postMessage: value => window.atsMessages.push(value), getState: () => saved, setState: value => { saved = value; } });
			const cache = {};
			const load = name => { if (cache[name]) { return cache[name].exports; } const module = { exports: {} }; cache[name] = module; new Function('module', 'require', sources[name])(module, load); return module.exports; };
			load('./home.ts');
		}, sources);
		const push = async () => { await page.evaluate(value => window.postMessage(value, '*'), state); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))); };
		const entry = { id: 'active', nativeId: 'native-active', title: 'Tarea activa de auditor\u00eda', project: '/repo', phase: 'running', host: 'codex', owned: true, checkedAt: Date.now(), questions: [], warnings: [{ id: 'dirty-tree', blocking: false, message: 'Synthetic warning', hint: 'Review local changes' }], progress: { state: 'running', live: true, percent: 63, nodes: [{ id: 'reviewer', agent: 'reviewer', status: 'running' }] } };
		state.workflows = [entry]; await push();
		const details = page.locator('#workflow-runs details[data-key="warnings"]');
		await details.locator('summary').first().click();
		assert.equal(await details.getAttribute('open'), '');
		const stop = page.locator('button[data-workflow-action="stopTask"]'); await stop.focus();
		await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#workflow-runs h3')); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
		entry.checkedAt += 3000; entry.progress.percent = 64; await push();
		assert.equal(await details.getAttribute('open'), '');
		assert.equal(await stop.evaluate(node => node === document.activeElement), true);
		assert.equal(await page.evaluate(() => getSelection().toString()), entry.title);
		await page.evaluate(now => { Date.now = () => now; }, entry.checkedAt + 16000); await push();
		assert.equal(await page.getByText(state.labels.workflow.stale, { exact: true }).isVisible(), true);
		const older = { ...entry, id: 'old', nativeId: 'old-native', title: 'Registro anterior sin proceso activo', phase: 'interrupted', owned: false, progress: { state: 'stalled', live: false, percent: 24, nodes: [] }, restored: true };
		state.workflows = [entry, older]; await push();
		assert.equal(await page.locator('#workflow-runs article h3').first().textContent(), entry.title);
		await stop.click(); await stop.dispatchEvent('click');
		assert.equal(await page.evaluate(() => window.atsMessages.filter(message => message.action === 'stopTask').length), 1);
		const question = { ...entry, id: 'question', nativeId: undefined, phase: 'questions', checkedAt: Date.now(), questions: [{ id: 'scope', question: '\u00bfQu\u00e9 alcance quer\u00e9s verificar?', options: [] }] };
		state.workflows.push(question); await push();
		const input = page.locator('input[name="scope"]'); await input.fill('Respuesta sin enviar'); await input.focus();
		entry.checkedAt += 3000; await push();
		assert.equal(await input.inputValue(), 'Respuesta sin enviar');
		assert.equal(await input.evaluate(node => node === document.activeElement), true);
		await page.getByPlaceholder(state.labels.workflow.search).fill('Registro anterior');
		assert.equal(await page.locator('#workflow-runs article').count(), 1);
		await page.getByPlaceholder(state.labels.workflow.search).fill('');
		entry.progress.nodes = Array.from({ length: 100 }, (_, index) => ({ id: 'node-' + index, agent: 'verifier', domain: 'api', status: 'running' }));
		state.workflows = [entry]; await push();
		const timings = await page.evaluate(state => {
			const times = []; for (let index = 0; index < 60; index++) { const start = performance.now(); state.workflows[0].progress.percent = index; window.dispatchEvent(new MessageEvent('message', { data: state })); times.push(performance.now() - start); } return times.sort((a,b) => a-b);
		}, state);
		assert.ok(timings[56] < 150, '100-node renderer p95 must stay under 150ms');
		const artifacts = path.resolve(root, '../../.build/harness-upgrade'); fs.mkdirSync(artifacts, { recursive: true });
		const themes = {
			dark: '--vscode-editor-background:#181818;--vscode-editor-foreground:#ddd;--vscode-foreground:#ddd;--vscode-focusBorder:#0078d4;--vscode-button-secondaryForeground:#ddd;--vscode-list-hoverBackground:#2a2d2e',
			light: '--vscode-editor-background:#fff;--vscode-editor-foreground:#222;--vscode-foreground:#222;--vscode-descriptionForeground:#555;--vscode-input-background:#fff;--vscode-input-foreground:#222;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#222;--vscode-panel-border:#ccc;--vscode-focusBorder:#005fb8;--vscode-list-hoverBackground:#eee',
			contrast: '--vscode-editor-background:#000;--vscode-editor-foreground:#fff;--vscode-foreground:#fff;--vscode-descriptionForeground:#fff;--vscode-input-background:#000;--vscode-input-foreground:#fff;--vscode-button-background:#000;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#000;--vscode-button-secondaryForeground:#fff;--vscode-button-border:#fff;--vscode-panel-border:#fff;--vscode-focusBorder:#f38518;--vscode-list-hoverBackground:#222'
		};
		for (const [name, tokens] of Object.entries(themes)) {
			await page.addStyleTag({ content: ':root{' + tokens + '}' });
			for (const width of [320, 640, 1200]) {
				await page.setViewportSize({ width, height: 1000 });
				assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}/${width}: horizontal overflow`);
				assert.equal(await page.locator('button').evaluateAll(buttons => buttons.every(button => (button.textContent || '').trim() || button.getAttribute('aria-label'))), true);
				await page.screenshot({ path: path.join(artifacts, `${name}-${width}.png`), fullPage: true });
			}
		}
		fs.writeFileSync(path.join(artifacts, 'renderer-results.json'), JSON.stringify({ mode: 'real renderer, synthetic bridge, headless Chrome', assertions: ['stable focus and open details', 'time-driven stale warning', 'live activity first', 'duplicate click blocked', 'unsent answers preserved', 'search', 'responsive themes'], render100Nodes: { samples: 60, p95Ms: timings[56] } }, null, 2));

	} finally { await browser.close(); }
}
test('real renderer preserves interaction and provides responsive accessible controls', main);
