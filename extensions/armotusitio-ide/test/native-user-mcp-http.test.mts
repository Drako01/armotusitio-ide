/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createUserMcpBridge } from '../src/native-user-mcp.ts';
import type { McpLaunch } from '../src/native-mcp-servers.ts';

async function fixture(mode = 'json') {
	let calls = 0; let deleted = 0; let allowed = true; let enabled = true; let approvals = 0; let denials = 0;
	const requests: Array<{ method: string; auth?: string; session?: string; protocol?: string }> = [];
	const server = createServer(async (request, response) => {
		if (request.method === 'DELETE') { deleted++; response.writeHead(204).end(); return; }
		let body = ''; for await (const chunk of request) { body += chunk; }
		const rpc = JSON.parse(body);
		if (rpc.error?.code === -32601) { denials++; response.writeHead(202).end(); return; }
		if (rpc.id === 777 && Object.hasOwn(rpc, 'result')) { denials++; response.writeHead(202).end(); return; }
		requests.push({ method: rpc.method, auth: request.headers.authorization, session: request.headers['mcp-session-id'] as string, protocol: request.headers['mcp-protocol-version'] as string });
		if (mode === 'redirect') { response.writeHead(307, { location: '/stolen' }).end(); return; }
		if (mode === 'hang') { return; }
		if (rpc.id === undefined) { response.writeHead(202).end(); return; }
		if (rpc.method === 'initialize') { response.setHeader('Mcp-Session-Id', 'fixture-session'); }
		const result = rpc.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
			: rpc.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
				: (calls++, { content: [{ type: 'text', text: request.headers.authorization?.replace(/^Bearer /, '') }] });
		const payload = JSON.stringify({ jsonrpc: '2.0', id: mode === 'wrong-id' ? -1 : rpc.id, result });
		response.setHeader('Content-Type', mode === 'sse' || mode === 'server-requests' ? 'text/event-stream' : 'application/json');
		if (mode === 'server-requests') {
			const requestFromServer = JSON.stringify({ jsonrpc: '2.0', id: 777, method: 'sampling/createMessage', params: {} });
			response.end('data: ' + requestFromServer + '\r\n\r\ndata: ' + payload + '\r\n\r\n');
		} else if (mode === 'sse') {
			// Leave the stream open: the client must complete at the matching message, not at EOF.
			response.write(': keepalive\r\n\r\ndata: ' + payload + '\r\n\r\n');
		} else { response.end(mode === 'large' ? 'x'.repeat(270 * 1024) : mode === 'malformed' ? '{"leaked":"synthetic-response-secret' : payload); }
	});
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	const address = server.address(); assert.ok(address && typeof address !== 'string');
	let entries: Record<string, McpLaunch> = { demo: { type: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'Bearer synthetic-http-canary' } } };
	let onApproval = (): void => undefined;
	const bridge = createUserMcpBridge({ cwd: process.cwd(), env: {}, entries: async () => entries, enabled: () => enabled,
		authorize: async () => { approvals++; onApproval(); return allowed; }, timeoutMs: mode === 'hang' ? 50 : 2000 });
	return { bridge, requests, calls: () => calls, deleted: () => deleted, approvals: () => approvals, denials: () => denials,
		deny: () => { allowed = false; }, disable: () => { enabled = false; },
		change: (value: Record<string, McpLaunch>) => { entries = value; }, onApproval: (action: () => void) => { onApproval = action; },
		async close() { bridge.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

for (const mode of ['json', 'sse']) {
	test(`HTTP ${mode} discovery/call use the IDE broker, private authorization and session cleanup`, async () => {
		const f = await fixture(mode);
		try {
			const [tool] = await f.bridge.tools(); assert.ok(tool);
			assert.ok(!JSON.stringify(tool).includes('synthetic-http-canary'));
			assert.equal(JSON.stringify(await f.bridge.call(tool.name, {})).includes('synthetic-http-canary'), false);
			assert.deepEqual([f.calls(), f.approvals(), f.deleted()], [1, 1, 2]);
			assert.ok(f.requests.every(item => item.auth === 'Bearer synthetic-http-canary'));
			assert.ok(f.requests.filter(item => item.method !== 'initialize').every(item => item.session === 'fixture-session' && item.protocol === '2025-06-18'));
			f.deny(); await assert.rejects(f.bridge.call(tool.name, {}), /DENIED/); assert.equal(f.calls(), 1);
		} finally { await f.close(); }
	});
}

test('HTTP revocation during approval prevents dispatch and disabled catalogs disappear', async () => {
	const f = await fixture();
	try {
		const [tool] = await f.bridge.tools(); f.onApproval(() => f.change({}));
		await assert.rejects(f.bridge.call(tool.name, {}), /SERVER_CHANGED/); assert.equal(f.calls(), 0);
		f.disable(); assert.deepEqual(await f.bridge.tools(), []);
	} finally { await f.close(); }
});

test('disposing cancels an active HTTP discovery without dispatching a tool', async () => {
	const f = await fixture('hang');
	try {
		const discovery = f.bridge.tools();
		f.bridge.dispose();
		assert.deepEqual(await discovery, []);
		assert.equal(f.calls(), 0);
	} finally { await f.close(); }
});

for (const mode of ['redirect', 'wrong-id', 'large', 'hang', 'malformed']) {
	test(`HTTP ${mode} fails closed without tool dispatch`, async () => {
		const f = await fixture(mode);
		try {
			assert.deepEqual(await f.bridge.tools(), []);
			assert.equal(f.bridge.diagnostics().length, 1);
			assert.equal(JSON.stringify(f.bridge.diagnostics()).includes('synthetic-response-secret'), false);
			assert.equal(f.requests.length, 1); assert.equal(f.calls(), 0);
		} finally { await f.close(); }
	});
}

test('HTTP rejects insecure destinations and routing headers before connecting', async () => {
	const f = await fixture();
	try {
		for (const entry of [
			{ type: 'http', url: 'http://192.0.2.1/mcp' },
			{ type: 'http', url: 'https://user:password@example.test/mcp' },
			{ type: 'http', url: 'https://example.test/mcp', headers: { Host: 'elsewhere' } }
		] satisfies McpLaunch[]) {
			f.change({ demo: entry }); assert.deepEqual(await f.bridge.tools(), []);
		}
		assert.equal(f.requests.length, 0);
	} finally { await f.close(); }
});


test('HTTP SSE answers server-initiated sampling with a denial and preserves the real RPC result', async () => {
	const f = await fixture('server-requests');
	try {
		const [tool] = await f.bridge.tools();
		assert.ok(tool);
		assert.ok(f.denials() >= 1);
		const result = await f.bridge.call(tool.name, {});
		assert.equal(JSON.stringify(result).includes('synthetic-http-canary'), false);
		assert.equal(f.approvals(), 1);
		assert.equal(f.calls(), 1);
		assert.ok(f.denials() >= 2);
	} finally { await f.close(); }
});
