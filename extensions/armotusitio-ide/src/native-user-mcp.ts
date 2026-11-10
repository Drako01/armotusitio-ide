/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** User MCP for providers without a per-tool MCP approval protocol. Credentials remain in the IDE. */
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { JsonRpcConnection } from './runtime/json-rpc.ts';
import { resolveNativeCommand, stopProcess } from './native-runtime.ts';
import { redactSecrets } from './native-redact.ts';
import { secretVariants } from './native-dev-secrets.ts';
import type { McpLaunch } from './native-mcp-servers.ts';
import type { WorkMcpTool } from './native-mcp-bridge.ts';

export const USER_MCP_TOOL_PREFIX = 'user_mcp__';
const MAX_TOOLS = 128;
const MAX_CATALOG_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const SYSTEM_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']);
type StdioLaunch = Extract<McpLaunch, { type: 'stdio' }>;
interface RemoteTool { server: string; tool: string; entry: string }

/** Redact assigned credential values even when they do not resemble a known token format. */
function safeValue(value: unknown, entry: StdioLaunch): unknown {
	const secrets = Object.values(entry.env ?? {}).flatMap(value => [...secretVariants(value), ...(value ? [value] : [])]);
	const text = (value: string): string => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), redactSecrets(value));
	const visit = (item: unknown): unknown => typeof item === 'string' ? text(item) : Array.isArray(item) ? item.map(visit)
		: item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [text(key), visit(child)])) : item;
	return visit(value);
}

/** Only the server's explicitly assigned secrets cross this boundary; provider auth and IDE tokens never do. */
function serverEnvironment(source: NodeJS.ProcessEnv, entry: StdioLaunch): NodeJS.ProcessEnv {
	return { ...Object.fromEntries(Object.entries(source).filter(([name]) => SYSTEM_ENV.has(name.toUpperCase()))), ...entry.env };
}

/** One short-lived MCP connection, sharing the existing bounded RPC machinery and process-tree supervisor. */
async function withServer<T>(entry: StdioLaunch, options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number }, work: (rpc: JsonRpcConnection) => Promise<T>): Promise<T> {
	if (options.signal.aborted) { throw Error('HARNESS_MCP_CANCELLED'); }
	const env = serverEnvironment(options.env, entry);
	// Native absolute paths are allowed; Windows shell shims are never executed.
	if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(entry.command)) { throw Error('HARNESS_MCP_STDIO_UNSUPPORTED'); }
	const command = path.isAbsolute(entry.command) ? { executable: entry.command, args: entry.args, embeddedNode: false }
		: await resolveNativeCommand(entry.command, entry.args, env);
	if (options.signal.aborted) { throw Error('HARNESS_MCP_CANCELLED'); }
	if (command.embeddedNode) { env.ELECTRON_RUN_AS_NODE = '1'; }
	const child = spawn(command.executable, command.args, { cwd: options.cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
	const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
	// The runtime connection also serves Codex (which omits jsonrpc); add the MCP wire envelope here.
	const input = new Writable({
		write(chunk: Buffer, _encoding, done) {
			try { child.stdin.write(JSON.stringify({ ...JSON.parse(chunk.toString()), jsonrpc: '2.0' }) + '\n', done); }
			catch { done(Error('HARNESS_MCP_PROTOCOL')); }
		}
	});
	const rpc = new JsonRpcConnection(input, child.stdout, {
		request: async () => { throw Error('HARNESS_MCP_SERVER_REQUEST_DENIED'); },
		notification: () => undefined,
		malformed: () => { rpc.close(Error('HARNESS_MCP_PROTOCOL')); stopProcess(child); }
	});
	child.stderr.resume(); // Never persist raw diagnostics, which may contain credentials.
	child.stdin.on('error', () => rpc.close(Error('HARNESS_MCP_CONNECTION_LOST')));
	child.once('error', () => rpc.close(Error('HARNESS_MCP_CONNECTION_LOST')));
	child.once('close', () => rpc.close(Error('HARNESS_MCP_CONNECTION_LOST')));
	const abort = (): void => { rpc.close(Error('HARNESS_MCP_CANCELLED')); stopProcess(child); };
	options.signal.addEventListener('abort', abort, { once: true });
	try {
		const initialized = await rpc.request<{ protocolVersion?: string; capabilities?: { tools?: object } }>('initialize', {
			protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'armotusitio-ide', version: '0.6.0' }
		}, options.timeoutMs);
		if (!initialized || !['2025-06-18', '2025-03-26', '2024-11-05'].includes(initialized.protocolVersion ?? '') || !initialized.capabilities?.tools) { throw Error('HARNESS_MCP_PROTOCOL'); }
		rpc.notify('notifications/initialized');
		return await work(rpc);
	} finally {
		options.signal.removeEventListener('abort', abort);
		rpc.close();
		input.destroy();
		stopProcess(child);
		// The shared supervisor owns the platform fallback; await process closure before releasing resources.
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try { await Promise.race([exited, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(Error('HARNESS_MCP_STOP_FAILED')), 5000); })]); }
		finally { clearTimeout(deadline); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
	}
}

