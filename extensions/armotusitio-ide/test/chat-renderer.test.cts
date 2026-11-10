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

test('composer autocomplete: / lists commands, @ asks the host for files, keyboard picks, stale answers are dropped', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		await push(state(undefined));
		const options = () => page.$$eval('#suggest li', nodes => nodes.map(node => node.textContent));
		await page.focus('#prompt');
		await page.keyboard.type('/pe');
		assert.equal((await options()).length, 1);
		assert.match((await options())[0], /^\/permisos/);
		assert.equal(await page.getAttribute('#prompt', 'aria-expanded'), 'true');
		await page.keyboard.press('Enter');
		assert.equal(await page.inputValue('#prompt'), '/permisos ');
		assert.equal(await page.locator('#suggest').isHidden(), true);
		// A command typed in full is sent, not completed again.
		await page.fill('#prompt', '');
		await page.keyboard.type('/ayuda');
		await page.keyboard.press('Enter');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'send', text: '/ayuda' });
		await page.keyboard.type('mira @sr');
		const asked = await page.evaluate(() => window.sent.at(-1));
		assert.deepEqual({ action: asked.action, kind: asked.kind, query: asked.query }, { action: 'complete', kind: 'mention', query: 'sr' });
		await push({ type: 'completions', kind: 'mention', seq: asked.seq - 1, items: ['stale.ts'] });
		assert.equal((await options()).length, 0);
		await push({ type: 'completions', kind: 'mention', seq: asked.seq, items: ['src/a.ts', 'docs/my file.md'] });
		assert.deepEqual(await options(), ['a.tssrc/a.ts', 'my file.mddocs/my file.md']);
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Tab');
		assert.equal(await page.inputValue('#prompt'), 'mira @"docs/my file.md" ');
		await page.keyboard.type('@s');
		await push({ type: 'completions', kind: 'mention', seq: (await page.evaluate(() => window.sent.at(-1))).seq, items: ['src/a.ts'] });
		await page.keyboard.press('Escape');
		assert.equal(await page.locator('#suggest').isHidden(), true);
	} finally { await browser.close(); }
});

