/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Composer autocomplete: `/command` from the table the host sends, `@file` from host-side suggestions. Rendered with textContent only. */
'use strict';
const { activeMention, formatMention } = require('../src/native-chat-mention-syntax.ts');

interface SuggestOption { insert: string; label: string; detail: string }
interface SuggestLabels { commands: string; files: string; commandList: Array<{ name: string; usage: string; description: string }> }

function createSuggest(input: HTMLTextAreaElement, host: HTMLElement, post: (message: unknown) => void, labels: SuggestLabels) {
	const list = document.createElement('ul');
	list.className = 'suggest'; list.id = 'suggest'; list.hidden = true; list.setAttribute('role', 'listbox');
	host.prepend(list);
	input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', 'suggest'); input.setAttribute('aria-expanded', 'false');
	let options: SuggestOption[] = [];
	let active = 0;
	let start = 0;
	let requested = 0;

	function close(): void {
		options = []; list.hidden = true; list.textContent = '';
		input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
	}
	function highlight(): void {
		list.querySelectorAll('li').forEach((item, index) => {
			item.setAttribute('aria-selected', String(index === active));
			if (index === active) { input.setAttribute('aria-activedescendant', item.id); (item as HTMLElement).scrollIntoView?.({ block: 'nearest' }); }
		});
	}
	function accept(index: number): void {
		const option = options[index];
		if (!option) { return; }
		const caret = input.selectionStart ?? input.value.length;
		input.value = input.value.slice(0, start) + option.insert + ' ' + input.value.slice(caret);
		const end = start + option.insert.length + 1;
		input.setSelectionRange(end, end);
		close();
		input.dispatchEvent(new Event('input'));
	}
	function show(found: SuggestOption[], from: number, title: string): void {
		options = found; start = from; active = 0;
		list.textContent = '';
		if (!found.length) { close(); return; }
		list.setAttribute('aria-label', title);
		found.forEach((option, index) => {
			const item = document.createElement('li');
			item.id = 'suggest-' + index; item.setAttribute('role', 'option');
			const label = document.createElement('span'); label.className = 'suggest-label'; label.textContent = option.label;
			const detail = document.createElement('span'); detail.className = 'suggest-detail'; detail.textContent = option.detail;
			item.append(label, detail);
			// mousedown keeps the focus in the textarea, so the caret survives the click.
			item.addEventListener('mousedown', event => { event.preventDefault(); accept(index); });
			list.append(item);
		});
		list.hidden = false; input.setAttribute('aria-expanded', 'true');
		highlight();
	}

	return {
		/** Call after every edit or caret move. */
		update(): void {
			const caret = input.selectionStart ?? input.value.length;
			const before = input.value.slice(0, caret);
			const command = /^\/(?<name>\S*)$/.exec(before);
			if (command) {
				const query = command.groups!.name.toLowerCase();
				show(labels.commandList.filter(item => item.name.startsWith(query)).map(item => ({ insert: '/' + item.name, label: '/' + item.name + (item.usage ? ' ' + item.usage : ''), detail: item.description })), 0, labels.commands);
				return;
			}
			const mention = activeMention(input.value, caret);
			if (!mention) { close(); return; }
			start = mention.start;
			post({ action: 'complete', kind: 'mention', query: mention.query, seq: ++requested });
		},
		/** Host answer; stale answers (the user kept typing) are dropped. */
		complete(data: { seq: number; items: string[] }): void {
			if (data.seq !== requested) { return; }
			show(data.items.map(file => ({ insert: formatMention(file), label: file.slice(file.lastIndexOf('/') + 1), detail: file })), start, labels.files);
		},
		/** True when the key was consumed by the open list. */
		key(event: KeyboardEvent): boolean {
			if (list.hidden || event.isComposing) { return false; }
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				active = (active + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length; highlight(); return true;
			}
			if (event.key === 'Escape') { close(); return true; }
			if (event.key === 'Tab' || event.key === 'Enter') {
				// A command typed in full is sent, not re-completed.
				if (event.key === 'Enter' && options[active].insert === input.value.trim()) { return false; }
				accept(active); return true;
			}
			return false;
		},
		close
	};
}

module.exports = { createSuggest };
