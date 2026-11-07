/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** The real ats-runner stdio MCP process, driven the way a provider drives it: one JSON-RPC line per request. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { RunnerConfig } from '../src/ats-runner.ts';

export type RpcResponse = { serverInfo?: { name: string }; tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> };
export interface RunnerProcess {
	/** `serverInfo.name` from the MCP handshake. */
	serverName?: string;
	rpc(method: string, params?: object): Promise<RpcResponse>;
	/** `tools/call` reduced to what the agent reads: the error flag and the first text block. */
	call(name: string, args: object): Promise<{ isError: boolean; text: string }>;
	close(): Promise<void>;
}

/** Writes `config` next to the run and starts the runner on it; `env` replaces the process environment (for example a test HOME). */
export async function startRunner(config: RunnerConfig, configFile: string, options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<RunnerProcess> {
	await fs.writeFile(configFile, JSON.stringify(config));
	const runner = spawn(process.execPath, [path.resolve(import.meta.dirname, '../src/ats-runner.ts'), configFile],
		{ cwd: options.cwd, env: options.env ?? process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
	const pending = new Map<number, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>();
	const lines = readline.createInterface({ input: runner.stdout! });
	lines.on('line', line => {
		const response = JSON.parse(line) as { id: number; result?: RpcResponse; error?: unknown };
		const call = pending.get(response.id);
		if (call) { pending.delete(response.id); response.error ? call.reject(Error(JSON.stringify(response.error))) : call.resolve(response.result ?? {}); }
	});
	let sequence = 0;
	const rpc = (method: string, params: object = {}) => new Promise<RpcResponse>((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		runner.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	});
	const initialized = await rpc('initialize', { protocolVersion: '2025-06-18' });
	return {
		serverName: initialized.serverInfo?.name,
		rpc,
		async call(name, args) {
			const result = await rpc('tools/call', { name, arguments: args });
			return { isError: !!result.isError, text: result.content?.[0]?.text ?? '' };
		},
		async close() {
			runner.stdin!.end();
			await new Promise<void>(resolve => { if (runner.exitCode !== null) { resolve(); } else { runner.once('close', () => resolve()); runner.kill(); } });
			lines.close();
		}
	};
}
