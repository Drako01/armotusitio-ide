/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Minimal Markdown subset for AI answers. Produces a data tree; the renderer only uses textContent, never HTML. */
'use strict';

type Inline = { type: 'text' | 'code' | 'strong' | 'em' | 'link'; text: string; href?: string };
type Block =
	| { type: 'heading'; level: number; inlines: Inline[] }
	| { type: 'paragraph'; inlines: Inline[] }
	| { type: 'code'; language: string; text: string }
	| { type: 'list'; ordered: boolean; items: Inline[][] }
	| { type: 'quote'; inlines: Inline[] }
	| { type: 'table'; header: Inline[][]; rows: Inline[][][] }
	| { type: 'rule' };

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\b_([^_\s][^_]*)_\b|\[([^\]]+)\]\(([^)\s]+)\)/g;

function parseInline(source: string): Inline[] {
	const result: Inline[] = [];
	let last = 0;
	for (const match of source.matchAll(INLINE)) {
		if (match.index > last) { result.push({ type: 'text', text: source.slice(last, match.index) }); }
		if (match[2] !== undefined) { result.push({ type: 'code', text: match[2].trim() }); }
		else if (match[3] !== undefined || match[4] !== undefined) { result.push({ type: 'strong', text: match[3] ?? match[4] }); }
		else if (match[5] !== undefined || match[6] !== undefined) { result.push({ type: 'em', text: match[5] ?? match[6] }); }
		else { result.push({ type: 'link', text: match[7], href: match[8] }); }
		last = match.index + match[0].length;
	}
	if (last < source.length) { result.push({ type: 'text', text: source.slice(last) }); }
	return result;
}

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());

function parseMarkdown(source: string): Block[] {
	const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
	const blocks: Block[] = [];
	let paragraph: string[] = [];
	const flush = () => { if (paragraph.length) { blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join('\n')) }); paragraph = []; } };
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
		if (fence) {
			flush();
			const body: string[] = [];
			index++;
			while (index < lines.length && !lines[index].trim().startsWith(fence[1])) { body.push(lines[index]); index++; }
			blocks.push({ type: 'code', language: fence[2], text: body.join('\n') });
			continue;
		}
		if (!line.trim()) { flush(); continue; }
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, inlines: parseInline(heading[2].replace(/\s#+\s*$/, '')) }); continue; }
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ type: 'rule' }); continue; }
		if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
			flush();
			const header = cells(line).map(parseInline);
			const rows: Inline[][][] = [];
			index += 2;
			while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) { rows.push(cells(lines[index]).map(parseInline)); index++; }
			index--;
			blocks.push({ type: 'table', header, rows });
			continue;
		}
		const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
		if (item) {
			flush();
			const ordered = !item[1];
			const items: Inline[][] = [parseInline(item[3])];
			while (index + 1 < lines.length) {
				const next = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[index + 1]);
				if (next && !next[1] === ordered) { items.push(parseInline(next[3])); index++; continue; }
				// Indented continuation lines belong to the previous item.
				if (/^\s{2,}\S/.test(lines[index + 1]) && !next) { items[items.length - 1].push({ type: 'text', text: ' ' + lines[index + 1].trim() }); index++; continue; }
				break;
			}
			blocks.push({ type: 'list', ordered, items });
			continue;
		}
		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote) { flush(); blocks.push({ type: 'quote', inlines: parseInline(quote[1]) }); continue; }
		paragraph.push(line);
	}
	flush();
	return blocks;
}

module.exports = { parseMarkdown, parseInline };
