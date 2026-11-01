/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sensitiveScopeDigest } from '../src/native-sensitive-scope.ts';

test('detects nested ignored credentials with identical size', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-scope-'));
	try {
		const canonical = await fs.realpath(root);
		await fs.mkdir(path.join(root, 'apps', 'backend'), { recursive: true });
		await fs.writeFile(path.join(root, 'apps', 'backend', '.env'), 'KEY=abc');
		const before = await sensitiveScopeDigest(canonical);
		await fs.writeFile(path.join(root, 'apps', 'backend', '.env'), 'KEY=xyz');
		const after = await sensitiveScopeDigest(canonical);
		assert.equal(before.entries, 1);
		assert.notEqual(before.digest, after.digest);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('ignores dependency directories but fails closed on oversized secrets', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-limits-'));
	try {
		const canonical = await fs.realpath(root);
		await fs.mkdir(path.join(root, 'node_modules'));
		await fs.writeFile(path.join(root, 'node_modules', '.env'), 'not part of source');
		assert.equal((await sensitiveScopeDigest(canonical)).entries, 0);
		await fs.writeFile(path.join(root, '.env'), Buffer.alloc(1024 * 1024 + 1));
		await assert.rejects(sensitiveScopeDigest(canonical), /HARNESS_SENSITIVE_FILE_TOO_LARGE/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('skips Harness output and tool caches by path or name, but not same-named folders elsewhere', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-skips-'));
	try {
		const canonical = await fs.realpath(root);
		for (const skipped of ['.harness/runtime/a', '.harness/state', 'infra/demo/.npm-cache/_cacache']) {
			await fs.mkdir(path.join(root, skipped), { recursive: true });
			await fs.writeFile(path.join(root, skipped, '.env'), 'generated');
		}
		assert.equal((await sensitiveScopeDigest(canonical)).entries, 0);
		await fs.mkdir(path.join(root, 'apps', 'runtime'), { recursive: true });
		await fs.writeFile(path.join(root, 'apps', 'runtime', '.env'), 'KEY=abc');
		assert.equal((await sensitiveScopeDigest(canonical)).entries, 1);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('does not trip on the deep, generated trees a Harness run leaves behind', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-harness-output-'));
	try {
		const canonical = await fs.realpath(root);
		const toolchain = path.join(root, '.harness', 'runtime', 'output', 'toolchain', ...Array.from({ length: 16 }, (_, i) => 'level' + i));
		await fs.mkdir(toolchain, { recursive: true });
		await fs.mkdir(path.join(root, 'infra', 'tf', '.terraform', 'providers', 'registry', 'hashicorp', 'aws', '6.0.0', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), { recursive: true });
		assert.equal((await sensitiveScopeDigest(canonical)).entries, 0);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

/** Real repository on disk: git, not a directory walk, decides what counts as project content. */
async function withRepository(gitignore: string, body: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-repo-'));
	try {
		const canonical = await fs.realpath(root);
		execFileSync('git', ['init', '-q'], { cwd: canonical });
		await fs.writeFile(path.join(canonical, '.gitignore'), gitignore);
		await body(canonical);
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('git mode: covers ignored credentials, including inside a wholly ignored folder', async () => {
	await withRepository(['.env', 'private/'].join('\n'), async root => {
		await fs.mkdir(path.join(root, 'private', 'keys'), { recursive: true });
		await fs.writeFile(path.join(root, '.env'), 'KEY=abc');
		await fs.writeFile(path.join(root, 'private', 'keys', 'server.pem'), 'one');
		const before = await sensitiveScopeDigest(root);
		await fs.writeFile(path.join(root, 'private', 'keys', 'server.pem'), 'two');
		const after = await sensitiveScopeDigest(root);
		assert.deepEqual({ entries: before.entries, unscanned: before.unscanned }, { entries: 2, unscanned: [] });
		assert.notEqual(before.digest, after.digest);
	});
});

test('git mode: never walks ignored Harness output or tool caches, however large or deep', async () => {
	await withRepository(['.harness/runtime/', '.npm-cache/'].join('\n'), async root => {
		const deep = path.join(root, '.harness', 'runtime', 'output', ...Array.from({ length: 20 }, (_, i) => 'level' + i));
		await fs.mkdir(deep, { recursive: true });
		await fs.writeFile(path.join(deep, '.env'), 'generated');
		await fs.mkdir(path.join(root, '.npm-cache', '_cacache'), { recursive: true });
		await fs.writeFile(path.join(root, '.npm-cache', '_cacache', '.npmrc'), 'generated');
		const scan = await sensitiveScopeDigest(root);
		assert.deepEqual({ entries: scan.entries, unscanned: scan.unscanned }, { entries: 0, unscanned: [] });
	});
});

test('reports, instead of failing, an ignored tree beyond the directory budget', async () => {
	await withRepository('generated/', async root => {
		await Promise.all(Array.from({ length: 6001 }, (_, i) => fs.mkdir(path.join(root, 'generated', 'sub', String(i)), { recursive: true })));
		await fs.writeFile(path.join(root, '.env'), 'KEY=abc');
		const scan = await sensitiveScopeDigest(root);
		assert.deepEqual({ entries: scan.entries, unscanned: scan.unscanned }, { entries: 1, unscanned: ['generated/sub'] });
	});
});

test('reports, instead of failing, an ignored tree beyond the depth limit', async () => {
	await withRepository('vendored/', async root => {
		await fs.mkdir(path.join(root, 'vendored', 'sdk', ...Array.from({ length: 16 }, (_, i) => 'level' + i)), { recursive: true });
		assert.deepEqual((await sensitiveScopeDigest(root)).unscanned, ['vendored/sdk/level0']);
	});
});

test('an unscanned tree is part of the digest, so a newly unscanned folder is a change', async () => {
	await withRepository('vendored/', async root => {
		const before = await sensitiveScopeDigest(root);
		await fs.mkdir(path.join(root, 'vendored', 'sdk', ...Array.from({ length: 16 }, (_, i) => 'level' + i)), { recursive: true });
		assert.notEqual(before.digest, (await sensitiveScopeDigest(root)).digest);
	});
});

test('without git it walks the tree and reports what it cannot analyze', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-nogit-'));
	const originalPath = { PATH: process.env.PATH, Path: process.env.Path };
	try {
		const canonical = await fs.realpath(root);
		await fs.mkdir(path.join(root, 'apps', 'api'), { recursive: true });
		await fs.writeFile(path.join(root, 'apps', 'api', '.env'), 'KEY=abc');
		await fs.mkdir(path.join(root, 'vendored', 'sdk', ...Array.from({ length: 16 }, (_, i) => 'level' + i)), { recursive: true });
		process.env.PATH = process.env.Path = root;
		const scan = await sensitiveScopeDigest(canonical);
		assert.deepEqual({ entries: scan.entries, unscanned: scan.unscanned }, { entries: 1, unscanned: ['vendored/sdk/level0'] });
	} finally {
		for (const [name, value] of Object.entries(originalPath)) { if (value === undefined) { delete process.env[name]; } else { process.env[name] = value; } }
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('does not follow secret symlinks into unrelated directories', { skip: process.platform === 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-links-'));
	const external = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-external-'));
	try {
		await fs.writeFile(path.join(external, 'secret'), 'a');
		await fs.symlink(path.join(external, 'secret'), path.join(root, '.env'));
		const before = await sensitiveScopeDigest(await fs.realpath(root));
		await fs.writeFile(path.join(external, 'secret'), 'b');
		const after = await sensitiveScopeDigest(await fs.realpath(root));
		assert.equal(before.digest, after.digest);
		assert.equal(before.entries, 1);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(external, { recursive: true, force: true });
	}
});
