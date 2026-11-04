/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Claude CLI simulation exercises the shipped MCP configuration without provider authentication or inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { executeReviewedAgent } from '../src/native-agent-execution.ts';
import { reviewAgentDraft, type AgentDraft } from '../src/native-providers.ts';
import { createToolchainFixture } from './native-toolchain-fixture.mts';

/** Serialized into a synthetic npm Claude entry; every operation stays inside the temporary fixture. */
async function simulatedClaude(): Promise<void> {
	const assert = require('node:assert/strict');
	const fs = require('node:fs');
	const { spawn } = require('node:child_process');
	const readline = require('node:readline');
	const argv = process.argv.slice(2);
	const option = (name: string): string | undefined => argv[argv.indexOf(name) + 1];
	assert.ok(argv.includes('--strict-mcp-config'));
	assert.equal(option('--permission-mode'), 'dontAsk');
	assert.equal(option('--output-format'), 'stream-json');
	assert.ok(argv.includes('--verbose'));
	assert.ok(option('--allowedTools')?.split(',').includes('mcp__ats-runner'));
	assert.ok(option('--disallowedTools')?.split(',').includes('Bash'));
	assert.ok(option('--disallowedTools')?.split(',').includes('WebFetch'));
	assert.ok(!argv.some((argument: string) => argument.includes('skip-permissions')));
	await new Promise<void>(resolve => { process.stdin.resume(); process.stdin.once('end', resolve); });
	const server = JSON.parse(fs.readFileSync(option('--mcp-config'), 'utf8')).mcpServers['ats-runner'];
	const runner = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
	let stderr = '';
	runner.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-2000); });
	const pending = new Map<number, { resolve(value: object): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	const fail = (error: Error): void => {
		for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
		pending.clear();
	};
	runner.on('error', fail);
	runner.on('exit', (code: number) => fail(Error('Runner exited ' + code + ': ' + stderr)));
	const lines = readline.createInterface({ input: runner.stdout });
	lines.on('line', (line: string) => {
		const response = JSON.parse(line);
		const call = pending.get(response.id);
		if (!call) { return; }
		pending.delete(response.id); clearTimeout(call.timer);
		if (response.error) { call.reject(Error(JSON.stringify(response.error))); } else { call.resolve(response.result); }
	});
	let sequence = 0;
	const rpc = (method: string, params: object): Promise<object> => new Promise((resolve, reject) => {
		const id = ++sequence;
		const timer = setTimeout(() => { pending.delete(id); reject(Error('MCP timeout: ' + method + ': ' + stderr)); }, 20_000);
		pending.set(id, { resolve, reject, timer });
		runner.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	});
	try {
		await rpc('initialize', { protocolVersion: '2025-06-18' });
		const output: object[] = [];
		for (const input of [{ command: 'node', args: ['--version'] }, { command: 'pnpm', args: ['run', 'preflight'] }]) {
			output.push(await rpc('tools/call', { name: 'run', arguments: { ...input, cwd: '.', timeoutSec: 15 } }));
		}
		process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(output) }) + '\n');
	} finally {
		fail(Error('Fixture finished'));
		runner.stdin.end();
		if (runner.exitCode === null) { await new Promise<void>(resolve => { runner.once('close', resolve); runner.kill(); }); }
		lines.close();
	}
}

test('Claude launch keeps its permission guards and runs Node/pnpm through Electron MCP and a Python delegate without tokens', { skip: process.platform !== 'win32', timeout: 90_000 }, async t => {
	const fixture = await createToolchainFixture({ nodeHint: false, delegated: true });
	if (!fixture) { t.skip('Needs local Electron, pnpm, Python and Node'); return; }
	const savedPath = process.env.PATH;
	try {
		const bin = path.join(fixture.base, 'fake-claude');
		const entry = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
		await fs.mkdir(path.dirname(entry), { recursive: true });
		await fs.writeFile(entry, '(' + simulatedClaude.toString() + ')().catch(error => { console.error(error.stack); process.exitCode = 1; });\n');
		process.env.PATH = bin + path.delimiter + (savedPath ?? '');
		const mcpConfigFile = path.join(fixture.base, 'claude-mcp.json');
		const server = { command: fixture.electron, args: [fixture.runnerFile, fixture.configFile], env: { ELECTRON_RUN_AS_NODE: '1' }, mcpConfigFile };
		await fs.writeFile(mcpConfigFile, JSON.stringify({ mcpServers: { 'ats-runner': { type: 'stdio', command: server.command, args: server.args, env: server.env } } }));
		const draft: AgentDraft = { schemaVersion: 1, provider: 'claude', role: 'implementer', readOnly: false, projectRoot: fixture.root, instruction: 'Verify the temporary runtime fixture only.' };
		const execution = await executeReviewedAgent(reviewAgentDraft(draft), draft, 60_000, undefined, undefined, server);
		const result = await execution.outcome;
		assert.equal(result.status, 'passed', result.output);
		const replies = JSON.parse(result.output) as Array<{ isError: boolean; content: Array<{ text: string }> }>;
		assert.deepEqual(replies.map(reply => reply.isError), [false, false], result.output);
		assert.ok(replies.every(reply => reply.content.some(content => /^exit 0/.test(content.text))), result.output);
		assert.match(replies[1].content.map(content => content.text).join('\n'), /TOOLCHAIN_PROBE/);
	} finally {
		if (savedPath === undefined) { delete process.env.PATH; } else { process.env.PATH = savedPath; }
		await fixture.cleanup();
	}
});
