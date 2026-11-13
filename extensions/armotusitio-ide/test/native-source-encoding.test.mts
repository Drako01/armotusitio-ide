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
const ESCAPE = String.fromCharCode(92) + 'u';

/** A code point outside an escape: standalone, or glued to a word with non-hex letters (`id00e9ntica`, `00bfConfirmar`). */
function broken(line: string): boolean {
	if ([...line.matchAll(BROKEN)].some(match => line.slice(Math.max(0, match.index - 2), match.index) !== ESCAPE)) { return true; }
	return [...line.matchAll(/[A-Za-z0-9]+/g)].some(word => /[g-zG-Z]/.test(word[0].replace(/^u(?=[0-9a-fA-F]{4})/, '')) && CODES.some(code => {
		for (let at = word[0].indexOf(code); at !== -1; at = word[0].indexOf(code, at + 1)) {
			if (line.slice(word.index + at - 2, word.index + at) !== ESCAPE) { return true; }
		}
		return false;
	}));
}

async function sources(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) { files.push(...await sources(full)); }
		else if (/\.(?:ts|mts)$/.test(entry.name) && !entry.name.endsWith('.generated.ts')) { files.push(full); }
	}
	return files;
}

/** The manifest and its translations carry user-facing copy too. */
async function manifests(): Promise<string[]> {
	const root = path.resolve(SOURCE, '..');
	return (await fs.readdir(root)).filter(name => name === 'package.json' || (name.startsWith('package.nls') && name.endsWith('.json'))).map(name => path.join(root, name));
}

test('no source carries a unicode escape that lost its backslash', async () => {
	const findings: string[] = [];
	for (const file of [...await sources(SOURCE), ...await sources(path.resolve(SOURCE, '../resources')), ...await manifests()]) {
		const text = await fs.readFile(file, 'utf8');
		text.split('\n').forEach((line, index) => {
			if (broken(line)) { findings.push(path.relative(SOURCE, file) + ':' + (index + 1) + ' ' + line.trim().slice(0, 80)); }
		});
	}
	assert.deepEqual(findings, []);
});

test('the scan recognises the broken shapes this check exists for', () => {
	assert.deepEqual(
		['t(versi00f3n)', 't(2026 y {0} m00e1s)', 'Restauraci00f3n cancelada', 'huella id00e9ntica', '00bfConfirmar?', 't(versi\\u00f3n)', 'sha 1a00f3c', '\\u2026 y'].map(broken),
		[true, true, true, true, true, false, false, false]);
});
