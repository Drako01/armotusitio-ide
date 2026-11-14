/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { storeVersion, planStoreRelease } from './ats-store-release.mts';

test('Store versions preserve patch and revision ordering and reject overflow', () => {
	assert.equal(storeVersion('ats-v1.146.0-r2'), '1.146.2.0');
	assert.equal(storeVersion('ats-v1.146.1-r1'), '1.146.1001.0');
	for (const tag of ['ats-v1.146.0-r1000', 'ats-v1.146.66-r1', 'ats-v0.146.0-r1', 'ats-v1.146.0-r0', '../main', 'ats-v1.146.0-r1-beta']) {
		assert.throws(() => storeVersion(tag));
	}
});

test('Store release selection fails closed on unpublished, ambiguous or unverified assets', () => {
	const tag = 'ats-v1.146.0-r2';
	const asset = { name: 'ArmotuSitio-IDE-1.146.0-r2-win32-x64.zip', browser_download_url: `https://github.com/Drako01/armotusitio-ide/releases/download/${tag}/ArmotuSitio-IDE-1.146.0-r2-win32-x64.zip`, digest: `sha256:${'a'.repeat(64)}`, size: 123 };
	const release = { tag_name: tag, draft: false, prerelease: false, assets: [asset] };
	assert.equal(planStoreRelease(release, tag).sha256, 'a'.repeat(64));
	for (const invalid of [null, { ...release, draft: true }, { ...release, prerelease: true }, { ...release, tag_name: 'other' }, { ...release, assets: [] }, { ...release, assets: [asset, asset] }, ...[{ digest: '' }, { browser_download_url: 'https://example.com/file.zip' }, { size: -1 }].map(change => ({ ...release, assets: [{ ...asset, ...change }] }))]) {
		assert.throws(() => planStoreRelease(invalid, tag));
	}
});

test('MSIX builder rejects altered archives before extraction or packaging', { skip: process.platform !== 'win32' }, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-msix-integrity-'));
	try {
		const archive = path.join(directory, 'release.zip');
		await fs.writeFile(archive, 'altered release bytes');
		await assert.rejects(promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'ats-package-msix.ps1'), '-Archive', archive, '-ExpectedSha256', '0'.repeat(64), '-Version', '1.146.2.0'], { windowsHide: true }), /Release archive SHA256 mismatch/);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
