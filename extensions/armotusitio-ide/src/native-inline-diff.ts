/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Bounded line diff for showing one file's change inside the chat, like Claude and Codex do. It is display only:
 * the editor's own diff view stays the reference, and anything too large says so instead of being cut silently.
 */

/** One rendered line: unchanged context, an added or removed line, or a marker for skipped unchanged lines. */
export type InlineDiffLine =
	| { kind: 'context' | 'add' | 'del'; text: string; line: number }
	| { kind: 'gap'; skipped: number };

export type InlineDiff =
	| { status: 'ok'; lines: InlineDiffLine[]; added: number; removed: number; truncated: boolean }
	| { status: 'same' | 'binary' | 'too-large' };

/** Lines compared after trimming the common start and end; above this the chat points to the editor's diff. */
const MAX_COMPARED_LINES = 1500;
/** Rendered lines in the chat; longer diffs are cut and marked as truncated. */
const MAX_RENDERED_LINES = 400;
const CONTEXT_LINES = 3;
const MAX_LINE_CHARS = 400;

const splitLines = (text: string): string[] => text.length ? text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n') : [];

/** Diff of `before` and `after` with a few lines of context around each change. */
export function inlineDiff(before: string, after: string): InlineDiff {
	if (before.includes('\0') || after.includes('\0')) { return { status: 'binary' }; }
	const old = splitLines(before), now = splitLines(after);
	let start = 0;
	while (start < old.length && start < now.length && old[start] === now[start]) { start++; }
	let end = 0;
	while (end < old.length - start && end < now.length - start && old[old.length - 1 - end] === now[now.length - 1 - end]) { end++; }
	const a = old.slice(start, old.length - end), b = now.slice(start, now.length - end);
	if (!a.length && !b.length) { return { status: 'same' }; }
	if (a.length > MAX_COMPARED_LINES || b.length > MAX_COMPARED_LINES) { return { status: 'too-large' }; }
	// Longest common subsequence table, filled from the end so the walk below goes forward.
	const width = b.length + 1;
	const table = new Uint16Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	const all: Array<{ kind: 'context' | 'add' | 'del'; text: string; line: number }> = [];
	for (let line = 0; line < start; line++) { all.push({ kind: 'context', text: old[line], line: line + 1 }); }
	let i = 0, j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) { all.push({ kind: 'context', text: a[i], line: start + j + 1 }); i++; j++; }
		else if (j < b.length && (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) { all.push({ kind: 'add', text: b[j], line: start + j + 1 }); j++; }
		else { all.push({ kind: 'del', text: a[i], line: start + i + 1 }); i++; }
	}
	for (let line = now.length - end; line < now.length; line++) { all.push({ kind: 'context', text: now[line], line: line + 1 }); }
	// Keep only context near a change; runs of unchanged lines become one gap marker.
	const near = all.map(() => false);
	all.forEach((entry, index) => {
		if (entry.kind === 'context') { return; }
		for (let k = Math.max(0, index - CONTEXT_LINES); k <= Math.min(all.length - 1, index + CONTEXT_LINES); k++) { near[k] = true; }
	});
	const lines: InlineDiffLine[] = [];
	let skipped = 0;
	for (const [index, entry] of all.entries()) {
		if (!near[index]) { skipped++; continue; }
		if (skipped) { lines.push({ kind: 'gap', skipped }); skipped = 0; }
		lines.push({ ...entry, text: entry.text.length > MAX_LINE_CHARS ? entry.text.slice(0, MAX_LINE_CHARS) + '…' : entry.text });
	}
	if (skipped) { lines.push({ kind: 'gap', skipped }); }
	return {
		status: 'ok', lines: lines.slice(0, MAX_RENDERED_LINES), truncated: lines.length > MAX_RENDERED_LINES,
		added: all.filter(entry => entry.kind === 'add').length, removed: all.filter(entry => entry.kind === 'del').length
	};
}
