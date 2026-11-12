/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { linuxRunArgs } from './ats-build-linux.mts';
import { extensionDependencyInstallArgs } from './ats-autoupdate.mts';
import { createNodeCompileCacheGenerationEnvironment, validateNodeCompileCache } from '../build/lib/nodeCompileCache.ts';

const root = path.resolve(import.meta.dirname, '..');

test('cache validation accepts both version tags and retains architecture and readiness checks', async t => {
	const directory = await mkdtemp(path.join(tmpdir(), 'ats-cache-tag-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const suffix of ['', '-1000']) {
		const cache = path.join(directory, suffix || 'legacy');
		for (const kind of ['main', 'extension-host', 'shared-process', 'pty-host', 'agent-host']) {
			const location = path.join(cache, kind, `v24.22.0-x64-60e4fe36${suffix}`);
			await mkdir(location, { recursive: true });
			await writeFile(path.join(location, 'deadbeef'), 'fixture');
			await writeFile(path.join(cache, kind, '.ready'), '');
		}
		await assert.rejects(validateNodeCompileCache(cache, 'arm64'), /0 arm64 version-tag/);
		assert.equal(await validateNodeCompileCache(cache, 'x64'), 5);
		await assert.rejects(validateNodeCompileCache(cache, 'x64'), /readiness marker/);
	}
});

test('packaged Electron cache retains DISPLAY without inheriting Node-only options', () => {
	const parent = { DISPLAY: ':99', NODE_OPTIONS: '--max-old-space-size=8192', ELECTRON_RUN_AS_NODE: '1' };
	const env = createNodeCompileCacheGenerationEnvironment('/tmp/cache', parent);
	assert.deepEqual({ display: env.DISPLAY, options: env.NODE_OPTIONS, nodeMode: env.ELECTRON_RUN_AS_NODE, generate: env.VSCODE_GENERATE_NODE_COMPILE_CACHE, parentOptions: parent.NODE_OPTIONS }, {
		display: ':99', options: undefined, nodeMode: undefined, generate: '1', parentOptions: '--max-old-space-size=8192'
	});
});

test('Linux builds isolate work volumes by architecture and immutable commit', () => {
	const commit = 'a'.repeat(40);
	const args = linuxRunArgs('arm64', commit, { source: '/in/source.tar.gz', output: '/out', logs: '/logs-host' }, 'image');
	assert.deepEqual(args.filter(arg => arg.startsWith('type=')), [
		'type=bind,source=/in/source.tar.gz,target=/input/source.tar.gz,readonly',
		'type=bind,source=/out,target=/output',
		'type=bind,source=/logs-host,target=/logs',
		'type=volume,source=ats-linux-arm64-aaaaaaaaaaaaaaaa,target=/work',
		'type=volume,source=ats-linux-cache-arm64,target=/cache'
	]);
	const different = linuxRunArgs('arm64', 'b'.repeat(40), { source: '/in/source.tar.gz', output: '/out', logs: '/logs-host' }, 'image');
	assert.notEqual(args.find(x => x.includes('target=/work')), different.find(x => x.includes('target=/work')));
});

test('Linux builds forward a GitHub token to the container by name only, and only when asked', () => {
	const paths = { source: '/in/source.tar.gz', output: '/out', logs: '/logs-host' };
	assert.ok(!linuxRunArgs('arm64', 'a'.repeat(40), paths, 'image').includes('GITHUB_TOKEN'));
	const args = linuxRunArgs('arm64', 'a'.repeat(40), paths, 'image', true);
	assert.deepEqual(args.slice(-3), ['-e', 'GITHUB_TOKEN', 'image']);
	assert.ok(!args.some(arg => arg.startsWith('GITHUB_TOKEN=')));
});

test('Linux bootstrap extracts immutable source and installs dependencies on first use', async () => {
	const script = await readFile(path.join(root, 'build/armotusitio/linux-build.sh'), 'utf8');
	assert.match(script, /tar -xzf \/input\/source\.tar\.gz/);
	assert.match(script, /pnpm install --frozen-lockfile --ignore-scripts/);
	assert.match(script, /pnpm install --frozen-lockfile\r?\n\s+touch/);
	// preinstall.ts needs the node-gyp that pnpm passes in npm_config_node_gyp, so pnpm must run it.
	assert.match(script, /pnpm run preinstall\r?\n\s+pnpm install --frozen-lockfile\r?\n/);
	assert.doesNotMatch(script, /node build\/npm\/preinstall\.ts/);
	assert.match(script, /touch \/work\/dependencies-ready/);
	assert.doesNotMatch(script, /refresh_sources|dependency_fingerprint|source\.keep/);
	assert.match(script, /Refusing Linux build as root/);
});

test('Linux release installs the pinned PDF parser on every attempt before bundling', async () => {
	const script = await readFile(path.join(root, 'build/armotusitio/linux-build.sh'), 'utf8');
	const install = ['npm', ...extensionDependencyInstallArgs].join(' ');
	const dependencyGate = script.indexOf('if [[ ! -f /work/dependencies-ready ]]');
	const gateEnd = script.indexOf('\nfi\n', dependencyGate);
	const installAt = script.indexOf(install);
	const bundleAt = script.indexOf('node extensions/armotusitio-ide/esbuild.mts');
	assert.ok(dependencyGate >= 0 && gateEnd > dependencyGate, 'Linux bootstrap gate must exist');
	assert.ok(installAt > gateEnd, 'PDF install must execute even when the upstream dependency marker exists');
	assert.ok(bundleAt > installAt, 'PDF install must precede the extension bundle');
	const pkg = JSON.parse(await readFile(path.join(root, 'extensions/armotusitio-ide/package.json'), 'utf8'));
	const lock = JSON.parse(await readFile(path.join(root, 'extensions/armotusitio-ide/package-lock.json'), 'utf8'));
	assert.equal(lock.packages[''].dependencies['pdfjs-dist'], pkg.dependencies['pdfjs-dist']);
	assert.equal(lock.packages['node_modules/pdfjs-dist'].version, pkg.dependencies['pdfjs-dist']);
});

test('Windows packaging installs the same pinned PDF parser before bundling', async () => {
	const script = await readFile(path.join(root, 'scripts/ats-package-windows.mts'), 'utf8');
	const installAt = script.indexOf('await execute([npmCLI, ...extensionDependencyInstallArgs]);');
	const bundleAt = script.indexOf('[...gulp, \'vscode-win32-x64\']');
	assert.ok(installAt >= 0, 'Windows packaging must install the extension dependencies');
	assert.ok(bundleAt > installAt, 'PDF install must precede the Windows bundle');
});

test('Linux build scopes the sandbox override to transient Node compile-cache generation', async () => {
	const script = await readFile(path.join(root, 'build/armotusitio/linux-build.sh'), 'utf8');
	const cache = await readFile(path.join(root, 'build/lib/nodeCompileCache.ts'), 'utf8');
	const docker = await readFile(path.join(root, 'build/armotusitio/Dockerfile.linux'), 'utf8');
	assert.match(script, /unshare -Ur true/);
	assert.match(script, /ATS_LINUX_CACHE_NO_SANDBOX=1/);
	assert.match(cache, /process\.env\.ATS_LINUX_CACHE_NO_SANDBOX === '1'/);
	assert.match(cache, /buildOnlyNoSandbox \? \['--no-sandbox'\] : \[\]/);
	assert.doesNotMatch(docker, /ats-prepare-chrome-sandbox|sudoers|--privileged/);
});
