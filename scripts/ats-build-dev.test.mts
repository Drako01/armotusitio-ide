/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { buildDevelopment } from './ats-build-dev.mts';

/** Use small stand-in outputs; tests must never run a product build. */
async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'ats-build-dev-'));
	const welcome = 'vs/workbench/contrib/welcomeGettingStarted';
	for (const file of [`src/${welcome}/common/media/armotusitio-logo.png`, `out/${welcome}/common/media/armotusitio-logo.png`, `out/${welcome}/browser/gettingStarted.js`, ...['extension.js', 'home.js', 'chat.js'].map(file => `extensions/armotusitio-ide/dist/${file}`)]) {
		const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, file.endsWith('gettingStarted.js') ? 'armotusitio-logo.png' : 'fixture');
	}
	return root;
}

/** Delete only this test's verified temporary fixture directory. */
async function removeFixture(root: string): Promise<void> {
	const target = path.resolve(root);
	assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('ats-build-dev-'));
	await rm(target, { recursive: true, force: true });
}

test('development recipe builds all lanes plus the custom extension and records the fixed commit', async () => {
	const root = await fixture(); const calls: string[][] = [];
	try {
		const git = async (args: string[]) => args[0] === 'branch' ? 'main' : args[0] === 'rev-parse' ? 'fixed-commit' : '';
		await buildDevelopment(root, async args => { calls.push(args); }, git);
		assert.equal(calls.length, 3);
		assert.equal(path.basename(calls[0][0]), 'tsc');
		assert.deepEqual(calls[1], [path.join(root, 'build', 'next', 'build-fast.ts'), '--force']);
		assert.deepEqual(calls[2], [path.join(root, 'extensions', 'armotusitio-ide', 'esbuild.mts')]);
		const receipt = JSON.parse(await readFile(path.join(root, '.build/ats-autoupdate/dev-build-receipt.json'), 'utf8'));
		assert.equal(receipt.commit, 'fixed-commit'); assert.deepEqual(Object.keys(receipt.extensionOutputs), ['extension.js', 'home.js', 'chat.js']);
	} finally { await removeFixture(root); }
});

test('development recipe rejects dirty sources or another branch before running any compiler', async () => {
	for (const [branch, dirty] of [['feature', ''], ['main', ' M tracked.ts']]) {
		const root = await fixture(); let calls = 0;
		try {
			await assert.rejects(buildDevelopment(root, async () => { calls++; }, async args => args[0] === 'branch' ? branch : dirty));
			assert.equal(calls, 0);
		} finally { await removeFixture(root); }
	}
});

test('development recipe fails closed if HEAD changes or an old welcome output remains', async () => {
	for (const changeCommit of [true, false]) {
		const root = await fixture(); let headReads = 0;
		try {
			if (!changeCommit) { await writeFile(path.join(root, 'out/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.js'), 'old output'); }
			const git = async (args: string[]) => args[0] === 'branch' ? 'main' : args[0] === 'rev-parse' ? changeCommit && headReads++ > 0 ? 'new' : 'original' : '';
			await assert.rejects(buildDevelopment(root, async () => { }, git), changeCommit ? /Source changed/ : /logo was not updated/);
			await assert.rejects(readFile(path.join(root, '.build/ats-autoupdate/dev-build-receipt.json')), { code: 'ENOENT' });
		} finally { await removeFixture(root); }
	}
});
