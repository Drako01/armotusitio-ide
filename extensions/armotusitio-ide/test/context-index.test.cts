/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { IncrementalContextIndex, indexProject } = require('../src/context.ts');

async function fixture(files: Record<string, string | Buffer>) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-context-rank-')));
	for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
	return { root, cleanup: () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test('hybrid context search ranks VS Code symbols, lexical contents and file names deterministically', async () => {
	const project = await fixture({ 'src/a.ts': 'export function authenticateUser() {}', 'src/b.ts': 'const authenticate = true;', 'docs/authenticate.md': 'unrelated', 'src/other.ts': 'nothing' });
	try {
		const index = new IncrementalContextIndex(project.root);
		const first = await index.search('authenticate', { symbols: [{ path: 'src/a.ts', name: 'authenticateUser' }, { path: '../outside.ts', name: 'authenticate' }, { path: '.env', name: 'authenticate' }] });
		const cached = await index.search('authenticate', { symbols: [{ path: 'src/a.ts', name: 'authenticateUser' }] });
		assert.deepEqual({ files: first.files, second: cached.files, firstReads: first.stats.readFiles, cachedReads: cached.stats.readFiles, hits: cached.stats.cacheHits }, {
			files: ['src/a.ts', 'docs/authenticate.md', 'src/b.ts'], second: ['src/a.ts', 'docs/authenticate.md', 'src/b.ts'], firstReads: 4, cachedReads: 0, hits: 4
		});
		await fs.writeFile(path.join(project.root, 'src/b.ts'), 'const otherVariable = true;');
		const changed = await index.search('authenticate');
		assert.deepEqual({ files: changed.files, reads: changed.stats.readFiles }, { files: ['docs/authenticate.md', 'src/a.ts'], reads: 1 });
		await fs.writeFile(path.join(project.root, 'src/new.ts'), 'authenticate();');
		index.invalidate('src/new.ts');
		assert.ok((await index.search('authenticate')).files.includes('src/new.ts'));
	} finally { await project.cleanup(); }
});

test('context inventory excludes repository ignores, credential names, generated/dependency trees and linked paths', async () => {
	const project = await fixture({ '.gitignore': 'private/\n', 'src/app.ts': 'normal', 'private/hidden.ts': 'authenticate', 'credentials.json': '{"password":"private"}', 'src/code.generated.ts': 'generated', 'package-lock.json': '{}', 'node_modules/module/index.ts': 'private', '.codex/config.json': '{}', 'src/.env.production': 'private', 'dist/app.ts': 'built' });
	try {
		execFileSync('git', ['init', '--quiet', project.root], { windowsHide: true });
		await fs.symlink(path.join(project.root, 'private'), path.join(project.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
		const listed = await indexProject(project.root);
		assert.deepEqual(listed.files, ['src/app.ts']);
		const index = new IncrementalContextIndex(project.root);
		assert.deepEqual((await index.search('authenticate', { symbols: [{ path: 'private/hidden.ts', name: 'authenticate' }, { path: 'credentials.json', name: 'authenticate' }] })).files, []);
	} finally { await project.cleanup(); }
});

test('context content is bounded, binary-safe and cancellation rejects stale requests', async () => {
	const project = await fixture({ 'src/large.ts': 'authenticate '.repeat(30000), 'src/binary.ts': Buffer.from([0, 1, 2, 3]), 'src/value.ts': 'const value = true;' });
	try {
		const index = new IncrementalContextIndex(project.root);
		const result = await index.search('authenticate');
		assert.deepEqual({ files: result.files, reads: result.stats.readFiles, bytes: result.stats.readBytes }, { files: [], reads: 2, bytes: 23 });
		const cancelled = new AbortController(); cancelled.abort();
		await assert.rejects(index.search('value', { signal: cancelled.signal }), { name: 'AbortError' });
		const ongoing = new AbortController();
		index.invalidate();
		const promise = index.search('value', { signal: ongoing.signal }); ongoing.abort();
		await assert.rejects(promise, { name: 'AbortError' });
	} finally { await project.cleanup(); }
});


test('read-only git inventory propagates cancellation to its subprocess', async () => {
	const { gitOutput } = require('../src/native-git.ts');
	const project = await fixture({ 'src/a.ts': 'safe' });
	try {
		const controller = new AbortController();
		const pending = gitOutput(project.root, ['--version'], controller.signal);
		controller.abort();
		await assert.rejects(pending, { name: 'AbortError' });
	} finally { await project.cleanup(); }
});
