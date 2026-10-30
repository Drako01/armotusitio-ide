/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { releaseStages } from './ats-release-state.mts';
import { reusableLinux } from './ats-build-linux.mts';

test('resume preserves completed stages, retries failures and invalidates modified outputs or source', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'ats-stage-'));
	try {
		const output = path.join(root, 'output'); let calls = 0;
		const work = async () => { calls++; await writeFile(output, 'complete'); };
		let stage = await releaseStages(root, 'source-a');
		await stage('first', [output], work);
		await assert.rejects(stage('second', [output], async () => { throw new Error('interrupted'); }));
		stage = await releaseStages(root, 'source-a');
		await stage('first', [output], work); assert.equal(calls, 1);
		await stage('second', [output], work); assert.equal(calls, 2);
		await writeFile(output, 'tampered');
		await stage('first', [output], work); assert.equal(calls, 3);
		stage = await releaseStages(root, 'source-b');
		await stage('first', [output], work); assert.equal(calls, 4);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux reuse requires every architecture asset, the same source and valid hashes', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'ats-linux-reuse-'));
	try {
		const commit = 'a'.repeat(40);
		await writeFile(path.join(root, 'server.tar.gz'), 'fixture');
		const receipt = { commit, version: '1.144.0', arch: 'arm64', quality: 'stable', serverHelp: true, assets: { 'server-linux-arm64': { name: 'server.tar.gz', size: 7, sha256: createHash('sha256').update('fixture').digest('hex') } } };
		await writeFile(path.join(root, 'linux-arm64-receipt.json'), JSON.stringify(receipt));
		assert.equal(await reusableLinux(root, commit, '1.144.0', 'arm64'), true);
		assert.equal(await reusableLinux(root, 'b'.repeat(40), '1.144.0', 'arm64'), false);
		assert.equal(await reusableLinux(root, commit, '1.144.0', 'x64'), false);
		await writeFile(path.join(root, 'server.tar.gz'), 'changed');
		assert.equal(await reusableLinux(root, commit, '1.144.0', 'arm64'), false);
		receipt.assets['server-linux-arm64'].name = '../unsafe';
		await writeFile(path.join(root, 'linux-arm64-receipt.json'), JSON.stringify(receipt));
		assert.equal(await reusableLinux(root, commit, '1.144.0', 'arm64'), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});
