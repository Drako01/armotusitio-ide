/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { linuxRunArgs } from './ats-build-linux.mts';
import { createNodeCompileCacheGenerationEnvironment } from '../build/lib/nodeCompileCache.ts';

const root = path.resolve(import.meta.dirname, '..');

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

test('Linux bootstrap extracts immutable source and installs dependencies on first use', async () => {
	const script = await readFile(path.join(root, 'build/armotusitio/linux-build.sh'), 'utf8');
	assert.match(script, /tar -xzf \/input\/source\.tar\.gz/);
	assert.match(script, /npm ci --ignore-scripts --no-audit --no-fund/);
	assert.match(script, /npm ci --no-audit --no-fund/);
	assert.match(script, /touch \/work\/dependencies-ready/);
	assert.doesNotMatch(script, /refresh_sources|dependency_fingerprint|source\.keep/);
	assert.match(script, /Refusing Linux build as root/);
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
