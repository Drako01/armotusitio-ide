/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Real Electron -> stdio MCP -> pnpm -> node transport. No provider, credentials, project or network is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import type { RunnerConfig } from '../src/ats-runner.ts';

const repository = path.resolve(import.meta.dirname, '../../..');
const exists = (file: string): Promise<boolean> => fs.stat(file).then(stat => stat.isFile(), () => false);

async function firstFile(candidates: Array<string | undefined>): Promise<string | undefined> {
	for (const file of candidates) { if (file && await exists(file)) { return file; } }
	return undefined;
}

interface RpcResponse { serverInfo?: { name: string }; isError?: boolean; content?: Array<{ text: string }> }

async function runThroughMcp(executable: string, runnerFile: string, configFile: string, root: string): Promise<RpcResponse> {
	const runner = spawn(executable, [runnerFile, configFile], {
		cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
	});
	let stderr = '';
	runner.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
	const pending = new Map<number, { resolve(value: RpcResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	const fail = (error: Error): void => {
		for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
		pending.clear();
	};
	runner.on('error', fail);
	runner.on('exit', code => fail(Error('Runner exited ' + code + ': ' + stderr)));
	const lines = readline.createInterface({ input: runner.stdout });
	lines.on('line', line => {
		const response = JSON.parse(line) as { id: number; result?: RpcResponse; error?: object };
		const call = pending.get(response.id);
		if (!call) { return; }
		pending.delete(response.id); clearTimeout(call.timer);
		if (response.error) { call.reject(Error(JSON.stringify(response.error))); } else { call.resolve(response.result ?? {}); }
	});
	let sequence = 0;
	const rpc = (method: string, params: object = {}): Promise<RpcResponse> => new Promise((resolve, reject) => {
		const id = ++sequence;
		const timer = setTimeout(() => { pending.delete(id); reject(Error('MCP timeout: ' + method + ': ' + stderr)); }, 20_000);
		pending.set(id, { resolve, reject, timer });
		runner.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	});
	try {
		const initialized = await rpc('initialize', { protocolVersion: '2025-06-18' });
		assert.equal(initialized.serverInfo?.name, 'ats-runner');
		return await rpc('tools/call', { name: 'run', arguments: { command: 'pnpm', args: ['run', 'preflight'], timeoutSec: 10 } });
	} finally {
		fail(Error('MCP test finished'));
		runner.stdin.end();
		if (runner.exitCode === null) {
			await new Promise<void>(resolve => { runner.once('close', () => resolve()); runner.kill(); });
		}
		lines.close();
	}
}

test('Electron MCP runner makes Node available to pnpm scripts with a stale GUI PATH, directly and through a project delegate', { skip: process.platform !== 'win32', timeout: 90_000 }, async t => {
	const electron = await firstFile([
		process.env.ATS_TEST_ELECTRON_PATH,
		path.join(repository, '.build', 'electron', 'ArmotuSitio IDE.exe'),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'ArmotuSitio IDE', 'ArmotuSitio IDE.exe')
	]);
	const pnpm = await firstFile([
		process.env.ATS_TEST_PNPM_PATH,
		process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'pnpm.exe'),
		process.env.PNPM_HOME && path.join(process.env.PNPM_HOME, 'pnpm.exe')
	]);
	if (!electron || !pnpm || process.versions.electron) { t.skip('Needs a local Electron binary, standalone pnpm and a Node test host'); return; }
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-electron-toolchain-')));
	try {
		const root = path.join(base, 'project');
		const bin = path.join(base, 'tools');
		const nodeLink = path.join(base, 'nvm-node');
		await fs.mkdir(root); await fs.mkdir(bin);
		await fs.copyFile(pnpm, path.join(bin, 'pnpm.exe'));
		const realNode = await fs.realpath(process.execPath);
		await fs.symlink(path.dirname(realNode), nodeLink, 'junction');
		await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'runner-transport-fixture', private: true, scripts: { preflight: 'node probe.cjs' } }));
		await fs.writeFile(path.join(root, 'probe.cjs'), 'console.log("TOOLCHAIN_PROBE " + JSON.stringify({ version: process.version, executable: process.execPath }));\n');
		await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ type: 'commonjs' }));
		const runnerFile = path.join(base, 'ats-runner.js');
		await build({ entryPoints: [path.join(repository, 'extensions', 'armotusitio-ide', 'src', 'ats-runner.ts')], outfile: runnerFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
		const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
		const env: NodeJS.ProcessEnv = {
			PATH: [bin, path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD',
			SystemRoot: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
			USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
			TEMP: process.env.TEMP, TMP: process.env.TMP, NVM_SYMLINK: nodeLink, ATS_TOOL_BIN: bin,
			npm_config_manage_package_manager_versions: 'false', pnpm_config_manage_package_manager_versions: 'false',
			COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_update_notifier: 'false', CI: '1'
		};
		const delegate = path.join(root, 'ide-entry.cjs');
		await fs.writeFile(delegate, [
			'const { spawnSync } = require("node:child_process"); const path = require("node:path");',
			'const split = process.argv.indexOf("--"); const [command, ...args] = process.argv.slice(split + 1);',
			'const result = spawnSync(path.join(process.env.ATS_TOOL_BIN, command + ".exe"), args, { env: process.env, cwd: process.cwd(), windowsHide: true, stdio: "inherit" });',
			'if (result.error) { console.error(result.error.code); } process.exit(result.status ?? 1);'
		].join('\n'));
		for (const delegated of [false, true]) {
			const config: RunnerConfig = {
				schemaVersion: 1, root, env, logDirectory: path.join(base, delegated ? 'delegated-logs' : 'direct-logs'),
				policy: { subprojects: [{ path: '.', ecosystem: 'node', packageManager: 'pnpm', scripts: ['preflight'] }], delegate: delegated, extras: [] },
				...(delegated ? { delegateEntry: delegate } : {})
			};
			const configFile = path.join(base, delegated ? 'delegated.json' : 'direct.json');
			await fs.writeFile(configFile, JSON.stringify(config));
			const response = await runThroughMcp(electron, runnerFile, configFile, root);
			const output = response.content?.map(content => content.text).join('\n') ?? '';
			assert.equal(response.isError, false, (delegated ? 'Delegated' : 'Direct') + ': ' + output);
			assert.match(output, /^exit 0/);
			const probe = JSON.parse(/TOOLCHAIN_PROBE (\{[^\r\n]+\})/.exec(output)?.[1] ?? '{}') as { version?: string; executable?: string };
			assert.equal(probe.version, process.version);
			assert.equal(probe.executable?.toLowerCase(), realNode.toLowerCase());
		}
	} finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
