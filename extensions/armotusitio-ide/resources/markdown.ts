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

/** A piece of highlighted code: plain text or one token kind the stylesheet colors. Still text only, never markup. */
type CodeToken = { type: 'text' | 'keyword' | 'string' | 'number' | 'comment'; text: string };

/** Languages whose line comments start with `#`; the rest use `//` (and SQL/Lua `--`). */
const HASH_COMMENTS = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'ps1', 'powershell', 'pwsh', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'dockerfile', 'makefile', 'r', 'perl', 'ini', 'conf', 'env']);
const DASH_COMMENTS = new Set(['sql', 'lua', 'hs', 'haskell']);
/** Words shared by the languages people paste most; good enough to read code, not a full grammar. */
const KEYWORDS = new Set(('abstract and as async await break case catch class const continue def default defer delete do elif else enum export extends ' +
	'false final finally fn for foreach from func function go if impl implements import in interface is lambda let match mod module mut namespace new nil ' +
	'none not null of or package pass private protected pub public raise readonly return select self static struct super switch then this throw throws ' +
	'true try type typeof undefined use using var void when where while with yield echo fi esac done ' +
	'SELECT FROM WHERE INSERT INTO UPDATE DELETE CREATE TABLE ALTER DROP JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER LIMIT AND OR NOT NULL AS VALUES SET PRIMARY KEY ' +
	'True False None').split(' '));
/** Above this size a block stays plain: highlighting must never slow down the chat. */
const MAX_HIGHLIGHT_CHARS = 20000;
const NO_HIGHLIGHT = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'log', 'output', 'console', 'diff', 'md', 'markdown']);

/** Tokens of a code block for coloring; unknown or huge blocks come back as one plain token. */
function highlightCode(language: string, source: string): CodeToken[] {
	const lang = language.toLowerCase();
	if (NO_HIGHLIGHT.has(lang) || source.length > MAX_HIGHLIGHT_CHARS) { return [{ type: 'text', text: source }]; }
	const comment = HASH_COMMENTS.has(lang) ? '#[^\\n]*' : DASH_COMMENTS.has(lang) ? '--[^\\n]*' : '\\/\\/[^\\n]*|<!--[\\s\\S]*?-->';
	const pattern = new RegExp('(?<comment>' + comment + '|\\/\\*[\\s\\S]*?\\*\\/)|(?<string>"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)|(?<number>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)|(?<word>\\b[A-Za-z_]\\w*\\b)', 'g');
	const tokens: CodeToken[] = [];
	let last = 0;
	const push = (type: CodeToken['type'], text: string) => {
		const previous = tokens.at(-1);
		if (previous?.type === type) { previous.text += text; } else { tokens.push({ type, text }); }
	};
	for (const match of source.matchAll(pattern)) {
		const groups = match.groups!;
		const type: CodeToken['type'] = groups.comment !== undefined ? 'comment' : groups.string !== undefined ? 'string' : groups.number !== undefined ? 'number' : KEYWORDS.has(match[0]) ? 'keyword' : 'text';
		if (match.index > last) { push('text', source.slice(last, match.index)); }
		push(type, match[0]);
		last = match.index + match[0].length;
	}
	if (last < source.length) { push('text', source.slice(last)); }
	return tokens;
}

module.exports = { parseMarkdown, parseInline, highlightCode };
