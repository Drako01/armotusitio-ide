/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * MCP servers the user connects to the chat (`/mcp add`). The definition (name, URL or command) is stored in private IDE
 * storage; every credential (bearer token, environment values) lives only in the IDE's secret storage and reaches a
 * server only through the per-run launch file the extension writes with mode 0600 and deletes afterwards. A server is
 * a name the model can address as `mcp__<name>__<tool>`: names have no underscores so the split is unambiguous.
 */
import { LockedJson } from './native-locked-json.ts';
import { freshTokens, type OAuthDeps, type OAuthTokens } from './native-mcp-oauth.ts';

export const MCP_SERVERS_SCHEMA_VERSION = 1;
export const RESERVED_SERVER_NAMES: readonly string[] = ['ats-runner', 'armotusitio'];
const MAX_BYTES = 128 * 1024;
const MAX_SERVERS = 16;
const MAX_ARGS = 20;
const MAX_ARG_LENGTH = 500;
const MAX_ENV = 10;
const MAX_SECRET_LENGTH = 2000;
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface McpServer {
	name: string;
	transport: 'stdio' | 'http' | 'sse';
	/** stdio: the executable and its arguments (never run through a shell). */
	command?: string;
	args?: string[];
	/** stdio: names of the environment variables kept in secret storage (the values are never listed). */
	envNames?: string[];
	/** http: the endpoint; a bearer token, when needed, is kept in secret storage. */
	url?: string;
	hasToken?: boolean;
	/** http: signed in with OAuth by the IDE; the tokens are kept in secret storage and renewed before each run. */
	oauth?: boolean;
	enabled: boolean;
}
export interface McpSecrets { get(key: string): PromiseLike<string | undefined>; store(key: string, value: string): PromiseLike<void>; delete(key: string): PromiseLike<void> }
interface ServersFile { schemaVersion: number; servers: McpServer[] }
/** What the user supplies when adding a server; `token` and `env` go to secret storage. */
export interface McpServerInput { name: string; url?: string; command?: string; args?: string[]; token?: string; env?: Record<string, string>; oauth?: OAuthTokens; transport?: 'sse' }
/** The server entry Claude's `--mcp-config` reads. */
export type McpLaunch = { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> } | { type: 'http'; url: string; headers?: Record<string, string> } | { type: 'sse'; url: string; headers?: Record<string, string> };

const empty = (): ServersFile => ({ schemaVersion: MCP_SERVERS_SCHEMA_VERSION, servers: [] });

function validUrl(text: unknown): text is string {
	if (typeof text !== 'string' || text.length > 500 || CONTROL.test(text)) { return false; }
	try {
		const url = new URL(text);
		if (url.username || url.password) { return false; }
		const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
		return url.protocol === 'https:' || (url.protocol === 'http:' && local);
	} catch { return false; }
}

function validServer(server: unknown): server is McpServer {
	const value = server as Partial<McpServer> | undefined;
	if (!value || typeof value.name !== 'string' || !NAME.test(value.name) || RESERVED_SERVER_NAMES.includes(value.name) || typeof value.enabled !== 'boolean') { return false; }
	if (value.transport === 'http' || value.transport === 'sse') { return validUrl(value.url) && !value.command && !(value.hasToken && value.oauth); }
	return value.transport === 'stdio' && typeof value.command === 'string' && !!value.command && value.command.length <= MAX_ARG_LENGTH && !CONTROL.test(value.command) && !value.url &&
		Array.isArray(value.args) && value.args.length <= MAX_ARGS && value.args.every(arg => typeof arg === 'string' && arg.length <= MAX_ARG_LENGTH && !CONTROL.test(arg)) &&
		(value.envNames ?? []).every(name => ENV_NAME.test(name));
}

function validFile(file: unknown): file is ServersFile {
	const value = file as Partial<ServersFile> | undefined;
	return !!value && value.schemaVersion === MCP_SERVERS_SCHEMA_VERSION && Array.isArray(value.servers) && value.servers.length <= MAX_SERVERS && value.servers.every(validServer) &&
		new Set(value.servers.map(server => server.name)).size === value.servers.length;
}

function validSecret(value: string): boolean { return value.length <= MAX_SECRET_LENGTH && !CONTROL.test(value); }

/**
 * `/mcp add` words after the name: one `https://` (or localhost `http://`) URL for a remote server, otherwise a command and
 * its arguments. `undefined` when there is nothing to add.
 */
