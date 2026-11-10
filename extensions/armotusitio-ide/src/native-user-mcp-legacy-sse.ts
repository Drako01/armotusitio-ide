/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar.
 *--------------------------------------------------------------------------------------------*/
/** Legacy MCP GET event stream + POST endpoint. Tools still go through the IDE authorization broker. */
import type { McpLaunch } from './native-mcp-servers.ts';
import type { UserMcpRpc } from './native-user-mcp-http.ts';

type LegacyLaunch = Extract<McpLaunch, { type: 'sse' }>;
interface Reply { resolve(value: unknown): void; reject(error: Error): void }

function allowedUrl(text: string): URL {
	const url = new URL(text);
	if (text.length > 500 || url.username || url.password || url.hash
		|| (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
		throw Error('HARNESS_MCP_HTTP_URL');
	}
	return url;
}

function authorization(entry: LegacyLaunch): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(entry.headers ?? {})) {
		if (name.toLowerCase() !== 'authorization' || value.length > 8192 || /[\r\n]/.test(value)) {
			throw Error('HARNESS_MCP_HTTP_HEADERS');
		}
		headers.set(name, value);
	}
	return headers;
}

/** Legacy SSE does not grant sampling, elicitation, roots or tool execution to the server. */
export async function withLegacySseMcp<T>(
	entry: LegacyLaunch,
	options: { signal: AbortSignal; timeoutMs: number },
	work: (rpc: UserMcpRpc) => Promise<T>
): Promise<T> {
	const source = allowedUrl(entry.url);
	const headers = authorization(entry);
	const lifetime = new AbortController();
	const signal = AbortSignal.any([options.signal, lifetime.signal]);
	const openHeaders = new Headers(headers);
	openHeaders.set('Accept', 'text/event-stream');
	const opening = await fetch(source, { method: 'GET', headers: openHeaders, redirect: 'error', credentials: 'omit', signal });
	if (!opening.ok || opening.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream' || !opening.body) {
		await opening.body?.cancel().catch(() => undefined);
		throw Error('HARNESS_MCP_PROTOCOL');
	}
	const reader = opening.body.getReader();
	let endpoint: URL | undefined;
	let endpointResolve: (url: URL) => void = () => undefined;
	let endpointReject: (error: Error) => void = () => undefined;
	const endpointPromise = new Promise<URL>((resolve, reject) => { endpointResolve = resolve; endpointReject = reject; });
	const pending = new Map<number, Reply>();
	let nextId = 0;
	let serverRequests = 0;
	let settled = false;
	let failure: Error | undefined;
	const fail = (error: Error): void => {
		if (settled) { return; }
		settled = true;
		failure = error;
		endpointReject(error);
		for (const reply of pending.values()) { reply.reject(error); }
		pending.clear();
	};
	const post = async (body: object, timeoutMs: number): Promise<void> => {
		if (!endpoint) { throw Error('HARNESS_MCP_PROTOCOL'); }
		const postHeaders = new Headers(headers);
		postHeaders.set('Content-Type', 'application/json');
		const response = await fetch(endpoint, {
			method: 'POST', headers: postHeaders, redirect: 'error', credentials: 'omit',
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
			body: JSON.stringify(body)
		});
		try { if (!response.ok && response.status !== 202) { throw Error('HARNESS_MCP_HTTP_STATUS'); } }
		finally { await response.body?.cancel().catch(() => undefined); }
	};
	const onEvent = (event: string, data: string): void => {
		if (!data) { return; }
		if (event === 'endpoint') {
			if (endpoint) { throw Error('HARNESS_MCP_PROTOCOL'); }
			const target = allowedUrl(new URL(data, source).href);
			// An endpoint event is untrusted: never send the bearer token to another origin.
			if (target.origin !== source.origin || !target.pathname.startsWith('/')) { throw Error('HARNESS_MCP_HTTP_URL'); }
			endpoint = target;
			endpointResolve(target);
			return;
		}
		if (event !== 'message') { return; }
		let value: { jsonrpc?: string; id?: unknown; method?: unknown; result?: unknown; error?: unknown };
		try { value = JSON.parse(data) as typeof value; }
		catch { throw Error('HARNESS_MCP_PROTOCOL'); }
		if (!value || value.jsonrpc !== '2.0') { throw Error('HARNESS_MCP_PROTOCOL'); }
		if (typeof value.method === 'string') {
			// Notifications are inert. A server request receives an explicit denial, never a tool call.
			if (value.id !== undefined && value.id !== null) {
				if ((typeof value.id !== 'number' && typeof value.id !== 'string') || ++serverRequests > 8) {
					throw Error('HARNESS_MCP_SERVER_REQUEST_DENIED');
				}
				void post({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Method not found' } }, options.timeoutMs)
					.catch(() => fail(Error('HARNESS_MCP_SERVER_REQUEST_DENIED')));
			}
			return;
		}
		if (typeof value.id !== 'number' || !pending.has(value.id)) { throw Error('HARNESS_MCP_PROTOCOL'); }
		const reply = pending.get(value.id)!;
		pending.delete(value.id);
		if (value.error || !Object.hasOwn(value, 'result')) { reply.reject(Error('HARNESS_MCP_PROTOCOL')); }
		else { reply.resolve(value.result); }
	};
	const pump = async (): Promise<void> => {
		const decoder = new TextDecoder('utf-8', { fatal: true });
		let buffer = '';
		let received = 0;
		try {
			while (!signal.aborted) {
				const { done, value } = await reader.read();
				if (done) { throw Error('HARNESS_MCP_CONNECTION_LOST'); }
				received += value.length;
				if (received > 2 * 1024 * 1024) { throw Error('HARNESS_MCP_RESULT_TOO_LARGE'); }
				buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
				if (buffer.length > 256 * 1024) { throw Error('HARNESS_MCP_RESULT_TOO_LARGE'); }
				let end: number;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const lines = frame.split('\n');
					const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
					const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
					onEvent(event, data);
				}
			}
		} catch (error) {
			if (!signal.aborted) { fail(error instanceof Error ? error : Error('HARNESS_MCP_PROTOCOL')); }
		}
	};
	const reading = pump();
	const abort = (): void => fail(Error('HARNESS_MCP_CANCELLED'));
	signal.addEventListener('abort', abort, { once: true });
	const request = async <R>(method: string, params: object, timeoutMs = options.timeoutMs): Promise<R> => {
		if (failure) { throw failure; }
		if (signal.aborted || !endpoint || pending.size) { throw Error('HARNESS_MCP_PROTOCOL'); }
		const id = ++nextId;
		const controller = new AbortController();
		const deadline = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(timeoutMs)]);
		let replyResolve: (value: unknown) => void = () => undefined;
		let replyReject: (error: Error) => void = () => undefined;
		const replyPromise = new Promise<unknown>((resolve, reject) => { replyResolve = resolve; replyReject = reject; });
		pending.set(id, { resolve: replyResolve, reject: replyReject });
		const onAbort = (): void => {
			pending.delete(id);
			replyReject(Error(signal.aborted ? 'HARNESS_MCP_CANCELLED' : 'HARNESS_MCP_TIMEOUT'));
		};
		deadline.addEventListener('abort', onAbort, { once: true });
		try {
			await post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
			return await replyPromise as R;
		} finally {
			pending.delete(id);
			deadline.removeEventListener('abort', onAbort);
			controller.abort();
			// A POST that failed before its SSE response must not leave a rejected promise unobserved.
			void replyPromise.catch(() => undefined);
		}
	};
	try {
		await Promise.race([
			endpointPromise,
			new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(() => reject(Error('HARNESS_MCP_TIMEOUT')), options.timeoutMs);
				timer.unref();
				endpointPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
			})
		]);
		const initialized = await request<{ protocolVersion?: string; capabilities?: { tools?: object } }>('initialize', {
			protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'armotusitio-ide', version: '0.6.0' }
		});
		if (!initialized || !['2024-11-05', '2025-03-26', '2025-06-18'].includes(initialized.protocolVersion ?? '') || !initialized.capabilities?.tools) {
			throw Error('HARNESS_MCP_PROTOCOL');
		}
		await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, options.timeoutMs);
		return await work({ request });
	} finally {
		lifetime.abort();
		signal.removeEventListener('abort', abort);
		fail(Error('HARNESS_MCP_CANCELLED'));
		await reader.cancel().catch(() => undefined);
		await reading;
		reader.releaseLock();
	}
}
