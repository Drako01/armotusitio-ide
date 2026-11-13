/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * User-facing copy in the sources is written with `\uXXXX` escapes (the hygiene gate rejects raw non-ASCII). An
 * escape that lost its backslash renders as garbage such as "versi00f3n" or "2026 y": this scans every source for
 * the Latin and punctuation code points the copy uses, outside a `\u` escape and outside a longer hex run.
 */
const SOURCE = path.resolve(import.meta.dirname, '../src');
const CODES = ['00e1', '00e9', '00ed', '00f3', '00fa', '00f1', '00ab', '00bb', '00bf', '00a1', '00da', '00c1', '00c9', '00cd', '00d3', '2026', '00b7'];
const BROKEN = new RegExp('(?<![\\\\0-9a-fA-F])(' + CODES.join('|') + ')(?![0-9a-fA-F])', 'g');

async function sources(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) { files.push(...await sources(full)); }
		else if (/\.(?:ts|mts)$/.test(entry.name) && !entry.name.endsWith('.generated.ts')) { files.push(full); }
	}
	return files;
}

test('no source carries a unicode escape that lost its backslash', async () => {
	const findings: string[] = [];
	for (const file of await sources(SOURCE)) {
		const text = await fs.readFile(file, 'utf8');
		text.split('\n').forEach((line, index) => {
			for (const match of line.matchAll(BROKEN)) {
				// `ó` keeps its backslash two characters before the code; anything else is a broken literal.
				if (line.slice(Math.max(0, match.index - 2), match.index) !== '\\u') { findings.push(path.relative(SOURCE, file) + ':' + (index + 1) + ' ' + line.trim().slice(0, 80)); }
			}
		});
	}
	assert.deepEqual(findings, []);
});

test('the scan recognises the broken shapes this check exists for', () => {
	const broken = (line: string): boolean => [...line.matchAll(BROKEN)].some(match => line.slice(Math.max(0, match.index - 2), match.index) !== '\\u');
	assert.deepEqual(
		['t(versi00f3n)', 't(2026 y {0} m00e1s)', 'Restauraci00f3n cancelada', 't(versi\\u00f3n)', 'sha 1a00f3c', '\\u2026 y'].map(broken),
		[true, true, true, false, false, false]);
});