export function parseServerWords(name: string, words: readonly string[]): McpServerInput | undefined {
	const [first, ...rest] = words;
	if (!first) { return undefined; }
	if (first === '--legacy-sse') { return rest.length === 1 && /^https?:\/\//i.test(rest[0]) ? { name, url: rest[0], transport: 'sse' } : undefined; }
	if (/^https?:\/\//i.test(first)) { return rest.length === 0 ? { name, url: first } : undefined; }
	return { name, command: first, args: rest };
}

export class McpServerStore {
	private readonly store: LockedJson<ServersFile>;
	private readonly secrets: McpSecrets;
	private readonly oauth: OAuthDeps | undefined;

	constructor(directory: string, secrets: McpSecrets, oauth?: OAuthDeps) {
		this.oauth = oauth;
		this.store = new LockedJson(directory, 'servers.json', MAX_BYTES, empty, validFile, 'HARNESS_MCP_SERVERS_UNSAFE');
		this.secrets = secrets;
	}

	async list(): Promise<McpServer[]> { return (await this.store.read()).servers.map(server => ({ ...server })); }

	async add(input: McpServerInput): Promise<McpServer> {
		const name = input.name.trim().toLowerCase();
		const envNames = Object.keys(input.env ?? {});
		const server: McpServer = input.url !== undefined
			? { name, transport: input.transport ?? 'http', url: input.url, ...(input.token ? { hasToken: true } : {}), ...(input.oauth ? { oauth: true } : {}), enabled: true }
			: { name, transport: 'stdio', command: input.command, args: input.args ?? [], ...(envNames.length ? { envNames } : {}), enabled: true };
		const secretsOk = (!input.transport || input.url !== undefined) && Object.values(input.env ?? {}).every(validSecret) && (input.token === undefined || validSecret(input.token)) && envNames.length <= MAX_ENV;
		if (!validServer(server) || !secretsOk) { throw Error('HARNESS_MCP_SERVER_INVALID'); }
		return this.store.update(async file => {
			if (file.servers.some(item => item.name === name)) { throw Error('HARNESS_MCP_SERVER_EXISTS'); }
			if (file.servers.length >= MAX_SERVERS) { throw Error('HARNESS_MCP_SERVER_LIMIT'); }
			if (input.token) { await this.secrets.store(this.key(name, 'token'), input.token); }
			if (input.oauth) { await this.secrets.store(this.key(name, 'oauth'), JSON.stringify(input.oauth)); }
			if (envNames.length) { await this.secrets.store(this.key(name, 'env'), JSON.stringify(input.env)); }
			file.servers.push(server);
			return { ...server };
		});
	}

	async remove(name: string): Promise<boolean> {
		return this.store.update(async file => {
			const before = file.servers.length;
			file.servers = file.servers.filter(server => server.name !== name);
			await Promise.all([this.secrets.delete(this.key(name, 'token')), this.secrets.delete(this.key(name, 'env')), this.secrets.delete(this.key(name, 'oauth'))]);
			return file.servers.length !== before;
		});
	}

	async setEnabled(name: string, enabled: boolean): Promise<boolean> {
		return this.store.update(async file => { const server = file.servers.find(item => item.name === name); if (server) { server.enabled = enabled; } return !!server; });
	}

	/** The enabled servers as Claude's `mcpServers` entries, with secrets resolved; keep the result out of logs. */
	async launchEntries(): Promise<Record<string, McpLaunch>> {
		const entries: Record<string, McpLaunch> = {};
		for (const server of (await this.store.read()).servers.filter(item => item.enabled)) {
			if (server.transport === 'http' || server.transport === 'sse') {
				const token = server.oauth ? (await this.oauthTokens(server.name))?.access : server.hasToken ? await this.secrets.get(this.key(server.name, 'token')) : undefined;
				// An OAuth server whose session cannot be renewed is left out until the user signs in again.
				if (server.oauth && !token) { continue; }
				const connection = { url: server.url!, ...(token ? { headers: { Authorization: 'Bearer ' + token } } : {}) };
				entries[server.name] = server.transport === 'sse' ? { type: 'sse', ...connection } : { type: 'http', ...connection };
			} else {
				const raw = server.envNames?.length ? await this.secrets.get(this.key(server.name, 'env')) : undefined;
				entries[server.name] = { type: 'stdio', command: server.command!, args: server.args ?? [], ...(raw ? { env: JSON.parse(raw) as Record<string, string> } : {}) };
			}
		}
		return entries;
	}

	/** Names of OAuth servers whose session is gone or cannot be renewed: the user has to sign in again. */
	async needsSignIn(): Promise<string[]> {
		const names: string[] = [];
		for (const server of (await this.store.read()).servers.filter(item => item.oauth)) { if (!await this.oauthTokens(server.name)) { names.push(server.name); } }
		return names;
	}

	/** Stored tokens, renewed when they are about to expire (the renewed set replaces the stored one). */
	private async oauthTokens(name: string): Promise<OAuthTokens | undefined> {
		const raw = await this.secrets.get(this.key(name, 'oauth'));
		if (!raw || !this.oauth) { return undefined; }
		const stored = JSON.parse(raw) as OAuthTokens;
		const tokens = await freshTokens(stored, this.oauth);
		if (tokens && tokens !== stored) { await this.secrets.store(this.key(name, 'oauth'), JSON.stringify(tokens)); }
		return tokens;
	}

	private key(name: string, part: 'token' | 'env' | 'oauth'): string { return 'atsHarness.mcp.' + name + '.' + part; }
}
