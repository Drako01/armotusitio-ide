/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Browser probe of the AI account selector in the shipped Chat Harness webview: real states in words, safe actions, no silent change. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const { state, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

const accountsState = () => {
	const value = state();
	value.accounts = {
		claude: { selected: 'b', options: [{ id: 'a', alias: 'Personal', state: 'authenticated' }, { id: 'b', alias: 'Trabajo con un nombre bastante largo', state: 'not-authenticated' }] },
		codex: { selected: '', options: [] }
	};
	return value;
};

test('the account selector names each login state in words, keeps the selection on manage, and posts a closed action for a choice', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 700, height: 800 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const value = accountsState();
		value.chat.provider = 'claude';
		await push(value);
		const shown = await page.evaluate(() => {
			const select = document.getElementById('account');
			return { hidden: select.hidden, label: select.getAttribute('aria-label'), options: [...select.options].map(option => option.textContent), selected: select.selectedOptions[0].textContent, enabled: !select.disabled };
		});
		await page.selectOption('#account', 'a');
		const chosen = await page.evaluate(() => window.sent.at(-1));
		await page.selectOption('#account', '__manage');
		const manage = await page.evaluate(() => ({ sent: window.sent.at(-1).action, value: document.getElementById('account').value }));
		assert.deepEqual({ shown, chosen: { action: chosen.action, provider: chosen.provider, profileId: chosen.profileId }, manage }, {
			shown: { hidden: false, label: 'Cuenta de Claude Code', options: ['Cuenta del IDE', 'Personal \u00b7 Autenticada', 'Trabajo con un nombre bastante largo \u00b7 Sin sesi\u00f3n', 'Administrar cuentas\u2026'], selected: 'Trabajo con un nombre bastante largo \u00b7 Sin sesi\u00f3n', enabled: true },
			chosen: { action: 'account', provider: 'claude', profileId: 'a' }, manage: { sent: 'accounts', value: 'b' }
		});
		// A provider without accounts still offers the IDE account and the way to add one.
		const other = accountsState(); other.chat.provider = 'codex';
		await push(other);
		assert.deepEqual(await page.evaluate(() => [...document.getElementById('account').options].map(option => option.textContent)), ['Cuenta del IDE', 'Administrar cuentas\u2026']);
	} finally { await browser.close(); }
});

test('the chat says when the conversation keeps one account but the next message will use another', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 700, height: 800 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const value = accountsState();
		value.chat.provider = 'claude';
		value.ranWith = { claude: 'a' };
		await push(value);
		const split = await page.evaluate(() => document.getElementById('account-note').textContent);
		value.ranWith = { claude: 'b' };
		await push(value);
		const same = await page.evaluate(() => document.getElementById('account-note').textContent);
		assert.deepEqual({ split, same }, { split: 'Esta conversación sigue con Personal; el próximo mensaje usará Trabajo con un nombre bastante largo.', same: '' });
	} finally { await browser.close(); }
});

test('the account selector looks like the other selectors of the bar: same computed background, color, radius and height', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 900, height: 800 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const value = accountsState();
		value.chat.provider = 'claude';
		await push(value);
		const styles = await page.evaluate(() => {
			const read = id => { const style = getComputedStyle(document.getElementById(id)); return { background: style.backgroundColor, color: style.color, radius: style.borderRadius, height: style.minHeight, border: style.borderTopWidth + ' ' + style.borderTopColor, font: style.fontFamily }; };
			return { account: read('account'), model: read('model') };
		});
		assert.deepEqual(styles.account, styles.model);
	} finally { await browser.close(); }
});
