/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Browser probe: the Chat Harness fills the editor area; only the message list scrolls, the page and the composer never do. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const { state, at, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

test('the header and the composer stay inside the view even when the page itself is scrolled by script', async () => {
	const browser = await launchBrowser();
	try {
		for (const viewport of [{ width: 1100, height: 700 }, { width: 520, height: 520 }]) {
			const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
			const push = await mountChat(page);
			const busy = { kind: 'executing', provider: 'claude', startedAt: new Date().toISOString(), observedBytes: 0, stage: 'agent', planVersion: 0, gates: [] };
			const value = state(busy);
			value.chat.messages = Array.from({ length: 40 }, (_, index) => ({ id: 'm' + index, role: index % 2 ? 'assistant' : 'user', provider: 'claude', text: 'linea '.repeat(60) + index, at }));
			await push(value);
			// Worst case: something taller than the view ends up in the page, and the page is scrolled by script (focus, scrollIntoView).
			await page.evaluate(() => { const filler = document.createElement('div'); filler.style.height = '3000px'; document.body.append(filler); window.scrollTo(0, 3000); document.getElementById('log').scrollIntoView(); });
			const metrics = await page.evaluate(() => {
				const list = document.getElementById('log'), composer = document.querySelector('.composer').getBoundingClientRect(), header = document.querySelector('.topbar').getBoundingClientRect();
				return { listScrolls: list.scrollHeight > list.clientHeight, composerInside: composer.bottom <= window.innerHeight + 1 && composer.top >= 0, headerInside: header.top >= 0 };
			});
			await page.close();
			assert.deepEqual({ viewport, metrics }, { viewport, metrics: { listScrolls: true, composerInside: true, headerInside: true } });
		}
	} finally { await browser.close(); }
});
