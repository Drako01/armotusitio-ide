/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildAll, archiveApplication, assertPackagedClosed } from './ats-build-all.mts';

async function fixture() {
	const base = await mkdtemp(path.join(os.tmpdir(), 'ats-all-'));
	const root = path.join(base, 'repo');
	await mkdir(path.join(root, '.build', 'ats-autoupdate'), { recursive: true });
	await mkdir(path.join(base, 'ArmotuSitio-IDE-win32-x64'), { recursive: true });
	await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.143.0' }));
	return { base, root, zip: path.join(root, '.build', 'releases', 'ArmotuSitio-IDE-1.143.0-win32-x64.zip'), installer: path.join(root, '.build', 'releases', 'ArmotuSitio-IDE-Setup-1.143.0-x64.exe') };
}

async function cleanup(base: string): Promise<void> {
	const target = path.resolve(base);
	assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('ats-all-'));
	await rm(target, { recursive: true, force: true });
}

function mock(root: string, fail = 0, changeCommit = false) {
	const calls: string[] = []; let changed = false;
	return { calls, assertClosed: async () => { },
		git: async (args: string[]): Promise<string> => args[0] === 'branch' ? 'main' : args[0] === 'rev-parse' ? changed && changeCommit ? 'changed' : 'fixed' : '',
		run: async (file: string, args: string[], _cwd: string, env?: NodeJS.ProcessEnv) => {
			const stage = path.basename(args[0]); calls.push(file === 'pwsh.exe' ? 'archive' : stage);
			if (calls.length === fail) { throw new Error('fixture failure'); }
			if (stage === 'ats-package-windows.mts') {
				const setup = path.join(root, '.build', 'win32-x64', 'user-setup');
				const app = path.resolve(root, '..', 'ArmotuSitio-IDE-win32-x64', 'resources', 'app');
				await mkdir(setup, { recursive: true }); await mkdir(app, { recursive: true });
				await writeFile(path.join(setup, 'VSCodeSetup.exe'), 'installer fixture');
				const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
				await writeFile(path.join(app, 'product.json'), JSON.stringify({ version, commit: 'fixed' }));
				await writeFile(path.join(root, '.build/ats-autoupdate/build-receipt.json'), JSON.stringify({ commit: 'fixed', installerSha256: createHash('sha256').update('installer fixture').digest('hex') })); changed = true;
			}
			if (file === 'pwsh.exe') { await writeFile(env!.ATS_BUILD_ZIP_FILE!, 'ZIP fixture'); }
		}
	};
}

test('unified recipe preserves package, ZIP, development order without running a product build', async () => {
	const f = await fixture(); const deps = mock(f.root);
	try {
		await buildAll(f.root, deps);
		assert.deepEqual(deps.calls, ['ats-package-windows.mts', 'archive', 'ats-build-dev.mts']);
		assert.equal(await readFile(f.zip, 'utf8'), 'ZIP fixture');
		assert.equal(await readFile(f.installer, 'utf8'), 'installer fixture');
		assert.equal(JSON.parse(await readFile(path.resolve(f.root, '..', 'ArmotuSitio-IDE-win32-x64', 'resources', 'app', 'product.json'), 'utf8')).version, '1.143.0');
	} finally { await cleanup(f.base); }
});

test('each failed stage stops subsequent stages and a failed archive preserves the previous ZIP', async () => {
	for (const stage of [1, 2, 3]) {
		const f = await fixture(); const deps = mock(f.root, stage);
		try {
			await mkdir(path.dirname(f.zip), { recursive: true }); await writeFile(f.zip, 'previous ZIP');
			await assert.rejects(buildAll(f.root, deps), /fixture failure/);
			assert.equal(deps.calls.length, stage);
			if (stage <= 2) { assert.equal(await readFile(f.zip, 'utf8'), 'previous ZIP'); }
		} finally { await cleanup(f.base); }
	}
});

