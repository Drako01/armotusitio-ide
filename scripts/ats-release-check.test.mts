/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { auditRelease } from './ats-release-check.mts';
import { armotusitioManifestName, armotusitioRepository } from '../src/vs/platform/update/common/armotusitioUpdate.ts';

test('artifact dry-run verifies signatures, local files and published digests using read-only GitHub calls', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'ats-release-check-'));
	try {
		const directory = path.join(root, '.build/releases'); await mkdir(directory, { recursive: true });
		const keys = generateKeyPairSync('ed25519');
		const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
		const assets = Object.fromEntries(['win32-x64-user', 'win32-x64-archive'].map((platform, index) => [platform, { name: index ? 'fixture.zip' : 'fixture.exe', size: 7, sha256: createHash('sha256').update('fixture').digest('hex') }]));
		const commit = 'a'.repeat(40);
		const bytes = Buffer.from(JSON.stringify({ schema: 1, repository: armotusitioRepository, channel: 'stable', revision: 1, baseVersion: '1.144.0', commit, publishedAt: new Date().toISOString(), assets }));
		const envelope = JSON.stringify({ payload: bytes.toString('base64'), signature: sign(null, bytes, keys.privateKey).toString('base64') });
		const files = { 'fixture.exe': 'fixture', 'fixture.zip': 'fixture', [armotusitioManifestName]: envelope, 'SHA256SUMS.txt': Object.values(assets).map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n' };
		for (const [name, content] of Object.entries(files)) { await writeFile(path.join(directory, name), content); }
		const remote = { tag_name: 'ats-v1.144.0-r1', target_commitish: commit, draft: false, assets: Object.entries(files).map(([name, content]) => ({ name, state: 'uploaded', size: Buffer.byteLength(content), digest: `sha256:${createHash('sha256').update(content).digest('hex')}` })) };
		const execute = async (file: string, args: string[]) => {
			assert.ok(file === 'git' && args[0] === 'merge-base' || file === 'gh' && args[0] === 'api');
			return file === 'gh' ? JSON.stringify([[remote]]) : '';
		};
		await auditRelease(root, publicKey, execute);
		remote.assets[0].digest = `sha256:${'0'.repeat(64)}`;
		await assert.rejects(auditRelease(root, publicKey, execute), /remote asset differs/);
		await writeFile(path.join(directory, 'fixture.zip'), 'changed');
		await assert.rejects(auditRelease(root, publicKey, execute), /differs from its signature/);
		await assert.rejects(auditRelease(root, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(), execute), /signature is invalid/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
