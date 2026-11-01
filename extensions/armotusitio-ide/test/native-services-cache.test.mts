/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { composeUpCommand, needsFromUrls, parseCompose, probeService } from '../src/native-services.ts';
import { suggestGates } from '../src/native-gate-suggestions.ts';
import { detectRedis, parseRedisEndpoint } from '../src/native-redis.ts';
import { cacheKey, createResultCache, treeDigest } from '../src/native-result-cache.ts';

/** A local TCP server that answers the first packet with `reply`. */
async function fakeServer(reply: (data: Buffer) => Buffer | string | undefined): Promise<{ port: number; close(): Promise<void> }> {
	const server = net.createServer(socket => socket.on('data', data => { const answer = reply(data); if (answer !== undefined) { socket.write(answer); } }));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return { port: (server.address() as net.AddressInfo).port, close: () => new Promise(resolve => server.close(() => resolve())) };
}

test('services are detected from compose and URLs and probed by protocol, so another program on the port is not mistaken for them', async () => {
	const compose = 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "15432:5432"\n  cache:\n    image: redis:7\n  web:\n    image: nginx\n';
	assert.deepEqual(parseCompose(compose, 'compose.yml').map(need => [need.kind, need.port, need.composeService]), [['postgres', 15432, 'db'], ['redis', 6379, 'cache']]);
	assert.deepEqual(needsFromUrls({ DATABASE_URL: 'postgres://u:p@localhost:5544/db', REMOTE_URL: 'postgres://db.example.com/x', NAME: 'x' }, 'env').map(need => [need.kind, need.host, need.port]), [['postgres', '127.0.0.1', 5544]]);
	const postgres = await fakeServer(() => 'N');
	const http = await fakeServer(() => 'HTTP/1.1 200 OK\r\n\r\n');
	const closed = await fakeServer(() => undefined); await closed.close();
	try {
		const probe = (port: number) => probeService({ kind: 'postgres', host: '127.0.0.1', port, source: 'compose.yml', composeService: 'db' }).then(result => result.status);
		assert.deepEqual([await probe(postgres.port), await probe(http.port), await probe(closed.port)], ['up', 'other-service', 'down']);
		assert.deepEqual(composeUpCommand({ kind: 'postgres', host: '127.0.0.1', port: 1, source: 'compose.yml', composeService: 'db' }), { command: 'docker', args: ['compose', '-f', 'compose.yml', 'up', '-d', 'db'] });
	} finally { await postgres.close(); await http.close(); }
});

test('suggested gates cover every subproject of a monorepo with unique ids', () => {
	assert.deepEqual(suggestGates([{ path: 'apps/api', ecosystem: 'go' }, { path: 'apps/web', ecosystem: 'node', packageManager: 'pnpm', scripts: ['lint', 'test'] }, { path: 'docs', ecosystem: 'node', scripts: [] }]), [
		{ id: 'go-apps-api', executable: 'go', args: ['test', './...'], cwd: 'apps/api' },
		{ id: 'node-apps-web', executable: 'pnpm', args: ['test'], cwd: 'apps/web' }
	]);
});

test('Redis: the first loopback server that answers PONG without a password, in a fixed order; credentials are never used', async () => {
	const locked = await fakeServer(() => '-NOAUTH Authentication required.\r\n');
	const open = await fakeServer(data => data.toString().includes('PING') ? '+PONG\r\n' : '$-1\r\n');
	try {
		assert.deepEqual([parseRedisEndpoint('redis://user:pass@127.0.0.1:6379'), parseRedisEndpoint('redis://10.0.0.5:6379'), parseRedisEndpoint('localhost:16379')], [undefined, undefined, { host: '127.0.0.1', port: 16379 }]);
		const found = await detectRedis({ setting: '127.0.0.1:' + locked.port, environment: undefined, candidates: ['127.0.0.1:' + open.port] });
		assert.deepEqual(found, { host: '127.0.0.1', port: open.port });
	} finally { await locked.close(); await open.close(); }
});

test('the cache reuses a result only for identical inputs; any tracked or uncommitted change invalidates it; disk works without Redis', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-cache-')));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-cache-store-'));
	try {
		const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
		git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 'T');
		await fs.writeFile(path.join(root, 'a.go'), 'package a'); git('add', '.'); git('commit', '-qm', 'base');
		const cache = await createResultCache({ directory: storage, projectRoot: root, candidates: [] });
		const key = async () => cacheKey({ command: 'go', args: ['test'], cwd: '.', tree: (await treeDigest(root))! });
		const first = await key();
		await cache.set(first, { status: 'passed', durationMs: 10, at: new Date(0).toISOString() }, 60);
		const hit = await cache.get(await key());
		await fs.writeFile(path.join(root, 'a.go'), 'package a // edit');
		assert.deepEqual({ backend: cache.backend, describe: cache.describe(), hit: hit?.status, invalidated: (await key()) !== first, miss: await cache.get(await key()) },
			{ backend: 'disk', describe: 'disco', hit: 'passed', invalidated: true, miss: undefined });
	} finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});
