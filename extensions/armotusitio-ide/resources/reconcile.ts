/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

/** Patch stable elements so polling preserves focus, selection, form input, details and scroll. */
function reconcile(current: HTMLElement, next: HTMLElement) {
	for (const attribute of Array.from(current.attributes)) { if (attribute.name !== 'open' && !next.hasAttribute(attribute.name)) { current.removeAttribute(attribute.name); } }
	for (const attribute of Array.from(next.attributes)) { if (attribute.name !== 'open' && current.getAttribute(attribute.name) !== attribute.value) { current.setAttribute(attribute.name, attribute.value); } }
	current.oninput = next.oninput; current.onchange = next.onchange;
	if (current instanceof HTMLButtonElement && next instanceof HTMLButtonElement) { current.disabled = next.disabled; current.onclick = next.onclick; }
	if (current instanceof HTMLFormElement) { current.onsubmit = next.onsubmit; }
	if (current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement) { current.disabled = (next as HTMLInputElement).disabled; return current; }
	const selected = current instanceof HTMLSelectElement ? current.value : undefined;
	if (current instanceof HTMLProgressElement) { if (next.hasAttribute('value')) { current.value = (next as HTMLProgressElement).value; } else { current.removeAttribute('value'); } }
	const previous = Array.from(current.childNodes);
	const used = new Set();
	for (const [index, desired] of Array.from(next.childNodes).entries()) {
		const key = desired instanceof HTMLElement ? desired.dataset.key : undefined;
		let actual = key ? previous.find(node => node instanceof HTMLElement && node.dataset.key === key && node.nodeName === desired.nodeName) : previous[index];
		if (!actual || used.has(actual) || actual.nodeName !== desired.nodeName || actual instanceof HTMLElement && actual.dataset.key !== key) { actual = desired; }
		if (actual !== desired && actual instanceof HTMLElement && desired instanceof HTMLElement) { reconcile(actual, desired); }
		else if (actual.nodeValue !== desired.nodeValue) { actual.nodeValue = desired.nodeValue; }
		used.add(actual);
		if (current.childNodes[index] !== actual) { current.insertBefore(actual, current.childNodes[index] || null); }
	}
	for (const node of Array.from(current.childNodes)) { if (!used.has(node)) { node.remove(); } }
	if (current instanceof HTMLSelectElement && Array.from(current.options).some(option => option.value === selected)) { current.value = selected; }
	return current;
}
module.exports = { reconcile };