test('release names follow the source version without removing the application directory', async () => {
	const f = await fixture();
	try {
		await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ version: '1.144.0' }));
		await buildAll(f.root, mock(f.root));
		const releases = path.dirname(f.zip);
		assert.equal(await readFile(path.join(releases, 'ArmotuSitio-IDE-Setup-1.144.0-x64.exe'), 'utf8'), 'installer fixture');
		assert.equal(await readFile(path.join(releases, 'ArmotuSitio-IDE-1.144.0-win32-x64.zip'), 'utf8'), 'ZIP fixture');
		assert.equal(JSON.parse(await readFile(path.resolve(f.root, '..', 'ArmotuSitio-IDE-win32-x64', 'resources', 'app', 'product.json'), 'utf8')).version, '1.144.0');
	} finally { await cleanup(f.base); }
});

test('mismatched application or installer stops before ZIP and preserves previous release files', async () => {
	for (const scenario of ['version', 'commit', 'installer']) {
		const f = await fixture(); const deps = mock(f.root); const run = deps.run;
		try {
			await mkdir(path.dirname(f.zip), { recursive: true });
			await writeFile(f.zip, 'previous ZIP'); await writeFile(f.installer, 'previous installer');
			deps.run = async (...args) => {
				await run(...args);
				if (scenario === 'installer') {
					await writeFile(path.join(f.root, '.build', 'win32-x64', 'user-setup', 'VSCodeSetup.exe'), 'corrupted');
				} else {
					await writeFile(path.resolve(f.root, '..', 'ArmotuSitio-IDE-win32-x64', 'resources', 'app', 'product.json'), JSON.stringify({ version: scenario === 'version' ? '1.142.0' : '1.143.0', commit: scenario === 'commit' ? 'old' : 'fixed' }));
				}
			};
			await assert.rejects(buildAll(f.root, deps), /does not match/);
			assert.equal(deps.calls.length, 1);
			assert.equal(await readFile(f.installer, 'utf8'), 'previous installer');
			assert.equal(await readFile(f.zip, 'utf8'), 'previous ZIP');
		} finally { await cleanup(f.base); }
	}
});

test('open packaged app, dirty main, another branch or a changed packaging commit prevents completion', async () => {
	for (const scenario of ['open', 'dirty', 'branch', 'commit']) {
		const f = await fixture(); const deps = mock(f.root, 0, scenario === 'commit');
		try {
			if (scenario === 'open') { deps.assertClosed = async () => { throw new Error('Close the packaged IDE'); }; }
			if (scenario === 'dirty' || scenario === 'branch') { deps.git = async args => args[0] === 'branch' ? scenario === 'branch' ? 'feature' : 'main' : 'dirty'; }
			await assert.rejects(buildAll(f.root, deps));
			assert.equal(deps.calls.length, scenario === 'commit' ? 1 : 0);
		} finally { await cleanup(f.base); }
	}
});

test('Windows archive contains the application directory and its file, including paths with spaces', { skip: process.platform !== 'win32' }, async () => {
	const f = await fixture();
	try {
		const application = path.join(f.base, 'Application with spaces'); await mkdir(application);
		await writeFile(path.join(application, 'ArmotuSitio IDE.txt'), 'archive test');
		await assertPackagedClosed(application);
		await archiveApplication(application, f.zip, f.root);
		const command = `$zip=[IO.Compression.ZipFile]::OpenRead($env:ATS_TEST_ARCHIVE);try{ConvertTo-Json -InputObject @($zip.Entries.FullName) -Compress}finally{$zip.Dispose()}`;
		const { stdout } = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem;'+command], { windowsHide: true, env: { ...process.env, ATS_TEST_ARCHIVE: f.zip } });
		assert.ok(JSON.parse(stdout.trim()).some((entry: string) => entry.replaceAll('\\', '/') === 'Application with spaces/ArmotuSitio IDE.txt'));
	} finally { await cleanup(f.base); }
});
