/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signingConfiguration, signingTargets } from './ats-authenticode.mts';

test('release signing configuration fails closed and verification pins a publisher', () => {
	assert.throws(() => signingConfiguration({}), /ATS_WINDOWS_PUBLISHER/);
	assert.throws(() => signingConfiguration({ ATS_WINDOWS_PUBLISHER: 'CN=Example' }), /ATS_SIGNTOOL/);
	assert.doesNotThrow(() => signingConfiguration({ ATS_WINDOWS_PUBLISHER: 'CN=Example' }, false));
	const env = Object.fromEntries(['ATS_WINDOWS_PUBLISHER', 'ATS_SIGNTOOL', 'ATS_SIGNING_DLIB', 'ATS_SIGNING_ACCOUNT', 'ATS_SIGNING_PROFILE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].map(key => [key, 'fixture']));
	assert.throws(() => signingConfiguration({ ...env, ATS_SIGNING_ENDPOINT: 'https://attacker.example' }), /endpoint/);
	assert.doesNotThrow(() => signingConfiguration({ ...env, ATS_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net' }));
});

test('targets include nested PE modules and reject links outside the build', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sign-'));
	try {
		await fs.mkdir(path.join(directory, 'nested'));
		for (const file of ['app.exe', 'nested/module.node', 'nested/helper.dll', 'readme.txt']) { await fs.writeFile(path.join(directory, file), 'fixture'); }
		assert.deepEqual((await signingTargets(directory)).map(file => path.relative(directory, file).replaceAll('\\', '/')), ['app.exe', 'nested/helper.dll', 'nested/module.node']);
		await assert.rejects(signingTargets(path.join(directory, 'readme.txt')), /Unsupported/);
		await fs.symlink(os.tmpdir(), path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
		await assert.rejects(signingTargets(directory), /symbolic links/);
		await fs.unlink(path.join(directory, 'escape'));
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('real Windows verifier refuses an unsigned file without contacting a signing service', { skip: process.platform !== 'win32' }, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sign-unsigned-'));
	try {
		const file = path.join(directory, 'unsigned.exe');
		await fs.writeFile(file, 'unsigned fixture');
		await assert.rejects(promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'ats-authenticode.ps1'), '-Mode', 'verify', '-Target', file], { env: { ...process.env, ATS_WINDOWS_PUBLISHER: 'CN=Example' }, windowsHide: true }), /Missing valid timestamped Authenticode/);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('packaging signs payload before Inno, signs uninstaller and verifies before receipt and publication', async () => {
	const read = (file: string) => fs.readFile(new URL(file, import.meta.url), 'utf8');
	const packaging = await read('./ats-package-windows.mts');
	assert.ok(packaging.indexOf(`authenticode('sign', application)`) < packaging.indexOf(`'--ats-sign'`));
	assert.ok(packaging.indexOf(`authenticode('verify', application)`) < packaging.indexOf(`'build-receipt.json'`));
	assert.match(await read('../build/win32/code.iss'), /#ifdef Sign\s+SignTool=esrp\s+SignedUninstaller=yes/);
	const publishing = await read('./ats-autoupdate.mts');
	assert.ok(publishing.indexOf(`authenticode('verify', path.join(directory, asset.name))`) < publishing.indexOf(`['release', 'create'`));
	assert.match(await read('../.github/workflows/ats-release.yml'), /environment: windows-signing/);
});
