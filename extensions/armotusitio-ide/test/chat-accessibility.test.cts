/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/*
 * Automated accessibility probes of the shipped Chat Harness webview in real Chromium: names, structure,
 * focus visibility, target size and text contrast under representative Dark, Light and High Contrast token sets.
 * These probes find defects; they do not certify WCAG 2.2 AA, which also needs the manual NVDA/VoiceOver matrix.
 */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { state, launchBrowser, mountChat } = require('./chat-webview-fixture.cts');

const base = {
	dark: { 'editor-background': '#1f1f1f', foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'input-background': '#313131', 'input-foreground': '#cccccc', 'dropdown-background': '#313131', 'dropdown-foreground': '#cccccc', 'badge-background': '#616161', 'badge-foreground': '#ffffff', errorForeground: '#f85149', 'textLink-foreground': '#4daafc', 'editorWidget-background': '#202020', 'sideBar-background': '#181818', 'editorWarning-foreground': '#cca700', 'testing-iconPassed': '#73c991', focusBorder: '#0078d4', 'textBlockQuote-background': '#2b2b2b', 'textCodeBlock-background': '#2b2b2b' },
	light: { 'editor-background': '#ffffff', foreground: '#3b3b3b', descriptionForeground: '#717171', 'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b', 'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'dropdown-background': '#ffffff', 'dropdown-foreground': '#3b3b3b', 'badge-background': '#cccccc', 'badge-foreground': '#3b3b3b', errorForeground: '#f85149', 'textLink-foreground': '#005fb8', 'editorWidget-background': '#f8f8f8', 'sideBar-background': '#f8f8f8', 'editorWarning-foreground': '#bf8803', 'testing-iconPassed': '#388a34', focusBorder: '#005fb8', 'textBlockQuote-background': '#f8f8f8', 'textCodeBlock-background': '#f8f8f8' },
	highContrast: { 'editor-background': '#000000', foreground: '#ffffff', descriptionForeground: '#ffffff', 'button-background': '#000000', 'button-foreground': '#ffffff', 'button-secondaryBackground': '#000000', 'button-secondaryForeground': '#ffffff', 'input-background': '#000000', 'input-foreground': '#ffffff', 'dropdown-background': '#000000', 'dropdown-foreground': '#ffffff', 'badge-background': '#000000', 'badge-foreground': '#ffffff', errorForeground: '#f48771', 'textLink-foreground': '#3794ff', 'editorWidget-background': '#000000', 'sideBar-background': '#000000', 'editorWarning-foreground': '#ffff00', 'testing-iconPassed': '#89d185', focusBorder: '#f38518', 'textBlockQuote-background': '#000000', 'textCodeBlock-background': '#000000' }
};
const themeCss = tokens => ':root{' + Object.entries(tokens).map(([name, value]) => '--vscode-' + name + ':' + value).join(';') + '}';
const busy = { kind: 'thinking', provider: 'claude', startedAt: new Date().toISOString(), observedBytes: 4096 };

/** Everything that should be reachable and named, evaluated inside the page. */
function audit() {
	const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
	const name = element => (element.getAttribute('aria-label') || (element.getAttribute('aria-labelledby') && document.getElementById(element.getAttribute('aria-labelledby'))?.textContent) || element.labels?.[0]?.textContent || element.textContent || element.getAttribute('title') || '').trim();
	const controls = [...document.querySelectorAll('button, select, textarea, input, [role="radio"], [tabindex]')].filter(visible);
	const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
	const missing = attribute => [...document.querySelectorAll('[' + attribute + ']')].flatMap(element => (element.getAttribute(attribute) || '').split(/\s+/).filter(id => id && !document.getElementById(id)));
	return {
		unnamed: controls.filter(element => !name(element)).map(element => element.outerHTML.slice(0, 80)),
		duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
		danglingReferences: [...missing('aria-controls'), ...missing('aria-describedby')],
		positiveTabindex: controls.filter(element => element.tabIndex > 0).length,
		logRegions: document.querySelectorAll('[role="log"]').length,
		imagesWithoutAlt: [...document.images].filter(image => !image.hasAttribute('alt')).length,
		language: document.documentElement.lang,
		// WCAG 2.2 success criterion 2.5.8: pointer targets of at least 24 by 24 CSS pixels.
		smallTargets: controls.filter(element => { const box = element.getBoundingClientRect(); return element.tagName !== 'TEXTAREA' && (box.width < 24 || box.height < 24); }).map(element => name(element).slice(0, 30) + ' ' + Math.round(element.getBoundingClientRect().width) + 'x' + Math.round(element.getBoundingClientRect().height))
	};
}

/** Contrast of every visible text element against its composited background. */
function contrastFailures() {
	const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	const rgba = css => { context.clearRect(0, 0, 1, 1); context.fillStyle = '#000'; context.fillStyle = css; context.fillRect(0, 0, 1, 1); const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
	const over = (top, bottom) => { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]; };
	const luminance = ([r, g, b]) => [r, g, b].map(value => { const channel = value / 255; return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
	const ratio = (foreground, background) => { const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a); return (light + 0.05) / (dark + 0.05); };
	const backgroundOf = element => { const layers = []; for (let node = element; node; node = node.parentElement) { layers.push(rgba(getComputedStyle(node).backgroundColor)); } return layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]); };
	const failures = [];
	for (const element of document.querySelectorAll('body *')) {
		const own = [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
		const box = element.getBoundingClientRect(); const style = getComputedStyle(element);
		if (!own || box.width === 0 || style.visibility === 'hidden' || element.closest('[disabled], [hidden], .visually-hidden') || element.disabled) { continue; }
		const size = parseFloat(style.fontSize); const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
		const background = backgroundOf(element);
		const value = ratio(over(rgba(style.color), background), background);
		if (value < (large ? 3 : 4.5)) { failures.push(element.tagName.toLowerCase() + '.' + element.className + ' "' + element.textContent.trim().slice(0, 24) + '" ' + value.toFixed(2)); }
	}
	return failures;
}

test('Chat Harness webview has names, structure, target sizes and contrast that automated checks can verify', async () => {
	const browser = await launchBrowser();
	try {
		const results = {};
		for (const [themeName, tokens] of Object.entries(base)) {
			const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
			const push = await mountChat(page, themeCss(tokens));
			for (const [view, activity] of [['idle', undefined], ['busy', busy]]) {
				await push(state(activity));
				results[themeName + ':' + view] = { ...await page.evaluate(audit), contrast: await page.evaluate(contrastFailures) };
			}
			await page.close();
		}
		const keys = Object.keys(results);
		const clean = { unnamed: [], duplicateIds: [], danglingReferences: [], positiveTabindex: 0, logRegions: 1, imagesWithoutAlt: 0, language: 'es-AR' };
		const structure = Object.fromEntries(keys.map(key => { const { contrast, smallTargets, ...rest } = results[key]; return [key, rest]; }));
		assert.deepEqual(structure, Object.fromEntries(keys.map(key => [key, clean])));
		assert.deepEqual(Object.fromEntries(keys.map(key => [key, results[key].contrast])), Object.fromEntries(keys.map(key => [key, []])));
		assert.deepEqual(Object.fromEntries(keys.map(key => [key, results[key].smallTargets])), Object.fromEntries(keys.map(key => [key, []])));
	} finally { await browser.close(); }
});

test('every control shows a visible focus indicator when reached with the keyboard', async () => {
	const browser = await launchBrowser();
	try {
		const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		const push = await mountChat(page);
		await push(state(undefined));
		const composerBlurred = await page.evaluate(() => getComputedStyle(document.querySelector('.composer-box')).borderColor);
		const stops = [];
		for (let step = 0; step < 40; step++) {
			await page.keyboard.press('Tab');
			const stop = await page.evaluate(blurred => {
				const element = document.activeElement;
				if (!element || element === document.body) { return null; }
				const style = getComputedStyle(element);
				// The composer hides its own outline and highlights the frame around it instead.
				const frame = element.closest('.composer-box');
				return { label: (element.getAttribute('aria-label') || element.textContent || element.id).trim().slice(0, 30), indicator: (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none' || (!!frame && getComputedStyle(frame).borderColor !== blurred) };
			}, composerBlurred);
			if (!stop) { break; }
			stops.push(stop);
		}
		assert.ok(stops.length > 5, 'keyboard reaches the interface: ' + stops.length);
		assert.deepEqual(stops.filter(stop => !stop.indicator).map(stop => stop.label), []);
	} finally { await browser.close(); }
});
