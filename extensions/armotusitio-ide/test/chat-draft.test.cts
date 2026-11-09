/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Browser probe: an unsent message survives a reload of the Chat Harness view; credentials and sent messages do not. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const { state, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

test('the draft is restored after the view reloads, and never kept when sent or when it looks like a credential', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion: 'reduce' });
		const push = await mountChat(page, undefined, { draft: 'arreglar el login' });
		await push(state(undefined));
		const restored = await page.evaluate(() => document.getElementById('prompt').value);
		const type = text => page.evaluate(value => { const input = document.getElementById('prompt'); input.value = value; input.dispatchEvent(new Event('input')); return window.savedState; }, text);
		const typed = await type('otra cosa');
		const secret = await type('mi password: hunter2');
		await type('hola');
		const sent = await page.evaluate(() => { document.getElementById('send').click(); return window.savedState; });
		assert.deepEqual({ restored, typed, secret, sent }, { restored: 'arreglar el login', typed: { draft: 'otra cosa' }, secret: { draft: '' }, sent: { draft: '' } });
	} finally { await browser.close(); }
});
