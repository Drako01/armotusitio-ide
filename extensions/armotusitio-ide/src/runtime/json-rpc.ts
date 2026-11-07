/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Bidirectional JSON-RPC over newline-delimited JSON (Codex `app-server` stdio framing, which omits the `jsonrpc` field).
 * Client requests are correlated by id with a timeout; server requests are answered by a handler that may take as long as
 * the user needs (approvals). Oversized and malformed lines are reported and skipped; they never break the stream.
 */
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import { RuntimeError } from './contracts.ts';

export const MAX_LINE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface JsonRpcHandlers {
	/** A request initiated by the server; the result (or a thrown error) is sent back with its id. */
	request(method: string, params: unknown): Promise<unknown>;
	notification(method: string, params: unknown): void;
	/** A line that is not JSON-RPC, or too long: reported, bounded, skipped. */
	malformed(reason: string, sample: string): void;
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export class JsonRpcConnection {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private buffer = '';
	private skipping = false;
	private closed?: Error;
	private readonly decoder = new StringDecoder('utf8');
	private readonly input: Writable;
	private readonly handlers: JsonRpcHandlers;

	constructor(input: Writable, output: Readable, handlers: JsonRpcHandlers) {
		this.input = input;
		this.handlers = handlers;
		output.on('data', (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
		output.on('end', () => this.close(new RuntimeError('RUNTIME_CONNECTION_LOST', true)));
		input.on('error', () => this.close(new RuntimeError('RUNTIME_CONNECTION_LOST', true)));
	}

	get open(): boolean { return !this.closed; }

	request<T>(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
		if (this.closed) { return Promise.reject(this.closed); }
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RuntimeError('RUNTIME_REQUEST_TIMEOUT', true));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
			this.write({ id, method, params });
		});
	}

	notify(method: string, params?: unknown): void {
		if (!this.closed) { this.write(params === undefined ? { method } : { method, params }); }
	}

	/** Reject every pending request; later calls fail with the same error. */
	close(error: Error = new RuntimeError('RUNTIME_CONNECTION_CLOSED')): void {
		if (this.closed) { return; }
		this.closed = error;
		for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
	}

	private write(message: object): void {
		try { this.input.write(JSON.stringify(message) + '\n'); }
		catch { this.close(new RuntimeError('RUNTIME_CONNECTION_LOST', true)); }
	}

	private receive(text: string): void {
		let start = 0;
		for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', start)) {
			const piece = text.slice(start, index);
			start = index + 1;
			if (this.skipping) { this.skipping = false; this.buffer = ''; continue; }
			const line = this.buffer + piece;
			this.buffer = '';
			if (line.trim()) { this.dispatch(line); }
		}
		const rest = text.slice(start);
		if (this.skipping) { return; }
		this.buffer += rest;
		if (this.buffer.length > MAX_LINE_BYTES) {
			this.handlers.malformed('line-too-long', this.buffer.slice(0, 200));
			this.buffer = '';
			this.skipping = true;
		}
	}

	private dispatch(line: string): void {
		let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
		try { message = JSON.parse(line); }
		catch { this.handlers.malformed('invalid-json', line.slice(0, 200)); return; }
		if (!message || typeof message !== 'object') { this.handlers.malformed('not-an-object', line.slice(0, 200)); return; }
		const hasId = typeof message.id === 'number' || typeof message.id === 'string';
		if (typeof message.method === 'string') {
			if (hasId) { void this.answer(message.id as number | string, message.method, message.params); }
			else {
				try { this.handlers.notification(message.method, message.params); }
				catch { /* An observer failure never stops the stream. */ }
			}
			return;
		}
		if (typeof message.id !== 'number' || !this.pending.has(message.id)) { this.handlers.malformed('unknown-response', line.slice(0, 200)); return; }
		const pending = this.pending.get(message.id)!;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) {
			pending.reject(new ProviderRequestError(typeof message.error.code === 'number' ? message.error.code : 0, typeof message.error.message === 'string' ? message.error.message.slice(0, 500) : ''));
		} else {
			pending.resolve(message.result);
		}
	}

	private async answer(id: number | string, method: string, params: unknown): Promise<void> {
		try {
			const result = await this.handlers.request(method, params);
			this.write({ id, result });
		} catch (error) {
			this.write({ id, error: { code: -32603, message: error instanceof RuntimeError ? error.code : 'request failed' } });
		}
	}
}

/** The provider answered a request with an error; its message is bounded and only used for diagnostics and matching. */
export class ProviderRequestError extends RuntimeError {
	readonly providerCode: number;
	readonly providerMessage: string;
	constructor(providerCode: number, providerMessage: string) {
		super('RUNTIME_PROVIDER_ERROR');
		this.providerCode = providerCode;
		this.providerMessage = providerMessage;
	}
}