function validateTools(value: { tools?: WorkMcpTool[]; nextCursor?: string }): WorkMcpTool[] {
	if (!value || value.nextCursor || !Array.isArray(value.tools) || value.tools.length > MAX_TOOLS || JSON.stringify(value).length > MAX_CATALOG_BYTES) { throw Error('HARNESS_MCP_CATALOG_INVALID'); }
	const names = new Set<string>();
	for (const tool of value.tools) {
		if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || names.has(tool.name)
			|| !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)
			|| (tool.description !== undefined && typeof tool.description !== 'string')) { throw Error('HARNESS_MCP_CATALOG_INVALID'); }
		names.add(tool.name);
	}
	return value.tools;
}

/** Stdio-only first slice. HTTP/SSE is deliberately not connected until redirect/auth policy is implemented. */
export function createUserMcpBridge(options: {
	entries(): Promise<Record<string, McpLaunch>>;
	enabled(): boolean;
	/** The existing IDE approval broker, with live permissions and project integrity rechecked. */
	authorize(server: string, tool: string, args: Record<string, unknown>): Promise<boolean>;
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): { tools(): Promise<WorkMcpTool[]>; call(name: string, args: unknown): Promise<unknown>; diagnostics(): readonly { server: string; code: string }[]; dispose(): void } {
	const stopped = new AbortController();
	const known = new Map<string, RemoteTool>();
	let discoveryFailures: Array<{ server: string; code: string }> = [];
	let busy = false;
	const enabled = (): boolean => !stopped.signal.aborted && options.enabled();
	const current = async (server: string, fingerprint: string): Promise<StdioLaunch> => {
		const entry = (await options.entries())[server];
		if (!enabled() || entry?.type !== 'stdio' || JSON.stringify(entry) !== fingerprint) { throw Error('HARNESS_MCP_SERVER_CHANGED'); }
		return entry;
	};
	return {
		async tools() {
			known.clear();
			discoveryFailures = [];
			if (!enabled()) { return []; }
			const tools: WorkMcpTool[] = [];
			for (const [server, entry] of Object.entries(await options.entries())) {
				if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(server) || entry.type !== 'stdio') { continue; }
				try {
					const catalog = await withServer(entry, { ...options, signal: stopped.signal, timeoutMs: options.timeoutMs ?? 5000 }, async rpc => validateTools(await rpc.request('tools/list', {}, options.timeoutMs ?? 5000)));
					if (!enabled()) { return []; }
					for (const tool of catalog) {
						const name = USER_MCP_TOOL_PREFIX + server + '__' + createHash('sha256').update(tool.name).digest('hex').slice(0, 12);
						if (known.has(name) || tools.length >= MAX_TOOLS) { throw Error('HARNESS_MCP_CATALOG_INVALID'); }
						known.set(name, { server, tool: tool.name, entry: JSON.stringify(entry) });
						const exposed = { name, description: String(safeValue(`[${server}/${tool.name}] ${tool.description ?? ''}`, entry)).slice(0, 2000), inputSchema: safeValue(tool.inputSchema, entry) as Record<string, unknown> };
						if (JSON.stringify([...tools, exposed]).length > MAX_CATALOG_BYTES) { known.delete(name); throw Error('HARNESS_MCP_CATALOG_INVALID'); }
						tools.push(exposed);
					}
				} catch (error) {
					const code = error instanceof Error && /^HARNESS_[A-Z_]+$/.test(error.message) ? error.message : 'HARNESS_MCP_DISCOVERY_FAILED';
					if (discoveryFailures.length < 16) { discoveryFailures.push({ server, code }); }
				}
			}
			return tools;
		},
		async call(name, value) {
			const tool = known.get(name);
			if (!enabled() || !tool || busy) { throw Error('HARNESS_MCP_TOOL_DENIED'); }
			if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 128 * 1024) { throw Error('HARNESS_MCP_INPUT_INVALID'); }
			const args = structuredClone(value) as Record<string, unknown>;
			busy = true;
			try {
				const entry = await current(tool.server, tool.entry);
				const result = await withServer(entry, { ...options, signal: stopped.signal, timeoutMs: options.timeoutMs ?? 30000 }, async rpc => {
					const tools = validateTools(await rpc.request('tools/list', {}, options.timeoutMs ?? 30000));
					if (!tools.some(candidate => candidate.name === tool.tool)) { throw Error('HARNESS_MCP_TOOL_DENIED'); }
					// Authorize after handshake/discovery, immediately before dispatch rather than before network waits.
					if (!await options.authorize(tool.server, tool.tool, args)) { throw Error('HARNESS_MCP_TOOL_DENIED'); }
					await current(tool.server, tool.entry);
					return await rpc.request('tools/call', { name: tool.tool, arguments: args }, options.timeoutMs ?? 30000);
				});
				await current(tool.server, tool.entry);
				const text = JSON.stringify(result);
				if (!text || text.length > MAX_RESULT_BYTES) { throw Error('HARNESS_MCP_RESULT_TOO_LARGE'); }
				return safeValue(result, entry);
			} finally { busy = false; }
		},
		diagnostics() { return discoveryFailures.map(failure => ({ ...failure })); },
		dispose() { stopped.abort(); known.clear(); }
	};
}
