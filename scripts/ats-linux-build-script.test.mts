/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { linuxRunArgs } from './ats-build-linux.mts';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'build', 'armotusitio', 'linux-build.sh');
const bash = process.env.ATS_TEST_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');

/** Run one function of the container script inside an isolated fixture; Docker is never used. */
async function shell(cwd: string, command: string): Promise<string> {
	return new Promise((resolve, reject) => {
		// $0 must differ from the sourced path so the script does not run its main build.
		const child = spawn(bash, ['-c', `set -euo pipefail; source "$1"; ${command}`, 'ats-test', script.replaceAll('\\', '/')], { cwd, windowsHide: true });
		let output = '', errors = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { errors += chunk; });
		child.once('error', reject);
		child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`bash exited ${code}: ${output}${errors}`)));
	});
}

async function write(file: string, content = ''): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, content);
}

async function exists(file: string): Promise<boolean> {
	return access(file).then(() => true, () => false);
}

async function fixture(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'ats-linux-build-'));
	await write(path.join(directory, 'next', 'package.json'), '{}');
	await write(path.join(directory, 'next', 'extensions', 'kept', 'package.json'), '{}');
	await write(path.join(directory, 'next', 'src', 'new.ts'), 'new');
	await shell(directory, 'tar -czf archive.tar.gz -C next .');
	const work = path.join(directory, 'work', 'source');
	await write(path.join(work, 'node_modules', 'root-dependency', 'index.js'), 'root');
	await write(path.join(work, 'extensions', 'kept', 'node_modules', 'kept-dependency', 'index.js'), 'kept');
	await write(path.join(work, 'extensions', 'removed', 'node_modules', 'removed-dependency', 'index.js'), 'removed');
	await write(path.join(work, '.build', 'sysroots', 'sysroot.txt'), 'sysroot');
	await write(path.join(work, '.build', 'extensions', 'stale.js'), 'stale build output');
	await write(path.join(work, 'out-build', 'stale.js'), 'stale build output');
	await write(path.join(work, 'src', 'deleted.ts'), 'deleted source');
	await write(path.join(directory, 'work', 'dependencies-ready'), 'fingerprint\n');
	return directory;
}

test('Linux builds reuse one work volume per architecture and keep logs with the commit inputs', () => {
	const args = linuxRunArgs('arm64', 'a'.repeat(40), { source: '/in/source.tar.gz', output: '/out', logs: '/logs-host' }, 'image');
	assert.deepEqual(args.filter(arg => arg.startsWith('type=')), [
		'type=bind,source=/in/source.tar.gz,target=/input/source.tar.gz,readonly',
		'type=bind,source=/out,target=/output',
		'type=bind,source=/logs-host,target=/logs',
		'type=volume,source=ats-linux-arm64-work,target=/work',
		'type=volume,source=ats-linux-cache-arm64,target=/cache'
	]);
});

test('source refresh replaces sources and build outputs while keeping declared dependencies and caches', async () => {
	const directory = await fixture();
	try {
		await shell(directory, 'refresh_sources archive.tar.gz work/source work/dependencies-ready');
		const source = path.join(directory, 'work', 'source');
		assert.deepEqual({
			sources: (await readdir(path.join(source, 'src'))).sort(),
			kept: await Promise.all(['node_modules/root-dependency/index.js', 'extensions/kept/node_modules/kept-dependency/index.js', '.build/sysroots/sysroot.txt'].map(file => readFile(path.join(source, file), 'utf8'))),
			dropped: await Promise.all(['extensions/removed', '.build/extensions', 'out-build'].map(file => exists(path.join(source, file)))),
			marker: await readFile(path.join(directory, 'work', 'dependencies-ready'), 'utf8'),
			keep: await exists(path.join(directory, 'work', 'source.keep'))
		}, { sources: ['new.ts'], kept: ['root', 'kept', 'sysroot'], dropped: [false, false, false], marker: 'fingerprint\n', keep: false });
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('an interrupted source refresh invalidates the dependency marker', async () => {
	const directory = await fixture();
	try {
		await write(path.join(directory, 'work', 'source.keep', 'node_modules', 'partial', 'index.js'), 'partial');
		await shell(directory, 'refresh_sources archive.tar.gz work/source work/dependencies-ready');
		assert.deepEqual([await exists(path.join(directory, 'work', 'dependencies-ready')), await exists(path.join(directory, 'work', 'source', 'node_modules', 'partial'))], [false, false]);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('dependency fingerprint follows lockfiles, install scripts and architecture but not other sources', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'ats-linux-fingerprint-'));
	try {
		for (const file of (await readdir(path.join(root, 'build', 'npm'))).filter(file => file.endsWith('.ts'))) { await write(path.join(directory, 'build', 'npm', file)); await copyFile(path.join(root, 'build', 'npm', file), path.join(directory, 'build', 'npm', file)); }
		await write(path.join(directory, 'build', 'azure-pipelines', 'linux', 'setup-env.sh'), 'setup');
		await write(path.join(directory, '.nvmrc'), '24.18.0\n');
		await write(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { a: '1.0.0' } }));
		await write(path.join(directory, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: {} }));
		const fingerprint = (arch = 'x64') => shell(directory, `dependency_fingerprint ${arch}`);
		const initial = await fingerprint();
		await write(path.join(directory, 'src', 'app.ts'), 'changed source');
		await write(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture', version: '2.0.0', dependencies: { a: '1.0.0' } }));
		const unrelated = await fingerprint();
		const architecture = await fingerprint('arm64');
		await write(path.join(directory, 'build', 'azure-pipelines', 'linux', 'setup-env.sh'), 'changed setup');
		const setup = await fingerprint();
		await write(path.join(directory, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { 'node_modules/a': { version: '1.0.1' } } }));
		const lockfile = await fingerprint();
		assert.deepEqual([/^[a-f0-9]{64}$/.test(initial), unrelated === initial, new Set([initial, architecture, setup, lockfile]).size], [true, true, 4]);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
