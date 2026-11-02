/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Browser probe of the tool approval card in the shipped Chat Harness webview: content, names, keyboard and messages. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const { state, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

const busy = { kind: 'executing', provider: 'claude', startedAt: new Date().toISOString(), observedBytes: 0, stage: 'agent', planVersion: 0, gates: [] };
const card = { id: 'ap-0123456789abcdef', kind: 'git_commit', title: 'Hacer commit', detail: ['branch: feat/x', 'files: src/a.ts', 'message: <b>fix</b> the thing'], rule: 'git_commit' };
const withApprovals = approvals => { const value = state(busy); value.chat.approvals = approvals; return value; };

test('a pending approval is a named, keyboard-operable card that answers with a closed set of values and is inert to model text', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		await push(state(busy));
		assert.equal(await page.locator('#approvals').isHidden(), true);
		await push(withApprovals([card]));
		const shown = await page.evaluate(() => {
			const group = document.querySelector('#approvals [role="group"]');
			return {
				name: document.getElementById(group.getAttribute('aria-labelledby')).textContent, lines: [...group.querySelectorAll('li')].map(item => item.textContent), bold: group.querySelectorAll('b').length,
				rule: document.getElementById(group.getAttribute('aria-describedby')).textContent, buttons: [...group.querySelectorAll('button')].map(button => button.textContent),
				focused: document.activeElement.textContent
			};
		});
		assert.deepEqual(shown, {
			name: 'Hacer commit', lines: card.detail, bold: 0, rule: 'Permitir siempre guarda la regla «git_commit» en ~/.armotusitio/permissions.json.',
			buttons: ['Permitir una vez', 'Permitir siempre', 'Denegar'], focused: 'Permitir una vez'
		});
		// Progress updates keep the same card, so focus is not stolen from the button the user is on.
		await page.keyboard.press('Tab');
		await push(withApprovals([card]));
		assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Permitir siempre');
		await page.keyboard.press('Enter');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'approval', id: card.id, answer: 'always' });
		await page.click('#approvals button:last-child');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'approval', id: card.id, answer: 'deny' });
		await push(withApprovals([]));
		assert.equal(await page.locator('#approvals').isHidden(), true);
	} finally { await browser.close(); }
});