test('live timeline, queued messages and per-file run actions render inertly, accessibly and post validated messages', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const steps = [
			{ id: 's1', kind: 'read', label: 'src/model.ts', status: 'ok' },
			{ id: 's2', kind: 'command', label: 'npm test <img src=x onerror="window.pwned=true">', status: 'error', detail: 'exit 1' },
			...Array.from({ length: 30 }, (_, index) => ({ id: 'e' + index, kind: 'edit', label: 'src/file' + index + '.ts', status: index === 29 ? 'running' : 'ok' }))
		];
		const running = state({ kind: 'executing', provider: 'claude', startedAt: at, observedBytes: 100, stage: 'agent', planVersion: 0, steps });
		running.chat.queue = [{ id: 'q1', text: 'despues arregla los tests' }, { id: 'q2', text: 'y el README' }];
		await push(running);
		const live = await page.evaluate(() => {
			const list = document.querySelector('#activity .steps');
			return {
				labels: [...list.querySelectorAll('.step-label')].length, injected: !!document.querySelector('#activity img'), pwned: window.pwned === true,
				scrollable: list.scrollHeight > list.clientHeight, atEnd: list.scrollHeight - list.scrollTop - list.clientHeight < 2,
				listLabel: list.getAttribute('aria-label'), inLiveRegion: !!list.closest('[aria-live], [role="log"], [role="status"]'),
				announcer: document.getElementById('announcer').textContent, queued: [...document.querySelectorAll('#activity .queued-text')].map(node => node.textContent),
				send: document.getElementById('send').textContent, sendHidden: document.getElementById('send').hidden, stop: document.getElementById('stop').textContent
			};
		});
		assert.deepEqual(live, {
			labels: 32, injected: false, pwned: false, scrollable: true, atEnd: true, listLabel: 'Pasos del agente', inLiveRegion: false,
			announcer: 'Agente implementador trabajando. En cola (2)', queued: ['despues arregla los tests', 'y el README'], send: 'Encolar', sendHidden: false, stop: 'Detener'
		});
		// A new step does not announce itself (no chatter), but the queue is removable and sending while busy posts as usual.
		await page.click('#activity .queued button >> nth=1');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'unqueue', id: 'q2' });
		await page.fill('#prompt', 'otro mensaje'); await page.keyboard.press('Enter');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'send', text: 'otro mensaje' });

		// Scrolling up is respected: a new step does not drag the reader back down.
		await page.evaluate(() => { document.querySelector('#activity .steps').scrollTop = 0; });
		await push({ ...running, chat: { ...running.chat, activity: { ...running.chat.activity, steps: [...steps, { id: 'late', kind: 'read', label: 'src/late.ts', status: 'running' }] } } });
		assert.equal(await page.evaluate(() => document.querySelector('#activity .steps').scrollTop), 0);

		// Finished run: collapsed step summary plus changed files with per-file actions on the latest run only.
		const run = {
			id: 'r1', role: 'run', provider: 'claude', text: 'Listo', at,
			run: {
				planVersion: 0, provider: 'claude', status: 'passed', durationMs: 4000, verification: { status: 'skipped', gates: [] },
				steps: steps.slice(0, 3).map(({ detail, ...step }) => step),
				outcome: { kind: 'completed', diff: { available: true, count: 2, files: [{ path: 'src/a.ts', change: 'modified', preexisting: false }, { path: 'src/b.ts', change: 'added', preexisting: false }] } }
			}
		};
		const done = state(undefined);
		done.chat.messages.push(run);
		done.chat.run = { messageId: 'r1', continuable: false, retryable: false, discardable: true };
		await push(done);
		const summary = await page.evaluate(() => ({
			summaries: [...document.querySelectorAll('.run-summary summary')].map(node => node.textContent),
			files: [...document.querySelectorAll('.run-file')].map(item => item.querySelector('code').textContent + ':' + [...item.querySelectorAll('button')].map(button => button.textContent).join('/')),
			undo: [...document.querySelectorAll('.run-actions button')].map(button => button.textContent)
		}));
		assert.deepEqual(summary, { summaries: ['Archivos que cambi\u00f3 esta ejecuci\u00f3n (2)', 'Pasos de la ejecuci\u00f3n (3)'], files: ['src/a.ts:Ver cambios/Revertir', 'src/b.ts:Ver cambios/Revertir'], undo: ['Deshacer esta ejecuci\u00f3n', 'Ver en Inicio'] });
		await page.evaluate(() => document.querySelector('.run-files-slot details').open = true);
		await page.click('.run-file >> nth=1 >> text=Ver cambios');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'openDiff', messageId: 'r1', path: 'src/b.ts' });
		await page.click('.run-file >> nth=0 >> text=Revertir');
		assert.deepEqual(await page.evaluate(() => window.sent.at(-1)), { action: 'revertFile', messageId: 'r1', path: 'src/a.ts' });

		// After reverting a.ts the list updates in place, the open state is kept, and only b.ts offers actions.
		const after = JSON.parse(JSON.stringify(done)); after.chat.messages.find(message => message.id === 'r1').run.reverted = ['src/a.ts']; after.chat.revision = 2;
		await push(after);
		assert.deepEqual(await page.evaluate(() => ({ open: document.querySelector('.run-files-slot details')?.open, files: [...document.querySelectorAll('.run-file')].map(item => item.textContent.replace(/\s+/g, ' ').trim()) })), {
			open: true, files: ['src/a.ts modificado \u00b7 revertido', 'src/b.ts nuevoVer cambiosRevertir']
		});

		// A blocked run always ends with the concrete next step for what it needs, never a dead end.
		const blocked = JSON.parse(JSON.stringify(after)); blocked.chat.revision = 3;
		blocked.chat.messages.push({ id: 'r2', role: 'run', provider: 'claude', text: '', at, run: { ...run.run, status: 'failed', outcome: { kind: 'blocked', reason: 'git fetch denegado', needs: 'policy' } } });
		await push(blocked);
		assert.equal(await page.evaluate(() => document.querySelector('[data-id="r2"] .run-summary .error-text')?.textContent),
			'El agente necesita algo que no puede resolver solo: git fetch denegado (un permiso) Revis\u00e1 /permisos: aprob\u00e1 la acci\u00f3n cuando la pida o quit\u00e1 la regla que la bloquea, y toc\u00e1 Continuar.');
	} finally { await browser.close(); }
});

