/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const { state, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

const goal = (id, status, questions = []) => ({ id, project: 'demo', objective: 'Subir la cobertura de identity <b>x</b>', status, startedAt: new Date().toISOString(), questions });
const withGoals = goals => ({ ...state(undefined), goals });

test('live goals are named cards with state, pending questions and pause/stop controls that act through the host', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		await push(withGoals([]));
		assert.equal(await page.locator('#goals').isHidden(), true);
		await push(withGoals([goal('g1', 'running'), goal('g2', 'waiting-answers', ['¿Qué proveedor de correo?', '<script>x</script>'])]));
		const shown = await page.evaluate(() => {
			const cards = [...document.querySelectorAll('#goals [role="group"]')];
			return cards.map(card => ({
				name: document.getElementById(card.getAttribute('aria-labelledby')).textContent,
				status: card.querySelector('.approval-rule').textContent.split(' · ')[0],
				questions: [...card.querySelectorAll('li')].map(item => item.textContent),
				buttons: [...card.querySelectorAll('button')].map(button => button.textContent + (button.disabled ? ' (off)' : '')),
				injected: card.querySelectorAll('b, script').length
			}));
		});
		assert.deepEqual(shown, [
			{ name: 'demo · Subir la cobertura de identity <b>x</b>', status: 'en ejecución', questions: [], buttons: ['Pausar', 'Detener'], injected: 0 },
			{ name: 'demo · Subir la cobertura de identity <b>x</b>', status: 'espera tus respuestas', questions: ['¿Qué proveedor de correo?', '<script>x</script>'], buttons: ['Pausar', 'Detener'], injected: 0 }
		]);
		await page.click('#goals [aria-labelledby="goal-title-g1"] button:text-is("Pausar")');
		await page.click('#goals [aria-labelledby="goal-title-g2"] button:text-is("Detener")');
		assert.deepEqual(await page.evaluate(() => window.sent.filter(message => message.action === 'goal')), [{ action: 'goal', id: 'g1', control: 'pause' }, { action: 'goal', id: 'g2', control: 'stop' }]);
		// The host answers with the new states: a requested pause disables only pause; a requested stop disables both.
		await push(withGoals([goal('g1', 'pausing'), goal('g2', 'stopping')]));
		assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#goals button')].map(button => button.textContent + (button.disabled ? ' (off)' : ''))),
			['Pausar (off)', 'Detener', 'Pausar (off)', 'Detener (off)']);
		await push(withGoals([]));
		assert.equal(await page.locator('#goals').isHidden(), true);
	} finally { await browser.close(); }
});
