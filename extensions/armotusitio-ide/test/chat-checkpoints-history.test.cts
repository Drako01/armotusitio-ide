/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

const checkpoint = (id, sequence, files, turnId = '11111111-1111-4111-8111-111111111111') => ({ id, at: '2026-11-13T12:00:00.000Z', turnId, sequence, stepId: 'edit <b>' + sequence + '</b>', kind: 'edit', files });
const items = [
	checkpoint('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, [{ path: 'src/b.ts', change: 'modified', restorable: false }, { path: 'src/c.ts', change: 'deleted', restorable: true }]),
	checkpoint('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, [{ path: 'src/<img src=x onerror=alert(1)>.ts', change: 'added', restorable: true }])
];

test('the checkpoint history lists tools by turn, blocks restores after later edits and opens diffs through the host', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const current = state(undefined);
		await push(current);
		assert.equal(await page.locator('#checkpoints').isHidden(), true);
		// The menu asks the host; a listing for another project is ignored.
		await page.click('#menu-button');
		await page.click('#menu button:text-is("Historial de checkpoints")');
		assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.action === 'checkpoints')), [{ action: 'checkpoints' }]);
		await push({ type: 'checkpoints', project: 'other-project', items });
		assert.equal(await page.locator('#checkpoints').isHidden(), true);
		await push({ type: 'checkpoints', project: current.project.id, items });
		const shown = await page.evaluate(() => {
			const cards = [...document.querySelectorAll('#checkpoints li.approval')];
			return {
				focused: document.activeElement?.id,
				turns: [...document.querySelectorAll('#checkpoints h3')].map(heading => heading.textContent),
				cards: cards.map(card => ({
					name: document.getElementById(card.getAttribute('aria-labelledby')).textContent,
					files: [...card.querySelectorAll('ul li')].map(item => item.firstChild.textContent.trim()),
					restore: card.querySelector('.approval-actions button:last-child').disabled,
					why: card.querySelector('.approval-actions p')?.textContent ?? null,
					injected: card.querySelectorAll('b, img').length
				}))
			};
		});
		assert.equal(shown.focused, 'checkpoints-title');
		assert.deepEqual(shown.turns, ['Turno 11111111']);
		assert.deepEqual(shown.cards, [
			{ name: '#1 · edición · edit <b>1</b>', files: ['src/<img src=x onerror=alert(1)>.ts · nuevo · se puede restaurar'], restore: false, why: null, injected: 0 },
			{ name: '#2 · edición · edit <b>2</b>', files: ['src/b.ts · modificado · cambió después: se preserva', 'src/c.ts · borrado · se puede restaurar'], restore: true, why: 'Un archivo cambió después de la herramienta: restaurar no tocaría nada. Revisá el diff.' }
		].map((card, index) => ({ ...card, injected: 0, why: index ? card.why : null })));
		await page.click('#checkpoints li.approval:nth-child(1) button:text-is("Ver diff")');
		await page.click('#checkpoints li.approval:nth-child(1) button:text-is("Restaurar")');
		assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.action === 'checkpointDiff' || message.action === 'send')), [
			{ action: 'checkpointDiff', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', path: 'src/<img src=x onerror=alert(1)>.ts', change: 'added' },
			{ action: 'send', text: '/checkpoints restaurar bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
		]);
		// Restoring closes the panel; reopening and pressing Escape returns focus to the menu button.
		assert.equal(await page.locator('#checkpoints').isHidden(), true);
		await push({ type: 'checkpoints', project: current.project.id, items: [] });
		assert.equal(await page.locator('#checkpoints p.muted').textContent(), 'No hay checkpoints granulares seguros en este proyecto. Se crean cuando el agente edita archivos en una ejecución del chat.');
		await page.keyboard.press('Escape');
		assert.deepEqual(await page.evaluate(() => [document.getElementById('checkpoints').hidden, document.activeElement?.id]), [true, 'menu-button']);
	} finally { await browser.close(); }
});
