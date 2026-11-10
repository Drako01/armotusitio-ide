/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureWorkingTree, diffWorkingTree, discardRunChanges, fingerprintFiles } from '../src/native-run-diff.ts';

test('discard refuses missing evidence and preserves newer human edits', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-safe-discard-')));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
	try {
		git('init', '-q');
		git('config', 'user.email', 'test@example.invalid');
		git('config', 'user.name', 'Fixture');
		const target = path.join(root, 'owned.txt');
		await fs.writeFile(target, 'base');
		git('add', 'owned.txt'); git('commit', '-qm', 'fixture');
		const before = await captureWorkingTree(root);
		await fs.writeFile(target, 'agent');
		const after = await captureWorkingTree(root);
		const diff = diffWorkingTree(before, after);
		const hashes = new Map(Object.entries(await fingerprintFiles(root, diff.files)));
		assert.deepEqual((await discardRunChanges(root, diff, new Map())).skipped, ['owned.txt']);
		assert.equal(await fs.readFile(target, 'utf8'), 'agent');
		await fs.writeFile(target, 'human');
		assert.deepEqual((await discardRunChanges(root, diff, hashes)).skipped, ['owned.txt']);
		assert.equal(await fs.readFile(target, 'utf8'), 'human');
		await fs.writeFile(target, 'agent');
		assert.deepEqual((await discardRunChanges(root, diff, hashes)).discarded, ['owned.txt']);
		assert.equal(await fs.readFile(target, 'utf8'), 'base');
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('untrusted report paths never restore files outside the project', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-safe-path-')));
	try {
		const record = { available: true, count: 1, files: [{ path: '../outside.txt', change: 'modified' as const, preexisting: false }] };
		const report = await discardRunChanges(root, record, new Map([['../outside.txt', 'missing']]));
		assert.deepEqual(report.discarded, []);
		assert.deepEqual(report.skipped, ['../outside.txt']);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
