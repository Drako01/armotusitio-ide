/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkMcpBridge } from '../src/native-mcp-bridge.ts';
import { openToolChannel, callToolChannel } from '../src/native-tool-server.ts';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';

function fixture(canWrite = false) {
	let enabled = true, approve = false;
	const calls: unknown[] = [];
	const bridge = createWorkMcpBridge({
		client: {
			tools: async () => ['get_issue_context', 'transition_issue', 'delete_everything'].map(name => ({ name, inputSchema: { type: 'object' } })),
			call: async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: 'live card' }] }; }
		}, enabled: () => enabled, canWrite: () => canWrite, confirmWrite: async () => approve
	});
	return { bridge, calls, disable: () => { enabled = false; }, approve: () => { approve = true; } };
}

test('only explicit read tools are exposed by default; disabled MCP has no tools', async () => {
	const f = fixture();
	assert.deepEqual((await f.bridge.tools()).map(t => t.name), ['armotusitio__get_issue_context']);
	await f.bridge.call('armotusitio__get_issue_context', { issue_key: 'RED-001-261' });
	assert.deepEqual(f.calls, [{ name: 'get_issue_context', args: { issue_key: 'RED-001-261' } }]);
	await assert.rejects(f.bridge.call('armotusitio__transition_issue', {}), /DENIED/);
	await assert.rejects(f.bridge.call('armotusitio__delete_everything', {}), /DENIED/);
	f.disable();
	assert.deepEqual(await f.bridge.tools(), []);
	await assert.rejects(f.bridge.call('armotusitio__get_issue_context', {}), /DENIED/);
});

test('a writable chat must get confirmation before each mutation', async () => {
	const f = fixture(true);
	assert.equal((await f.bridge.tools()).length, 2);
	await assert.rejects(f.bridge.call('armotusitio__transition_issue', { issue_key: 'RED-001-261', board_column_id: 5 }), /WRITE_DENIED/);
	assert.equal(f.calls.length, 0);
	f.approve();
	await f.bridge.call('armotusitio__transition_issue', { issue_key: 'RED-001-261', board_column_id: 5 });
	assert.equal(f.calls.length, 1);
});

test('disabling MCP during confirmation prevents the mutation', async () => {
	let enabled = true;
	const bridge = createWorkMcpBridge({
		client: { tools: async () => [{ name: 'transition_issue', inputSchema: {} }], call: async () => assert.fail('must not call') },
		enabled: () => enabled, canWrite: () => true, confirmWrite: async () => { enabled = false; return true; }
	});
	await assert.rejects(bridge.call('armotusitio__transition_issue', {}), /TOOL_DENIED/);
	await assert.rejects(bridge.call('armotusitio__get_issue_context', []), /DENIED/);
});

test('revoked write permission and oversized mutation previews cannot reach Work Management', async () => {
	let canWrite = true, confirmations = 0;
	const bridge = createWorkMcpBridge({
		client: { tools: async () => [{ name: 'transition_issue', inputSchema: {} }], call: async () => assert.fail('must not call') },
		enabled: () => true, canWrite: () => canWrite,
		confirmWrite: async () => { confirmations++; canWrite = false; return true; }
	});
	await assert.rejects(bridge.call('armotusitio__transition_issue', { text: 'x'.repeat(12001) }), /INPUT_INVALID/);
	assert.equal(confirmations, 0);
	await assert.rejects(bridge.call('armotusitio__transition_issue', {}), /TOOL_DENIED/);
	assert.equal(confirmations, 1);
});

test('the authenticated runner channel reads a live card through the extension bridge', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-mcp-'));
	const f = fixture();
	const channel = await openToolChannel(directory, async (method, value) => {
		assert.equal(method, 'work-mcp');
		const input = value as { name: string; input: unknown };
		return f.bridge.call(input.name, input.input);
	});
	try {
		const result = await callToolChannel(channel.address, channel.token, 'work-mcp', { name: 'armotusitio__get_issue_context', input: { issue_key: 'RED-001-261' } });
		assert.deepEqual(result, { content: [{ type: 'text', text: 'live card' }] });
		await assert.rejects(callToolChannel(channel.address, 'wrong', 'work-mcp', {}), /UNTRUSTED/);
	} finally { await channel.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('provider stdio discovers and invokes the Work Management tool through ats-runner', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-mcp-stdio-'));
	const f = fixture();
	const channel = await openToolChannel(directory, async (_method, value) => {
		const input = value as { name: string; input: unknown };
		return f.bridge.call(input.name, input.input);
	});
	const configFile = path.join(directory, 'runner.json');
	await fs.writeFile(configFile, JSON.stringify({ schemaVersion: 1, root: directory, policy: { subprojects: [], delegate: false, extras: [] }, env: {}, logDirectory: directory, channel: { address: channel.address, token: channel.token }, mcpTools: await f.bridge.tools() }));
	const runnerEntry = process.env.ATS_TEST_RUNNER_ENTRY ?? path.resolve('src/ats-runner.ts');
	const child = spawn(process.execPath, [runnerEntry, configFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
	const lines = readline.createInterface({ input: child.stdout });
	let id = 0;
	const rpc = (method: string, params = {}): Promise<any> => new Promise((resolve, reject) => {
		const current = ++id;
		const timer = setTimeout(() => { lines.off('line', receive); reject(Error('stdio timeout')); }, 5000);
		const receive = (line: string): void => {
			const response = JSON.parse(line);
			if (response.id === current) { clearTimeout(timer); lines.off('line', receive); resolve(response.result); }
		};
		lines.on('line', receive);
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
	});
	try {
		const tools = await rpc('tools/list');
		assert.ok(tools.tools.some((t: { name: string }) => t.name === 'armotusitio__get_issue_context'));
		assert.ok(!JSON.stringify(tools).includes(channel.token));
		assert.deepEqual(await rpc('tools/call', { name: 'armotusitio__get_issue_context', arguments: { issue_key: 'RED-001-261' } }), { content: [{ type: 'text', text: 'live card' }] });
		f.disable();
		assert.equal((await rpc('tools/call', { name: 'armotusitio__get_issue_context', arguments: {} })).isError, true);
	} finally {
		lines.close();
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
			child.kill(); await exited;
		}
		await channel.close(); await fs.rm(directory, { recursive: true, force: true });
	}
});
