/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveNativeCommand, resolveNodeRuntime, windowsNpmProviderCandidates } from '../src/native-runtime.ts';

test('Windows npm Claude layout includes native executable and legacy JS fallback, never shell shims', () => {
	const prefix = path.resolve('npm-prefix-fixture');
	const claude = windowsNpmProviderCandidates(prefix, 'claude');
	assert.equal(claude.native, path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
	assert.equal(claude.script, path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
	const codex = windowsNpmProviderCandidates(prefix, 'codex');
	assert.equal(codex.script, path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
	assert.deepEqual(codex.native?.split(path.sep).slice(-5), process.arch === 'arm64'
		? ['codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe']
		: process.arch === 'x64' ? ['codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'] : undefined);
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

test('Windows resolver starts the native Codex binary itself so its wrapper cannot open a console window', { skip: process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch) }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-codex-native-resolver-'));
	const oldPath = process.env.PATH;
	try {
		const candidate = windowsNpmProviderCandidates(root, 'codex');
		await fs.mkdir(path.dirname(candidate.native!), { recursive: true });
		await fs.mkdir(path.dirname(candidate.script), { recursive: true });
		await fs.writeFile(candidate.native!, 'fixture-binary');
		await fs.writeFile(candidate.script, 'fixture-script');
		process.env.PATH = root;
		assert.deepEqual(await resolveNativeCommand('codex', ['--version']), { executable: candidate.native, args: ['--version'], embeddedNode: false });
		// Without the platform package (older layouts) the wrapper still works.
		await fs.rm(candidate.native!);
		assert.deepEqual(await resolveNativeCommand('codex', ['--version']), { executable: await fs.realpath(process.execPath), args: [candidate.script, '--version'], embeddedNode: false });
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
		assert.deepEqual(result, { executable: await fs.realpath(process.execPath), args: [candidate.script, '--version'], embeddedNode: false });
	} finally {
		if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('resolver finds the native Claude installer location even when it is missing from PATH', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-claude-home-resolver-'));
	const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	try {
		const executable = path.join(root, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
		await fs.mkdir(path.dirname(executable), { recursive: true });
		await fs.writeFile(executable, 'fixture-binary', { mode: 0o755 });
		process.env.PATH = path.join(root, 'empty'); process.env.HOME = root; process.env.USERPROFILE = root;
		assert.deepEqual(await resolveNativeCommand('claude', ['--version']), { executable, args: ['--version'], embeddedNode: false });
	} finally {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('an explicit environment controls executable resolution instead of the host PATH', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-resolver-env-'));
	try {
		const name = process.platform === 'win32' ? 'fixture-tool.exe' : 'fixture-tool';
		const executable = path.join(root, name);
		await fs.writeFile(executable, 'fixture', { mode: 0o755 });
		assert.deepEqual(await resolveNativeCommand('fixture-tool', ['check'], { PATH: root }), { executable: await fs.realpath(executable), args: ['check'], embeddedNode: false });
		await assert.rejects(resolveNativeCommand('fixture-tool', [], { PATH: '' }), /HARNESS_EXECUTABLE_UNAVAILABLE/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a native Node host is usable without PATH while Electron remains an explicit fallback', async () => {
	const node = await fs.realpath(process.execPath);
	const electron = path.resolve('fixture-electron.exe');
	assert.deepEqual(await resolveNodeRuntime({ PATH: '' }, { execPath: process.execPath, electron: false }), { executable: node, embeddedNode: false });
	assert.deepEqual(await resolveNativeCommand('node', ['--version'], { PATH: '' }, { execPath: electron, electron: true }), { executable: electron, args: ['--version'], embeddedNode: true });
});

test('Windows Node resolution accepts case-insensitive environment names and quoted PATH entries', { skip: process.platform !== 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-node-env-'));
	try {
		const executable = path.join(root, 'node.exe');
		await fs.writeFile(executable, 'fixture');
		const env = { path: '"' + root + '"' };
		assert.deepEqual(await resolveNativeCommand('node.exe', ['check'], env, { execPath: 'C:\\fixture\\Code.exe', electron: true }), { executable: await fs.realpath(executable), args: ['check'], embeddedNode: false });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows pnpm scripts use the same native Node selected through the explicit nvm environment', { skip: process.platform !== 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-pnpm-node-env-'));
	try {
		const prefix = path.join(root, 'prefix');
		const nodeFolder = path.join(root, 'nvm version');
		const link = path.join(root, 'nvm link');
		const script = path.join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
		await fs.mkdir(path.dirname(script), { recursive: true });
		await fs.mkdir(nodeFolder);
		await fs.writeFile(script, 'fixture');
		await fs.writeFile(path.join(nodeFolder, 'node.exe'), 'fixture');
		await fs.symlink(nodeFolder, link, 'junction');
		const env = { Path: prefix, nvm_symlink: link };
		const host = { execPath: 'C:\\fixture\\Code.exe', electron: true };
		assert.deepEqual(await resolveNativeCommand('pnpm', ['run', 'preflight'], env, host), {
			executable: await fs.realpath(path.join(nodeFolder, 'node.exe')), args: [script, 'run', 'preflight'], embeddedNode: false
		});
		await fs.rm(path.join(nodeFolder, 'node.exe'));
		assert.deepEqual(await resolveNativeCommand('pnpm', ['--version'], env, host), { executable: host.execPath, args: [script, '--version'], embeddedNode: true });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an explicit home finds Claude without borrowing the host account installation', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-claude-explicit-env-'));
	try {
		const executable = path.join(root, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
		await fs.mkdir(path.dirname(executable), { recursive: true });
		await fs.writeFile(executable, 'fixture', { mode: 0o755 });
		assert.deepEqual(await resolveNativeCommand('claude', ['--version'], { PATH: '', HOME: root, USERPROFILE: root }), { executable: await fs.realpath(executable), args: ['--version'], embeddedNode: false });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows recovers registered Node locations when an Electron GUI inherited neither PATH nor nvm', { skip: process.platform !== 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-node-registered-'));
	try {
		const executable = path.join(root, 'node.exe');
		await fs.writeFile(executable, 'fixture');
		const host = { execPath: 'C:\\fixture\\Code.exe', electron: true, registeredEnvironment: async () => ({ Path: '%NVM_SYMLINK%', NVM_SYMLINK: '%NVM_HOME%', NVM_HOME: root }) };
		assert.deepEqual(await resolveNodeRuntime({ PATH: '' }, host), { executable: await fs.realpath(executable), embeddedNode: false });
		assert.deepEqual(await resolveNodeRuntime({ PATH: '' }, { ...host, registeredEnvironment: async () => ({ nvm_symlink: root }) }), { executable: await fs.realpath(executable), embeddedNode: false });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows keeps explicit Node precedence and survives unavailable registry access', { skip: process.platform !== 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-node-registered-order-'));
	try {
		const executable = path.join(root, 'node.exe');
		await fs.writeFile(executable, 'fixture');
		let reads = 0;
		const host = { execPath: 'C:\\fixture\\Code.exe', electron: true, registeredEnvironment: async (): Promise<NodeJS.ProcessEnv> => { reads++; throw Error('Registry unavailable'); } };
		assert.deepEqual(await resolveNodeRuntime({ PATH: root }, host), { executable: await fs.realpath(executable), embeddedNode: false });
		assert.equal(reads, 0);
		assert.deepEqual(await resolveNodeRuntime({ PATH: '' }, host), { executable: host.execPath, embeddedNode: true });
		assert.equal(reads, 1);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows pnpm prefers the native binary behind its npm shim and supports the pnpm 12 script fallback', { skip: process.platform !== 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-pnpm-native-env-'));
	try {
		const directory = path.join(root, 'node_modules', 'pnpm');
		const native = path.join(directory, 'pnpm.exe');
		const script = path.join(directory, 'bin', 'pnpm.mjs');
		await fs.mkdir(path.dirname(script), { recursive: true });
		await fs.writeFile(native, 'fixture-binary');
		await fs.writeFile(script, 'fixture-script');
		const env = { PATH: root };
		const host = { execPath: 'C:\\fixture\\Code.exe', electron: true };
		assert.deepEqual(await resolveNativeCommand('pnpm', ['--version'], env, host), { executable: await fs.realpath(native), args: ['--version'], embeddedNode: false });
		await fs.rm(native);
		assert.deepEqual(await resolveNativeCommand('pnpm', ['--version'], env, host), { executable: host.execPath, args: [script, '--version'], embeddedNode: true });
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
