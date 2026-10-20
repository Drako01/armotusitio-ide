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
import { buildAll, archiveApplication, assertPackagedClosed } from './ats-build-all.mts';

async function fixture() {
	const base = await mkdtemp(path.join(os.tmpdir(), 'ats-all-'));
	const root = path.join(base, 'repo');
	await mkdir(path.join(root, '.build', 'ats-autoupdate'), { recursive: true });
	await mkdir(path.join(base, 'VSCode-win32-x64'), { recursive: true });
	return { base, root, zip: path.join(root, '.build', 'releases', 'ArmotuSitio-IDE-win32-x64.zip') };
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
			if (stage === 'ats-package-windows.mts') { await writeFile(path.join(root, '.build/ats-autoupdate/build-receipt.json'), JSON.stringify({ commit: 'fixed' })); changed = true; }
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
