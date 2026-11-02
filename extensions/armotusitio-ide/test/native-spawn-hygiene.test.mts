/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const SOURCE = join(import.meta.dirname, '..', 'src');
const LAUNCHERS = /(?<![\w.])(?:spawn|spawnSync|execFile|execFileSync|executeFile|exec|execSync)\s*\(/g;
/** Launches that may skip `windowsHide`, each with the reason. Empty on purpose. */
const EXCEPTIONS: readonly string[] = [];

/** Text between the parentheses of the call that opens at `open`, tolerant of nested parentheses and strings. */
function callArguments(text: string, open: number): string {
	let depth = 0;
	let quote = '';
	for (let index = open; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === '\\') { index++; } else if (char === quote) { quote = ''; }
			continue;
		}
		if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
		if (char === '(') { depth++; }
		if (char === ')' && --depth === 0) { return text.slice(open, index + 1); }
	}
	return text.slice(open);
}

/** Launch sites whose options never set `windowsHide: true`, as `file:line`. */
export function findUnhiddenLaunches(file: string, text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(LAUNCHERS)) {
		const line = text.slice(0, match.index).split('\n').length;
		const head = text.slice(text.lastIndexOf('\n', match.index) + 1, match.index);
		// Comments and prose mentioning a launcher are not calls.
		if (/^\s*(?:\/\/|\*|\/\*)/.test(head) || /['"`]\s*$/.test(head)) { continue; }
		const args = callArguments(text, match.index! + match[0].length - 1);
		if (!/windowsHide:\s*true/.test(args)) { found.push(file + ':' + line); }
	}
	return found;
}

describe('child process hygiene', () => {
	test('every launch in src hides the console window on Windows', () => {
		const offenders: string[] = [];
		for (const name of readdirSync(SOURCE).filter(entry => entry.endsWith('.ts'))) {
			const text = readFileSync(join(SOURCE, name), 'utf8').replace(/\r\n/g, '\n');
			if (!/node:child_process|child_process/.test(text)) { continue; }
			offenders.push(...findUnhiddenLaunches(name, text).filter(site => !EXCEPTIONS.includes(site)));
		}
		assert.deepEqual(offenders, []);
	});

	test('the scanner flags a missing flag and accepts a multiline hidden launch', () => {
		const bad = 'import { spawn } from \'node:child_process\';\nspawn(a, b, { cwd });\n';
		const good = 'spawn(a, b, {\n\tcwd,\n\twindowsHide: true,\n});\n';
		assert.deepEqual(findUnhiddenLaunches('x.ts', bad), ['x.ts:2']);
		assert.deepEqual(findUnhiddenLaunches('x.ts', good), []);
	});
});
