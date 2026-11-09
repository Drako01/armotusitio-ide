/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * OAuth 2.1 for remote MCP servers, run by the IDE because the headless provider CLIs cannot: protected-resource and
 * authorization-server discovery, dynamic client registration, authorization code with PKCE (S256) through a loopback
 * redirect, and token refresh. The user signs in in their own browser; the IDE never sees a password. Every endpoint must
 * be https (or loopback), the state is checked, and tokens are returned to the caller for secret storage only.
 */
import * as http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const CALLBACK_TIMEOUT_MS = 3 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;

export interface OAuthTokens { access: string; refresh?: string; expiresAt?: number; clientId: string; tokenEndpoint: string; resource: string }
export interface OAuthDeps {
	fetch: typeof fetch;
	/** Opens the authorization URL in the user's browser. */
	openBrowser(url: string): Promise<void>;
	now?: () => number;
	timeoutMs?: number;
}
interface ServerMetadata { authorization_endpoint?: string; token_endpoint?: string; registration_endpoint?: string; code_challenge_methods_supported?: string[] }

const base64Url = (bytes: Buffer): string => bytes.toString('base64url');

function secureUrl(text: unknown): string {
	if (typeof text !== 'string') { throw Error('HARNESS_MCP_OAUTH_UNSUPPORTED'); }
	const url = new URL(text);
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) { throw Error('HARNESS_MCP_OAUTH_UNSUPPORTED'); }
	return url.toString();
}

async function getJson<T>(deps: OAuthDeps, url: string): Promise<T | undefined> {
	const response = await deps.fetch(url, { headers: { accept: 'application/json' } }).catch(() => undefined);
	return response?.ok ? await response.json() as T : undefined;
}

async function discover(deps: OAuthDeps, serverUrl: string): Promise<ServerMetadata & { issuer: string }> {
	const origin = new URL(serverUrl).origin;
	const resource = await getJson<{ authorization_servers?: string[] }>(deps, origin + '/.well-known/oauth-protected-resource');
	const issuer = resource?.authorization_servers?.[0] ? secureUrl(resource.authorization_servers[0]).replace(/\/$/, '') : origin;
	const metadata = await getJson<ServerMetadata>(deps, issuer + '/.well-known/oauth-authorization-server');
	if (!metadata?.authorization_endpoint || !metadata.token_endpoint || !metadata.registration_endpoint || !metadata.code_challenge_methods_supported?.includes('S256')) { throw Error('HARNESS_MCP_OAUTH_UNSUPPORTED'); }
	return { ...metadata, issuer, authorization_endpoint: secureUrl(metadata.authorization_endpoint), token_endpoint: secureUrl(metadata.token_endpoint), registration_endpoint: secureUrl(metadata.registration_endpoint) };
}

async function postForm<T>(deps: OAuthDeps, url: string, body: Record<string, string>): Promise<T> {
	const response = await deps.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body).toString() });
	if (!response.ok) { throw Error('HARNESS_MCP_OAUTH_FAILED'); }
	return await response.json() as T;
}

function toTokens(raw: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }, previous: Pick<OAuthTokens, 'clientId' | 'tokenEndpoint' | 'resource' | 'refresh'>, now: number): OAuthTokens {
	if (typeof raw.access_token !== 'string' || !raw.access_token) { throw Error('HARNESS_MCP_OAUTH_FAILED'); }
	const refresh = typeof raw.refresh_token === 'string' ? raw.refresh_token : previous.refresh;
	return { access: raw.access_token, ...(refresh ? { refresh } : {}), ...(typeof raw.expires_in === 'number' ? { expiresAt: now + raw.expires_in * 1000 } : {}), clientId: previous.clientId, tokenEndpoint: previous.tokenEndpoint, resource: previous.resource };
}

/** Waits for the browser to come back to the loopback redirect; resolves with the authorization code. */
function awaitCallback(server: http.Server, state: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(Error('HARNESS_MCP_OAUTH_TIMEOUT')), timeoutMs);
		server.on('request', (request, response) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
			const ok = url.searchParams.get('state') === state && !!url.searchParams.get('code');
			response.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' }).end(ok ? 'Listo. Pod\u00e9s volver al IDE.' : 'No se pudo completar el inicio de sesi\u00f3n.');
			clearTimeout(timer);
			if (ok) { resolve(url.searchParams.get('code')!); } else { reject(Error('HARNESS_MCP_OAUTH_FAILED')); }
		});
	});
}

/** The full browser sign-in for one MCP server URL. */
export async function authorizeMcpServer(serverUrl: string, deps: OAuthDeps): Promise<OAuthTokens> {
	const resource = secureUrl(serverUrl);
	const metadata = await discover(deps, resource);
	const listener = http.createServer();
	await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
	try {
		const redirect = 'http://127.0.0.1:' + (listener.address() as { port: number }).port + '/callback';
		const registration = await deps.fetch(metadata.registration_endpoint!, {
			method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ client_name: 'ArmoTuSitio IDE', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })
		});
		const client = registration.ok ? await registration.json() as { client_id?: unknown } : undefined;
		if (typeof client?.client_id !== 'string') { throw Error('HARNESS_MCP_OAUTH_FAILED'); }
		const verifier = base64Url(randomBytes(48));
		const state = base64Url(randomBytes(16));
		const authorize = new URL(metadata.authorization_endpoint!);
		for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state, code_challenge: base64Url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource })) { authorize.searchParams.set(key, value); }
		const code = awaitCallback(listener, state, deps.timeoutMs ?? CALLBACK_TIMEOUT_MS);
		code.catch(() => undefined);
		await deps.openBrowser(authorize.toString());
		const raw = await postForm<Record<string, unknown>>(deps, metadata.token_endpoint!, { grant_type: 'authorization_code', code: await code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource });
		return toTokens(raw, { clientId: client.client_id, tokenEndpoint: metadata.token_endpoint!, resource }, (deps.now ?? Date.now)());
	} finally { listener.close(); }
}

/** A still-valid token as is; an expiring one is renewed with its refresh token. `undefined` means the user must sign in again. */
export async function freshTokens(tokens: OAuthTokens, deps: OAuthDeps): Promise<OAuthTokens | undefined> {
	const now = (deps.now ?? Date.now)();
	if (tokens.expiresAt === undefined || tokens.expiresAt - REFRESH_MARGIN_MS > now) { return tokens; }
	if (!tokens.refresh) { return undefined; }
	try {
		const raw = await postForm<Record<string, unknown>>(deps, tokens.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: tokens.clientId, resource: tokens.resource });
		return toTokens(raw, tokens, now);
	} catch { return undefined; }
}
