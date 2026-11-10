/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** User-added MCP servers: validation, secrets kept out of the stored file, and the per-run launch entries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServerStore, parseServerWords, type McpSecrets } from '../src/native-mcp-servers.ts';

function memorySecrets(): McpSecrets & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return { map, get: async key => map.get(key), store: async (key, value) => { map.set(key, value); }, delete: async key => { map.delete(key); } };
}

async function withStore(run: (store: McpServerStore, secrets: ReturnType<typeof memorySecrets>, directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-mcp-servers-'));
	try { const secrets = memorySecrets(); await run(new McpServerStore(directory, secrets), secrets, directory); }
	finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('words after the name are a URL or a command, never both', () => {
	assert.deepEqual([parseServerWords('a', ['https://x.test/mcp']), parseServerWords('a', ['npx', '-y', 'srv']), parseServerWords('a', ['https://x.test', 'extra']), parseServerWords('a', [])],
		[{ name: 'a', url: 'https://x.test/mcp' }, { name: 'a', command: 'npx', args: ['-y', 'srv'] }, undefined, undefined]);
});

test('servers are validated, secrets stay out of the stored file, and launch entries resolve them', async () => {
	await withStore(async (store, secrets, directory) => {
		await store.add({ name: 'Remote', url: 'https://mcp.example.com/sse', token: 'tok-123' });
		await store.add({ name: 'local', command: 'node', args: ['server.js'], env: { API_KEY: 'sk-secret' } });
		const refused: string[] = [];
		for (const bad of [
			{ name: 'ats-runner', url: 'https://a.test' }, { name: 'has_underscore', url: 'https://a.test' }, { name: 'x', url: 'http://remote.test' }, { name: 'x', url: 'https://user:pw@a.test' },
			{ name: 'x', command: 'node', env: { 'bad name': 'v' } }, { name: 'remote', url: 'https://other.test' }
		]) { refused.push(await store.add(bad).then(() => 'accepted', error => (error as Error).message)); }
		const stored = await fs.readFile(path.join(directory, 'servers.json'), 'utf8');
		const entries = await store.launchEntries();
		await store.setEnabled('local', false);
		const afterDisable = Object.keys(await store.launchEntries());
		const removed = await store.remove('remote');
		assert.deepEqual({
			refused, leaked: stored.includes('tok-123') || stored.includes('sk-secret'), entries, afterDisable, removed, secretsLeft: [...secrets.map.keys()], names: (await store.list()).map(server => server.name)
		}, {
			refused: ['HARNESS_MCP_SERVER_INVALID', 'HARNESS_MCP_SERVER_INVALID', 'HARNESS_MCP_SERVER_INVALID', 'HARNESS_MCP_SERVER_INVALID', 'HARNESS_MCP_SERVER_INVALID', 'HARNESS_MCP_SERVER_EXISTS'],
			leaked: false,
			entries: {
				remote: { type: 'http', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer tok-123' } },
				local: { type: 'stdio', command: 'node', args: ['server.js'], env: { API_KEY: 'sk-secret' } }
			},
			afterDisable: ['remote'], removed: true, secretsLeft: ['atsHarness.mcp.local.env'], names: ['local']
		});
	});
});

test('a damaged servers file is reported and never overwritten', async () => {
	await withStore(async (store, _secrets, directory) => {
		await fs.writeFile(path.join(directory, 'servers.json'), '{broken');
		const refused = await store.add({ name: 'a', url: 'https://a.test' }).then(() => 'accepted', error => (error as Error).message);
		assert.deepEqual({ refused, bytes: await fs.readFile(path.join(directory, 'servers.json'), 'utf8') }, { refused: 'HARNESS_MCP_SERVERS_UNSAFE', bytes: '{broken' });
	});
});


test('legacy SSE remains opt-in and its token stays in secret storage', async () => {
	assert.deepEqual(parseServerWords('old', ['--legacy-sse', 'http://localhost:9911/sse']),
		{ name: 'old', url: 'http://localhost:9911/sse', transport: 'sse' });
	assert.equal(parseServerWords('old', ['--legacy-sse', 'http://localhost/sse', 'extra']), undefined);
	await withStore(async (store, secrets, directory) => {
		await store.add({ name: 'old', url: 'http://localhost:9911/sse', transport: 'sse', token: 'canary-legacy-private' });
		const stored = await fs.readFile(path.join(directory, 'servers.json'), 'utf8');
		assert.equal(stored.includes('canary-legacy-private'), false);
		assert.equal(secrets.map.size, 1);
		assert.deepEqual(await store.launchEntries(), {
			old: { type: 'sse', url: 'http://localhost:9911/sse', headers: { Authorization: 'Bearer canary-legacy-private' } }
		});
	});
});
