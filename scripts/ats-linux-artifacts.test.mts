/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { armotusitioProduct as product } from '../build/lib/armotusitioProduct.ts';
import { validateIdentity, findLinuxPackage, writeLinuxReceipt } from './ats-linux-artifacts.mts';
import { exclusiveReleaseWorkflow } from './ats-autoupdate.mts';
import { archiveLinuxSources } from './ats-build-linux.mts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

test('receipt replacement preserves the previous result on serialization failure', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'ats-receipt-'));
	try {
		await writeLinuxReceipt(directory, 'x64', { commit: 'old' });
		await assert.rejects(writeLinuxReceipt(directory, 'x64', { invalid: 1n }));
		assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'linux-x64-receipt.json'), 'utf8')), { commit: 'old' });
		await writeLinuxReceipt(directory, 'x64', { commit: 'new' });
		assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'linux-x64-receipt.json'), 'utf8')), { commit: 'new' });
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('WSL template and server identity bind the release revision and full client commit', () => {
	const commit = 'a'.repeat(40);
	const values: Record<string, string> = { version: '1.143.0', commit, release: product.release, quality: 'stable', os: 'linux', arch: 'arm64' };
	const url = product.serverDownloadUrlTemplate.replace(/\$\{(\w+)\}/g, (_, key) => values[key]);
	assert.equal(url, `https://github.com/Drako01/armotusitio-ide/releases/download/ats-v1.143.0-r${product.release}/ArmotuSitio-IDE-REH-linux-arm64-${commit}.tar.gz`);
	assert.ok(!url.includes('${'));
	validateIdentity({ ...product, commit, version: '1.143.0' }, commit, '1.143.0');
	for (const field of ['commit', 'version', 'quality', 'release', 'serverApplicationName', 'serverDataFolderName', 'serverDownloadUrlTemplate']) {
		assert.throws(() => validateIdentity({ ...product, commit, version: '1.143.0', [field]: 'mismatch' }, commit, '1.143.0'));
	}
	for (const malformed of [null, [], 'metadata', 42]) { assert.throws(() => validateIdentity(malformed, commit, '1.143.0')); }
});

test('Linux source exports preserve LF despite Windows autocrlf settings', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'ats-linux-export-'));
	const execute = promisify(execFile);
	const git = (...args: string[]) => execute('git', args, { cwd: directory });
	try {
		await git('init', '-q');
		await git('config', 'core.autocrlf', 'true');
		await writeFile(path.join(directory, '.gitattributes'), '* text=auto\n');
		await writeFile(path.join(directory, 'postinst.template'), '#!/bin/sh\nprintf installed\\n\n');
		await git('add', '.');
		await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-qm', 'fixture');
		const archive = path.join(directory, 'source.tar.gz');
		await archiveLinuxSources(directory, 'HEAD', archive);
		const extracted = path.join(directory, 'extracted');
		await mkdir(extracted);
		await execute('tar', ['-xzf', archive, '-C', extracted]);
		assert.equal(await readFile(path.join(extracted, 'postinst.template'), 'utf8'), '#!/bin/sh\nprintf installed\\n\n');
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('future release CI cannot publish from a branch, another repository, or alongside an active old workflow', () => {
	const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Drako01/armotusitio-ide', GITHUB_WORKFLOW: 'ArmotuSitio Release', GITHUB_REF: 'refs/tags/ats-v1.143.0-r2' };
	const workflows = { total_count: 2, workflows: [{ state: 'active', path: '.github/workflows/ats-release.yml' }, { state: 'disabled_manually', path: '.github/workflows/old.yml' }] };
	assert.equal(exclusiveReleaseWorkflow(env, workflows), true);
	for (const changed of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_WORKFLOW: 'Other' }, { GITHUB_REF: 'refs/heads/main' }]) { assert.equal(exclusiveReleaseWorkflow({ ...env, ...changed }, workflows), false); }
	assert.equal(exclusiveReleaseWorkflow(env, { ...workflows, total_count: 101 }), false);
	assert.equal(exclusiveReleaseWorkflow(env, { total_count: 2, workflows: workflows.workflows.map(entry => ({ ...entry, state: 'active' })) }), false);
});

test('RPM selection ignores rpmbuild staging copies but rejects multiple published packages', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'ats-rpm-output-'));
	try {
		const staging = path.join(directory, 'rpmbuild', 'RPMS', 'x86_64');
		await mkdir(staging, { recursive: true });
		await writeFile(path.join(staging, 'armotusitio-ide.rpm'), 'internal copy');
		await assert.rejects(findLinuxPackage(directory, '.rpm'), /Expected exactly one/);
		const published = path.join(directory, 'armotusitio-ide.rpm');
		await writeFile(published, 'published package');
		assert.equal(await findLinuxPackage(directory, '.rpm'), published);
		await writeFile(path.join(directory, 'unexpected.rpm'), 'ambiguous output');
		await assert.rejects(findLinuxPackage(directory, '.rpm'), /Expected exactly one/);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
