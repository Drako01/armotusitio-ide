/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { McpLaunch } from './native-mcp-servers.ts';

type HttpLaunch = Extract<McpLaunch, { type: 'http' }>;
export interface UserMcpRpc { request<T>(method: string, params: object, timeoutMs?: number): Promise<T> }

/** Short-lived Streamable HTTP session. Inert server notifications and ping are supported; privileged server requests are denied. */
export async function withHttpMcp<T>(entry: HttpLaunch, options: { signal: AbortSignal; timeoutMs: number }, work: (rpc: UserMcpRpc) => Promise<T>): Promise<T> {
	const url = new URL(entry.url);
	if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) { throw Error('HARNESS_MCP_HTTP_URL'); }
	// Only explicit authorization belongs to this endpoint. Never accept routing/Host/cookie overrides.
	const headers = new Headers();
	for (const [name, value] of Object.entries(entry.headers ?? {})) {
		if (name.toLowerCase() !== 'authorization' || value.length > 8192 || /[\r\n]/.test(value)) { throw Error('HARNESS_MCP_HTTP_HEADERS'); }
		headers.set(name, value);
	}
	headers.set('Content-Type', 'application/json');
	headers.set('Accept', 'application/json, text/event-stream');
	let session: string | undefined;
	let protocol = '2025-06-18';
	let nextId = 0;
	const send = async <R>(method: string, params: object, notification = false): Promise<R> => {
		const id = notification ? undefined : ++nextId;
		const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
		signal.throwIfAborted();
		const requestHeaders = new Headers(headers);
		if (session) { requestHeaders.set('Mcp-Session-Id', session); }
		if (method !== 'initialize') { requestHeaders.set('MCP-Protocol-Version', protocol); }
		const response = await fetch(url, {
			method: 'POST', headers: requestHeaders, redirect: 'error', credentials: 'omit', signal,
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
		});
		try {
			if (!response.ok) { throw Error('HARNESS_MCP_HTTP_STATUS'); }
			const receivedSession = response.headers.get('Mcp-Session-Id');
			if (receivedSession && (receivedSession.length > 256 || !/^[\x21-\x7e]+$/.test(receivedSession) || (session && session !== receivedSession))) { throw Error('HARNESS_MCP_PROTOCOL'); }
			if (method === 'initialize') { session = receivedSession ?? undefined; }
			if (notification) { return undefined as R; }
			if (!response.body) { throw Error('HARNESS_MCP_PROTOCOL'); }
			const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
			if (contentType !== 'application/json' && contentType !== 'text/event-stream') { throw Error('HARNESS_MCP_PROTOCOL'); }
			const reader = response.body.getReader();
			const chunks: Buffer[] = [];
			let size = 0;
			let text = '';
			const decoder = new TextDecoder('utf-8', { fatal: true });
			let serverRequests = 0;
			const decode = async (raw: string): Promise<R | undefined> => {
				const value = JSON.parse(raw) as { jsonrpc?: string; id?: number | string; method?: unknown; result?: R; error?: object };
				if (!value || value.jsonrpc !== '2.0') { throw Error('HARNESS_MCP_PROTOCOL'); }
				if (typeof value.method === 'string') {
					// Server notifications may be observed, but never grant new tools, model calls, roots or permissions.
					if (value.id === undefined || value.id === null) { return undefined; }
					if ((typeof value.id !== 'number' && typeof value.id !== 'string') || ++serverRequests > 8) {
						throw Error('HARNESS_MCP_SERVER_REQUEST_DENIED');
					}
					const replyHeaders = new Headers(requestHeaders);
					if (session) { replyHeaders.set('Mcp-Session-Id', session); }
					const reply = value.method === 'ping'
						? { jsonrpc: '2.0', id: value.id, result: {} }
						: { jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Method not found' } };
					const result = await fetch(url, {
						method: 'POST', headers: replyHeaders, redirect: 'error', credentials: 'omit',
						signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
						body: JSON.stringify(reply)
					});
					try { if (!result.ok && result.status !== 202) { throw Error('HARNESS_MCP_HTTP_STATUS'); } }
					finally { await result.body?.cancel().catch(() => undefined); }
					return undefined;
				}
				if (value.id !== id || value.error || !Object.hasOwn(value, 'result')) { throw Error('HARNESS_MCP_PROTOCOL'); }
				return value.result as R;
			};
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) { break; }
					size += value.length;
					if (size > 256 * 1024) { throw Error('HARNESS_MCP_RESULT_TOO_LARGE'); }
					if (contentType === 'application/json') { chunks.push(Buffer.from(value)); continue; }
					text += decoder.decode(value, { stream: true });
					text = text.replace(/\r\n/g, '\n');
					let end: number;
					while ((end = text.indexOf('\n\n')) >= 0) {
						const event = text.slice(0, end); text = text.slice(end + 2);
						const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
						if (data) { const received = await decode(data); if (received !== undefined) { return received; } }
					}
				}
				if (contentType !== 'application/json') { throw Error('HARNESS_MCP_PROTOCOL'); }
				const decoded = await decode(decoder.decode(Buffer.concat(chunks)));
				if (decoded === undefined) { throw Error('HARNESS_MCP_PROTOCOL'); }
				return decoded;
			} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
		} finally { if (!response.body?.locked) { await response.body?.cancel().catch(() => undefined); } }
	};
	try {
		const initialized = await send<{ protocolVersion?: string; capabilities?: { tools?: object } }>('initialize', {
			protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'armotusitio-ide', version: '0.6.0' }
		});
		if (!initialized || !['2025-06-18', '2025-03-26'].includes(initialized.protocolVersion ?? '') || !initialized.capabilities?.tools) { throw Error('HARNESS_MCP_PROTOCOL'); }
		protocol = initialized.protocolVersion!;
		await send('notifications/initialized', {}, true);
		return await work({ request: <R>(method: string, params: object) => send<R>(method, params) });
	} finally {
		// Session deletion is best effort, never a retry of a tool with possible side effects.
		if (session && !options.signal.aborted) {
			const closeHeaders = new Headers(headers);
			closeHeaders.set('Mcp-Session-Id', session); closeHeaders.set('MCP-Protocol-Version', protocol);
			await fetch(url, {
				method: 'DELETE', headers: closeHeaders, redirect: 'error', credentials: 'omit',
				signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(options.timeoutMs, 1000))])
			})
				.then(response => response.body?.cancel()).catch(() => undefined);
		}
	}
}