test('Chat Harness quota indicator shows the shortest window of the active provider, escalates without relying on color and hides without data', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		const reading = (session, weekly) => ({
			claude: {
				provider: 'claude', asOf: Date.now(), source: 'stream', windows: [
					{ id: 'session', label: '5h', usedPercent: session, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
					{ id: 'weekly', label: '7d', usedPercent: weekly, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 }]
			}
		});
		const withQuota = quota => { const value = state(undefined); value.chat.quota = quota; return value; };
		const probe = () => page.evaluate(() => { const node = document.getElementById('quota'); return { hidden: node.hidden, level: node.dataset.level, icon: node.querySelector('.quota-icon').textContent, text: node.querySelector('.quota-text').textContent, label: node.getAttribute('aria-label'), title: node.title }; });

		// No data: nothing is shown, not a fake zero.
		await push(state(undefined));
		assert.equal((await probe()).hidden, true);

		await push(withQuota(reading(5, 40)));
		let shown = await probe();
		assert.deepEqual({ hidden: shown.hidden, level: shown.level, text: /^Sesi\u00f3n 95% libre \u00b7 reinicia \d{1,2}:\d{2}/.test(shown.text) }, { hidden: false, level: 'ok', text: true });
		assert.match(shown.title, /Cuota de Claude Code[\s\S]*Semanal 60% libre/);
		assert.match(shown.label, /Semanal 60% libre/);

		// Warning and critical change the icon and add words to the label, not just the color.
		await push(withQuota(reading(85, 40)));
		shown = await probe();
		assert.deepEqual({ level: shown.level, icon: shown.icon, words: /Queda poco cupo/.test(shown.label) }, { level: 'warn', icon: '\u26a0', words: true });
		await push(withQuota(reading(10, 97)));
		shown = await probe();
		assert.deepEqual({ level: shown.level, icon: shown.icon, words: /Cupo casi agotado/.test(shown.label) }, { level: 'critical', icon: '\u2716', words: true });

		// Only the active provider's reading is shown.
		const other = withQuota(reading(10, 10)); other.chat.provider = 'codex';
		await push(other);
		assert.equal((await probe()).hidden, true);
	} finally { await browser.close(); }
});


test('project drafts restore without crossing projects and sidebar commands remain keyboard accessible', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage();
		const push = await mountChat(page, undefined, { drafts: { a: 'restored A', b: 'restored B' } });
		await push(state());
		assert.equal(await page.locator('#prompt').inputValue(), 'restored A');
		await page.locator('#prompt').fill('shared new draft');
		assert.deepEqual(await page.evaluate(() => window.sent.filter(item => item.action === 'draft').at(-1)), { action: 'draft', project: 'a', text: 'shared new draft' });
		await push({ ...state(), project: { id: 'b', name: 'second' } });
		assert.equal(await page.locator('#prompt').inputValue(), 'restored B');
		await push({ type: 'draft', project: 'a', text: 'stale' });
		assert.equal(await page.locator('#prompt').inputValue(), 'restored B');
		await push({ type: 'draft', project: 'b', text: 'mirrored B' });
		assert.equal(await page.locator('#prompt').inputValue(), 'mirrored B');
		await page.locator('#prompt').fill('token = synthetic-secret');
		assert.equal(await page.evaluate(() => window.savedState.drafts.b), '');
		await page.locator('#menu-button').click();
		await page.getByRole('button', { name: 'Expandir Chat', exact: true }).focus();
		await page.keyboard.press('Enter');
		assert.equal(await page.evaluate(() => window.sent.at(-1).action), 'expandChat');
	} finally { await browser.close(); }
});
