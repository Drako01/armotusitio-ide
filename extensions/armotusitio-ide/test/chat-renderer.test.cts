/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Browser probes of the shipped Chat Harness webview: keyboard, screen-reader semantics, safe rendering and layout. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const { state, t, plan, at, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

test('Chat Harness webview is keyboard operable, announces phases only and renders model output inertly', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
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
