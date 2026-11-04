/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Real Electron -> stdio MCP -> Node bootstrap -> Python delegate -> pnpm -> Node transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createToolchainFixture } from './native-toolchain-fixture.mts';

interface RpcResponse { serverInfo?: { name: string }; isError?: boolean; content?: Array<{ text: string }> }

async function runThroughMcp(executable: string, runnerFile: string, configFile: string, root: string): Promise<RpcResponse[]> {
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
		return await Promise.all([
			rpc('tools/call', { name: 'run', arguments: { command: 'node', args: ['--version'], timeoutSec: 10 } }),
			rpc('tools/call', { name: 'run', arguments: { command: 'pnpm', args: ['run', 'preflight'], timeoutSec: 15 } })
		]);
	} finally {
		fail(Error('MCP test finished'));
		runner.stdin.end();
		if (runner.exitCode === null) {
			await new Promise<void>(resolve => { runner.once('close', () => resolve()); runner.kill(); });
		}
		lines.close();
	}
}

for (const nodeHint of [true, false]) {
	for (const delegated of [false, true]) {
		test('Electron MCP runner resolves Node ' + (nodeHint ? 'with an nvm hint' : 'without Node or nvm in its GUI environment') + (delegated ? ' through a real isolated Python delegate' : ' directly'), { skip: process.platform !== 'win32', timeout: 90_000 }, async t => {
			const fixture = await createToolchainFixture({ nodeHint, delegated });
			if (!fixture) { t.skip('Needs local Electron, standalone pnpm, Python and a Node test host'); return; }
			try {
				const responses = await runThroughMcp(fixture.electron, fixture.runnerFile, fixture.configFile, fixture.root);
				for (const [index, response] of responses.entries()) {
					const output = response.content?.map(content => content.text).join('\n') ?? '';
					assert.equal(response.isError, false, (index === 0 ? 'Node version' : 'Preflight') + ': ' + output);
					assert.match(output, /^exit 0/);
					if (index === 0) { assert.match(output, /v\d+\.\d+\.\d+/); }
					else {
						const probe = JSON.parse(/TOOLCHAIN_PROBE (\{[^\r\n]+\})/.exec(output)?.[1] ?? '{}') as { version?: string; executable?: string };
						assert.match(probe.version ?? '', /^v\d+\.\d+\.\d+$/);
						assert.match(probe.executable ?? '', /node\.exe$/i);
					}
				}
			} finally { await fixture.cleanup(); }
		});
	}
}
