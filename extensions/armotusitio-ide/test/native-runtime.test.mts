/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveNativeCommand, windowsNpmProviderCandidates } from '../src/native-runtime.ts';

test('Windows npm Claude layout includes native executable and legacy JS fallback, never shell shims', () => {
	const prefix = path.resolve('npm-prefix-fixture');
	const claude = windowsNpmProviderCandidates(prefix, 'claude');
	assert.equal(claude.native, path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
	assert.equal(claude.script, path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
	assert.equal(windowsNpmProviderCandidates(prefix, 'codex').script, path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
	assert.ok(!Object.values(claude).some(candidate => /\.(?:cmd|ps1)$/i.test(candidate)));
});

test('Windows resolver chooses npm native Claude executable before deprecated JS entry', { skip: process.platform !== 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-claude-native-resolver-'));
	const oldPath = process.env.PATH;
	try {
		const candidate = windowsNpmProviderCandidates(root, 'claude');
		await fs.mkdir(path.dirname(candidate.native!), { recursive: true });
		await fs.writeFile(candidate.native!, 'fixture-binary');
		await fs.writeFile(candidate.script, 'fixture-script');
		process.env.PATH = root;
		const result = await resolveNativeCommand('claude', ['--version']);
		assert.deepEqual(result, { executable: candidate.native, args: ['--version'], embeddedNode: false });
	} finally {
		if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('Windows resolver keeps older npm Claude JavaScript entry working without a shell', { skip: process.platform !== 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-claude-legacy-resolver-'));
	const oldPath = process.env.PATH;
	try {
		const candidate = windowsNpmProviderCandidates(root, 'claude');
		await fs.mkdir(path.dirname(candidate.script), { recursive: true });
		await fs.writeFile(candidate.script, 'fixture-script');
		process.env.PATH = root;
		const result = await resolveNativeCommand('claude', ['--version']);
		assert.deepEqual(result, { executable: process.execPath, args: [candidate.script, '--version'], embeddedNode: true });
	} finally {
		if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
		await fs.rm(root, { recursive: true, force: true });
	}
});
