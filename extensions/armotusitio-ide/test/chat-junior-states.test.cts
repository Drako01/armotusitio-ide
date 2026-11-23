/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Browser probes of the delivery states of the one-prompt flow: verified vs unverified, corrections, evidence and paused requests. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');

const { state, at, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

const diff = { available: true, count: 1, files: [{ path: 'src/sum.ts', change: 'modified', preexisting: false }] };
const runMessage = (id, run) => ({ id, role: 'run', provider: 'claude', text: 'Listo', at, run: { planVersion: 0, provider: 'claude', status: 'passed', durationMs: 2000, verification: { status: 'passed', gates: [{ id: 'test', status: 'passed' }] }, ...run } });

test('J-16/J-03: the run card separates applied from verified, shows corrections, why they stopped and the evidence', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const current = state(undefined);
		current.chat.messages.push(
			runMessage('r1', { status: 'failed', verification: { status: 'failed', gates: [{ id: 'test', status: 'failed' }] }, outcome: { kind: 'failed', reason: 'verification', diff }, evidence: [{ gate: 'test', kind: 'test', command: 'npm test', status: 'failed', exitCode: 1, source: 'ide-gate' }] }),
			runMessage('r2', { outcome: { kind: 'completed', assurance: 'verified', diff }, repair: { attempt: 1, max: 2 }, evidence: [{ gate: 'test', kind: 'test', command: 'npm test', status: 'passed', exitCode: 0, source: 'ide-gate' }] }),
			runMessage('r3', { verification: { status: 'skipped', gates: [] }, outcome: { kind: 'completed', assurance: 'unverified', diff } }),
			runMessage('r4', { status: 'failed', verification: { status: 'failed', gates: [{ id: 'test', status: 'failed' }] }, outcome: { kind: 'failed', reason: 'verification', diff }, repairStop: { reason: 'not-repairable', failures: [{ gate: 'test', failure: 'service-down' }] } })
		);
		await push(current);
		const cards = await page.$$eval('.run-summary', nodes => nodes.map(node => ({
			badge: node.querySelector('.status-badge').textContent,
			head: node.querySelector('.run-head').textContent,
			text: node.textContent
		})));
		assert.deepEqual(cards.map(card => card.badge), ['Fallida', 'Verificada', 'Aplicada sin verificar', 'Fallida']);
		assert.match(cards[1].head, /Correcci\u00f3n autom\u00e1tica 1 de 2/);
		// Verified technically is not verified functionally: without an E2E or smoke gate the card says so.
		assert.match(cards[1].text, /Nadie prob\u00f3 la app funcionando/);
		assert.match(cards[2].text, /no corri\u00f3 ninguna verificaci\u00f3n/);
		assert.match(cards[3].text, /la causa est\u00e1 fuera del c\u00f3digo \(test: service-down\)/);
		assert.deepEqual(await page.$$eval('.run-summary summary', nodes => nodes.map(node => node.textContent).filter(text => text.startsWith('Ver evidencia'))), ['Ver evidencia (1)', 'Ver evidencia (1)']);
		assert.match(await page.$eval('.run-summary >> nth=1', node => [...node.querySelectorAll('details')].find(item => item.querySelector('summary').textContent.startsWith('Ver evidencia')).textContent), /npm test.*aprobado.*exit 0/);
	} finally { await browser.close(); }
});

test('J-13: paused requests are visible cards with keyboard-reachable Retomar, Editar and Descartar; Retomar waits while busy', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const current = state(undefined);
		current.chat.suspended = [
			{ id: 'aaaaaaaaaaaa', text: 'agreg\u00e1 un test para pagos', mode: 'act', reason: 'previous-failed' },
			{ id: 'bbbbbbbbbbbb', text: '<img src=x onerror="window.pwned=true">', mode: 'ask', reason: 'interrupted', attachments: true }
		];
		await push(current);
		const view = await page.evaluate(() => ({
			hidden: document.getElementById('suspended').hidden,
			titles: [...document.querySelectorAll('#suspended .approval-title')].map(node => node.textContent),
			reasons: [...document.querySelectorAll('#suspended .approval-rule')].map(node => node.textContent),
			buttons: [...document.querySelectorAll('#suspended button')].map(node => node.getAttribute('aria-label')),
			injected: !!document.querySelector('#suspended img') || window.pwned === true
		}));
		assert.deepEqual({ hidden: view.hidden, titles: view.titles, injected: view.injected, buttons: view.buttons.length }, { hidden: false, titles: ['agreg\u00e1 un test para pagos', '<img src=x onerror="window.pwned=true">'], injected: false, buttons: 6 });
		assert.deepEqual(view.reasons, ['la tarea anterior fall\u00f3', 'el IDE se cerr\u00f3 \u00b7 Adjunt\u00e1 de nuevo los archivos']);
		await page.focus('#suspended button >> nth=1');
		await page.keyboard.press('Enter');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'editSuspended', id: 'aaaaaaaaaaaa' });
		await page.click('#suspended button >> nth=5');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'discardSuspended', id: 'bbbbbbbbbbbb' });
		// While a turn runs, resuming waits like Send does; edit and discard stay available.
		const busy = state({ kind: 'thinking', provider: 'claude', startedAt: at, observedBytes: 0 });
		busy.chat.suspended = current.chat.suspended;
		await push(busy);
		assert.deepEqual(await page.$$eval('#suspended button', nodes => nodes.map(node => node.disabled)), [true, false, false, true, false, false]);
	} finally { await browser.close(); }
});
