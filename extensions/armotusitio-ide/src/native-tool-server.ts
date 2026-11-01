/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Local channel between the `ats-runner` process and the extension (blocks S and V): a named pipe (Windows) or a
 * socket in the IDE's storage (POSIX), one random token per run, JSON lines. It carries editor queries and development
 * secrets, which therefore never touch a file. The token travels only in the run's runner configuration.
 */
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface ChannelRequest { token: string; method: string; params: unknown }
export type ChannelHandler = (method: string, params: unknown) => Promise<unknown>;
export interface ToolChannel { address: string; token: string; close(): Promise<void> }

const MAX_REQUEST_BYTES = 256 * 1024;

function sameToken(left: string, right: string): boolean {
	const a = Buffer.from(left), b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Serve one run's channel; every request with a different token is refused (EC-124). */
export async function openToolChannel(storage: string, handler: ChannelHandler): Promise<ToolChannel> {
	const token = randomBytes(32).toString('hex');
	const name = 'ats-' + randomBytes(12).toString('hex');
	const address = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(storage, name + '.sock');
	if (process.platform !== 'win32') { await fs.mkdir(storage, { recursive: true, mode: 0o700 }); }
	const server = net.createServer(socket => {
		let buffer = '';
		socket.on('data', async data => {
			buffer += data.toString('utf8');
			if (buffer.length > MAX_REQUEST_BYTES) { socket.destroy(); return; }
			let newline = buffer.indexOf('\n');
			while (newline >= 0) {
				const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
				let request: ChannelRequest | undefined;
				try { request = JSON.parse(line); } catch { /* answered below */ }
				if (!request || typeof request.token !== 'string' || !sameToken(request.token, token) || typeof request.method !== 'string') {
					socket.write(JSON.stringify({ error: 'HARNESS_UNTRUSTED_OR_CANCELLED' }) + '\n');
				} else {
					try { socket.write(JSON.stringify({ result: await handler(request.method, request.params) }) + '\n'); }
					catch (error) { socket.write(JSON.stringify({ error: /^HARNESS_[A-Z_]+$/.test((error as Error).message) ? (error as Error).message : 'HARNESS_OPERATION_FAILED' }) + '\n'); }
				}
				newline = buffer.indexOf('\n');
			}
		});
		socket.on('error', () => undefined);
	});
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, () => resolve()); });
	if (process.platform !== 'win32') { await fs.chmod(address, 0o600).catch(() => undefined); }
	return {
		address, token,
		close: () => new Promise(resolve => server.close(() => { if (process.platform !== 'win32') { void fs.rm(address, { force: true }); } resolve(); }))
	};
}

/** Client used by `ats-runner`: one request per connection, bounded by a timeout. */
export function callToolChannel(address: string, token: string, method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(address);
		let buffer = '';
		const timer = setTimeout(() => { socket.destroy(); reject(Error('HARNESS_TIMEOUT')); }, timeoutMs);
		socket.once('error', () => { clearTimeout(timer); reject(Error('HARNESS_UNSUPPORTED')); });
		socket.once('connect', () => socket.write(JSON.stringify({ token, method, params }) + '\n'));
		socket.on('data', data => {
			buffer += data.toString('utf8');
			const newline = buffer.indexOf('\n');
			if (newline < 0) { return; }
			clearTimeout(timer); socket.end();
			const reply = JSON.parse(buffer.slice(0, newline)) as { result?: unknown; error?: string };
			if (reply.error) { reject(Error(reply.error)); } else { resolve(reply.result); }
		});
	});
}
