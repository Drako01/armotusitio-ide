/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { withHarnessProvider } from '../src/native-provider-environment.ts';
import { windowsNpmProviderCandidates } from '../src/native-runtime.ts';

test('the selected Codex npm binary is discoverable by project children and overrides only this run', { skip: process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch) }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-selected-codex-'));
	try {
		const binary = windowsNpmProviderCandidates(root, 'codex').native!;
		await fs.mkdir(path.dirname(binary), { recursive: true });
		await fs.writeFile(binary, 'not executable: discovery must not invoke a provider');
		const source = { Path: root, HARNESS_HOST: 'claude', HARNESS_AGENT_COMMAND: 'custom-host --run' };
		const env = await withHarnessProvider(source, 'codex');
		assert.deepEqual({ host: env.HARNESS_HOST, first: env.PATH?.split(path.delimiter)[0], alias: env.Path, custom: env.HARNESS_AGENT_COMMAND },
			{ host: 'codex', first: path.dirname(binary), alias: undefined, custom: source.HARNESS_AGENT_COMMAND });
		assert.equal(source.HARNESS_HOST, 'claude');
		assert.equal(source.Path, root);
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('the selected Claude native installation is visible to a project even without a GUI PATH entry', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-selected-claude-'));
	try {
		const bin = path.join(root, '.local', 'bin');
		await fs.mkdir(bin, { recursive: true });
		await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'discovery only', { mode: 0o755 });
		const source = { PATH: '', USERPROFILE: root, HOME: root, HARNESS_HOST: 'codex' };
		const env = await withHarnessProvider(source, 'claude');
		assert.equal(env.HARNESS_HOST, 'claude');
		assert.equal(env.PATH?.split(path.delimiter)[0], bin);
		assert.equal(source.PATH, '');
		assert.equal(source.HARNESS_HOST, 'codex');
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('a version-named Claude target keeps its executable alias visible to project children', { skip: process.platform === 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-selected-claude-link-'));
	try {
		const bin = path.join(root, '.local', 'bin');
		const version = path.join(root, 'versions', '1.2.3');
		await fs.mkdir(bin, { recursive: true });
		await fs.mkdir(path.dirname(version));
		await fs.writeFile(version, 'discovery only', { mode: 0o755 });
		await fs.symlink(version, path.join(bin, 'claude'));
		const env = await withHarnessProvider({ PATH: '', HOME: root }, 'claude');
		assert.ok(env.PATH?.split(path.delimiter).includes(bin));
		assert.equal(env.HARNESS_HOST, 'claude');
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
