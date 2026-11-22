/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { state, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

test('provider states use distinct visible symbols and full accessible names, with a named active provider', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 320, height: 800 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const value = state();
		const symbols = [];
		for (const status of ['ready', 'unauthenticated', 'unavailable', 'incompatible', 'unknown', 'checking']) {
			value.providers.codex = { status, version: '1.2.3' }; await push(value);
			const radio = page.locator('[data-provider="codex"]');
			const label = await radio.getAttribute('aria-label');
			assert.equal(label, await radio.getAttribute('title'));
			assert.match(label, /^Codex .*v1\.2\.3$/);
			const marker = radio.locator('.provider-status');
			assert.equal(await marker.isVisible(), true);
			symbols.push(await marker.textContent());
		}
		assert.equal(new Set(symbols).size, 6);
		assert.equal(await page.locator('#provider-identity').textContent(), 'Claude Code');
		await page.focus('[data-provider="claude"]'); await page.keyboard.press('ArrowRight');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'provider', provider: 'codex' });
		value.chat.provider = 'codex'; await push(value);
		assert.equal(await page.locator('#provider-identity').textContent(), 'Codex');
		assert.equal(await page.locator('[data-provider="codex"]').getAttribute('aria-checked'), 'true');
	} finally { await browser.close(); }
});

test('full access stays a native keyboard switch and restores its visual position when the host rejects activation', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const value = state(); value.chat.provider = 'codex'; value.codexFullAccess = false;
		await push(value);
		const toggle = page.locator('#sandbox-full');
		const thumb = () => page.locator('.switch-thumb').evaluate(node => getComputedStyle(node).transform);
		const before = await thumb();
		await toggle.focus(); await page.keyboard.press('Space');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'sandbox', full: true });
		assert.equal(await toggle.isChecked(), true); assert.notEqual(await thumb(), before);
		// The real host republishes the configured value when its safety dialog is cancelled.
		await push(value);
		assert.equal(await toggle.isChecked(), false); assert.equal(await thumb(), before);
		value.codexFullAccess = true; await push(value);
		assert.equal(await toggle.isChecked(), true);
		await toggle.focus(); await page.keyboard.press('Space');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'sandbox', full: false });
	} finally { await browser.close(); }
});

test('header controls wrap inside narrow views without clipped targets even with long names and quota details', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 320, height: 800 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const value = state(); value.chat.provider = 'codex';
		value.project.name = 'Proyecto con un nombre muy largo para el panel lateral';
		value.models.codex = { options: [{ id: 'long', label: 'Modelo con un nombre extraordinariamente largo' }], selected: 'long' };
		value.accounts = { codex: { options: [{ id: 'long', alias: 'Cuenta con un nombre extraordinariamente largo', state: 'authenticated' }], selected: 'long' } };
		value.chat.quota = { codex: { windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 82, resetsAt: Math.floor(Date.now() / 1000) + 172800 }] } };
		await push(value);
		assert.equal(await page.locator('#quota').isVisible(), true);
		for (const width of [320, 480, 900, 1440, 1920]) {
			await page.setViewportSize({ width, height: 800 });
			const clipped = await page.locator('.topbar button, .topbar select, .topbar input, .provider-status').evaluateAll(nodes => nodes.filter(node => {
				const box = node.getBoundingClientRect();
				return box.width > 0 && (box.left < 0 || box.right > innerWidth || box.bottom > document.querySelector('.topbar').getBoundingClientRect().bottom);
			}).map(node => node.id || node.className));
			assert.deepEqual(clipped, [], 'controls fit at ' + width);
			const overlaps = await page.locator('.topbar button:not(#menu-button), .topbar select, .topbar input, .brand-text').evaluateAll(nodes => {
				const menu = document.getElementById('menu-button').getBoundingClientRect();
				return nodes.filter(node => {
					const box = node.getBoundingClientRect();
					return box.width > 0 && box.left < menu.right && box.right > menu.left && box.top < menu.bottom && box.bottom > menu.top;
				}).map(node => node.id || node.className);
			});
			assert.deepEqual(overlaps, [], 'menu does not cover controls at ' + width);
		}
	} finally { await browser.close(); }
});
