/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { McpClient, registerMcp, endpoint } = require('../src/mcp.ts');

function transport(tools = ['list_projects']) {
	const calls = [];
	return {
		calls, async fetch(url, options) {
			const rpc = JSON.parse(options.body); calls.push({ url, options, rpc });
			if (rpc.method === 'notifications/initialized') { return new Response(null, { status: 202 }); }
			const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'armotusitio-work' } }
				: rpc.method === 'tools/list' ? { tools: tools.map(name => ({ name })) } : { structuredContent: { projects: [] }, isError: false };
			return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
		}
	};
}

test('MCP performs the real handshake, pins the endpoint, keeps the key out of RPC and checks tool availability', async () => {
	const server = transport();
	const client = new McpClient(async () => 'unit-only', server.fetch);
	await client.call('list_projects', {});
	assert.deepEqual(server.calls.map(call => call.rpc.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
	for (const call of server.calls) {
		assert.equal(call.url, endpoint); assert.equal(call.options.redirect, 'error');
		assert.equal(call.options.headers['X-ATS-Agent-Key'], 'unit-only');
		assert.doesNotMatch(call.options.body, /unit-only/);
	}
	await assert.rejects(client.call('create_issue', {}), /MCP_PERMISSION/);
	assert.equal(server.calls.filter(call => call.rpc.method === 'tools/call').length, 1);
});

test('MCP rejects missing authentication, bad RPC identity, HTTP failures and oversized responses', async () => {
	let calls = 0;
	await assert.rejects(new McpClient(async () => undefined, async () => { calls++; }).tools(), /MCP_AUTH/);
	await assert.rejects(new McpClient(async () => 'bad\nheader', async () => { calls++; }).tools(), /MCP_AUTH/);
	assert.equal(calls, 0);
	for (const [fetcher, code] of [
		[async () => new Response('', { status: 401 }), 'MCP_AUTH'],
		[async () => new Response('', { status: 403 }), 'MCP_AUTH'],
		[async () => new Response('', { status: 500 }), 'MCP_HTTP'],
		[async () => Response.json({ jsonrpc: '2.0', id: 99, result: {} }), 'MCP_RESPONSE'],
		[async () => new Response('x'.repeat(1048577)), 'MCP_SIZE']
	]) { await assert.rejects(new McpClient(async () => 'unit-only', fetcher).tools(), new RegExp(code)); }
});

test('MCP cancellation aborts requests and removes its listener', async () => {
	let cancelled, disposed = false, receivedSignal;
	const token = { isCancellationRequested: false, onCancellationRequested(fn) { cancelled = fn; return { dispose() { disposed = true; } }; } };
	const client = new McpClient(async () => 'unit-only', async (_, options) => {
		receivedSignal = options.signal;
		return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
	});
	const pending = client.tools(token); await new Promise(resolve => setImmediate(resolve)); cancelled();
	await assert.rejects(pending, /aborted/); assert.equal(receivedSignal.aborted, true); assert.equal(disposed, true);
	await assert.rejects(client.tools({ isCancellationRequested: true }), /MCP_CANCELLED/);
});

test('native MCP discovery contains no credentials, resolves secure storage and respects trust and endpoint identity', async () => {
	let provider, trusted = true, connected = false;
	const commands = new Map(), subscriptions = [];
	const disposable = { dispose() { } }, noop = () => disposable;
	const vscode = {
		l10n: { t: value => value }, EventEmitter: class { event = noop; fire() { } dispose() { } },
		Uri: { parse: url => ({ toString: () => url }) },
		McpHttpServerDefinition: class { constructor(label, uri, headers = {}) { Object.assign(this, { label, uri, headers }); } },
		lm: { registerMcpServerDefinitionProvider(_, value) { provider = value; return disposable; } },
		workspace: { get isTrusted() { return trusted; }, getConfiguration: () => ({ get: (_, fallback) => connected ? true : fallback }), onDidGrantWorkspaceTrust: noop, onDidChangeConfiguration: noop },
		commands: { registerCommand(id, handler) { commands.set(id, handler); return disposable; } }
	};
	const secrets = { get: async () => 'unit-only', onDidChange: noop, async delete() { this.deleted = true; } };
	const integration = registerMcp({ subscriptions, secrets }, vscode);
	assert.deepEqual(await integration.credentialState(), { configured: true, enabled: false, locked: false });
	assert.deepEqual(provider.provideMcpServerDefinitions(), []);
	connected = true;
	const definition = provider.provideMcpServerDefinitions()[0];
	assert.deepEqual(definition.headers, {});
	const resolved = await provider.resolveMcpServerDefinition(definition, { isCancellationRequested: false });
	assert.deepEqual(resolved.headers, { 'X-ATS-Agent-Key': 'unit-only' });
	assert.equal(await provider.resolveMcpServerDefinition({ uri: { toString: () => 'https://other.test/' } }, { isCancellationRequested: false }), undefined);
	trusted = false; assert.deepEqual(provider.provideMcpServerDefinitions(), []);
	assert.equal(await provider.resolveMcpServerDefinition(definition, { isCancellationRequested: false }), undefined);
	await commands.get('atsIde.mcpClearKey')(); assert.equal(secrets.deleted, true);
	trusted = true; secrets.get = async () => { trusted = false; return 'unit-only'; };
	assert.equal(await provider.resolveMcpServerDefinition(definition, { isCancellationRequested: false }), undefined);
	subscriptions.forEach(item => item.dispose());
});
