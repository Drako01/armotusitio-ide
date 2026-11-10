/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand } from '../src/native-command-runner.ts';

test('saved logs, observer and returned tail redact credentials split across stdout and stderr chunks', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-private-log-')));
	try {
		const source = `const pieces = [
			[process.stdout, 'safe stdout\\n\\x1b[31mgh'],
			[process.stderr, 'password="private'],
			[process.stdout, 'p_' + 'A'.repeat(15)],
			[process.stderr, '\\nmultiline"\\n'],
			[process.stdout, 'A'.repeat(21) + '\\x1b[0m\\n'],
			[process.stderr, 'Bearer ' + 'private-bearer' + '\\n'],
			[process.stdout, Buffer.from([0xc3])],
			[process.stdout, Buffer.from([0xa9, 0x0a])]
		];
		for (const [stream, text] of pieces) { stream.write(text); await new Promise(resolve => setTimeout(resolve, 15)); }
		process.exitCode = 7;`;
		await fs.writeFile(path.join(root, 'output.mjs'), source);
		const observed: string[] = [];
		const result = await runCommand({ root, cwd: '.', command: 'node', args: ['output.mjs'], env: { ...process.env }, logDirectory: path.join(root, 'logs'), observe: text => observed.push(text) });
		const log = await fs.readFile(result.logFile, 'utf8');
		const all = log + result.output + observed.join('');
		assert.deepEqual({
			exit: result.exitCode, logError: result.logError,
			leaked: ['ghp_' + 'A'.repeat(36), 'private', 'multiline'].some(secret => all.includes(secret)),
			redacted: log.includes('[redacted]'), utf8: log.includes('\u00e9'), safe: log.includes('safe stdout'),
			bounded: Buffer.byteLength(log) <= 64 * 1024 * 1024
		}, { exit: 7, logError: undefined, leaked: false, redacted: true, utf8: true, safe: true, bounded: true });
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});


test('log disk failures are classified without changing command exit or hiding sanitized output', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-log-failure-')));
	try {
		await fs.writeFile(path.join(root, 'output.cjs'), 'console.log("done token=private"); process.exitCode = 9;');
		const blocker = path.join(root, 'regular-file');
		await fs.writeFile(blocker, '');
		const result = await runCommand({ root, cwd: '.', command: 'node', args: ['output.cjs'], env: { ...process.env }, logDirectory: path.join(root, 'logs') }, () => createWriteStream(path.join(blocker, 'impossible.log')));
		assert.deepEqual({ exit: result.exitCode, classified: !!result.logError, output: result.output, leaked: result.output.includes('private') }, { exit: 9, classified: true, output: 'done token=[redacted]\n', leaked: false });
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
