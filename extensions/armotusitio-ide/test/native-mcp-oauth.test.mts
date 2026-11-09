/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** OAuth for remote MCP servers against a local fake authorization server that enforces PKCE, state and refresh. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { authorizeMcpServer, freshTokens, type OAuthDeps } from '../src/native-mcp-oauth.ts';
import { McpServerStore } from '../src/native-mcp-servers.ts';

interface Fake { url: string; log: string[]; close(): Promise<void> }

async function fakeAuthServer(options: { pkce?: boolean } = {}): Promise<Fake> {
	const log: string[] = [];
	const codes = new Map<string, { challenge: string; redirect: string }>();
	let issued = 0;
	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		let body = '';
		request.on('data', chunk => { body += chunk; });
		request.on('end', () => {
			const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
			const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
			if (url.pathname === '/.well-known/oauth-protected-resource') { json({ authorization_servers: [origin] }); }
			else if (url.pathname === '/.well-known/oauth-authorization-server') { json({ authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', code_challenge_methods_supported: options.pkce === false ? ['plain'] : ['S256'] }); }
			else if (url.pathname === '/register') { log.push('register'); json({ client_id: 'client-1' }, 201); }
			else if (url.pathname === '/authorize') {
				const code = 'code-' + ++issued;
				codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')! });
				log.push('authorize:' + url.searchParams.get('code_challenge_method') + ':' + url.searchParams.get('resource'));
				response.writeHead(302, { location: url.searchParams.get('redirect_uri') + '?code=' + code + '&state=' + url.searchParams.get('state') }).end();
			} else if (url.pathname === '/token') {
				const form = new URLSearchParams(body);
				if (form.get('grant_type') === 'authorization_code') {
					const issuedCode = codes.get(form.get('code') ?? '');
					const verified = !!issuedCode && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === issuedCode.challenge && form.get('redirect_uri') === issuedCode.redirect;
					log.push('code:' + verified);
					if (!verified) { json({ error: 'invalid_grant' }, 400); return; }
					json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
				} else {
					const accepted = form.get('refresh_token') === 'refresh-1';
					log.push('refresh:' + form.get('refresh_token'));
					json(accepted ? { access_token: 'access-2', expires_in: 3600 } : { error: 'invalid_grant' }, accepted ? 200 : 400);
				}
			} else { response.writeHead(404).end(); }
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/mcp', log, close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

/** The "browser": follows the authorization URL and its redirect to the IDE's loopback callback. */
const browser = (): OAuthDeps['openBrowser'] => async url => { void fetch(url, { redirect: 'follow' }).catch(() => undefined); };

test('sign-in discovers the server, registers, uses PKCE S256 with the resource, and returns tokens', async () => {
	const fake = await fakeAuthServer();
	try {
		const tokens = await authorizeMcpServer(fake.url, { fetch, openBrowser: browser() });
		assert.deepEqual({ tokens: { access: tokens.access, refresh: tokens.refresh, client: tokens.clientId, hasExpiry: tokens.expiresAt !== undefined }, log: fake.log }, {
			tokens: { access: 'access-1', refresh: 'refresh-1', client: 'client-1', hasExpiry: true }, log: ['register', 'authorize:S256:' + fake.url, 'code:true']
		});
	} finally { await fake.close(); }
});

test('a server without PKCE S256 is refused, and a browser that never returns times out', async () => {
	const weak = await fakeAuthServer({ pkce: false });
	const strong = await fakeAuthServer();
	try {
		const unsupported = await authorizeMcpServer(weak.url, { fetch, openBrowser: browser() }).then(() => 'accepted', error => (error as Error).message);
		const timeout = await authorizeMcpServer(strong.url, { fetch, openBrowser: async () => undefined, timeoutMs: 150 }).then(() => 'accepted', error => (error as Error).message);
		assert.deepEqual({ unsupported, timeout }, { unsupported: 'HARNESS_MCP_OAUTH_UNSUPPORTED', timeout: 'HARNESS_MCP_OAUTH_TIMEOUT' });
	} finally { await weak.close(); await strong.close(); }
});

test('tokens are renewed before they expire, a rejected refresh asks for a new sign-in, and the store keeps tokens out of its file', async () => {
	const fake = await fakeAuthServer();
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-mcp-oauth-'));
	try {
		let clock = Date.now();
		const deps: OAuthDeps = { fetch, openBrowser: browser(), now: () => clock };
		const tokens = await authorizeMcpServer(fake.url, deps);
		const secrets = new Map<string, string>();
		const store = new McpServerStore(directory, { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } }, deps);
		await store.add({ name: 'remote', url: fake.url, oauth: tokens });
		const before = (await store.launchEntries()).remote;
		clock += 2 * 3600 * 1000;
		const renewed = (await store.launchEntries()).remote;
		const afterRenew = await store.needsSignIn();
		secrets.set('atsHarness.mcp.remote.oauth', JSON.stringify({ ...JSON.parse(secrets.get('atsHarness.mcp.remote.oauth')!), refresh: 'revoked', expiresAt: clock - 1 }));
		const rejected = { entries: Object.keys(await store.launchEntries()), needsSignIn: await store.needsSignIn() };
		const stored = await fs.readFile(path.join(directory, 'servers.json'), 'utf8');
		const unchanged = await freshTokens(tokens, { fetch, openBrowser: browser(), now: () => tokens.expiresAt! - 120000 }) === tokens;
		assert.deepEqual({ before, renewed, afterRenew, rejected, leaked: stored.includes('access-') || stored.includes('refresh-'), log: fake.log.filter(line => line.startsWith('refresh')), unchanged }, {
			before: { type: 'http', url: fake.url, headers: { Authorization: 'Bearer access-1' } }, renewed: { type: 'http', url: fake.url, headers: { Authorization: 'Bearer access-2' } }, afterRenew: [],
			rejected: { entries: [], needsSignIn: ['remote'] }, leaked: false, log: ['refresh:refresh-1', 'refresh:revoked', 'refresh:revoked'], unchanged: true
		});
	} finally { await fake.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
