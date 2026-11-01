/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Minimal RESP client for the optional result cache (block I): loopback only, no authentication, short timeouts. */
import * as net from 'node:net';

export const CONNECT_TIMEOUT_MS = 200;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const DEFAULT_REDIS_CANDIDATES = ['127.0.0.1:6379', '127.0.0.1:16379', '127.0.0.1:56379'];

export interface RedisEndpoint { host: string; port: number }

/** `redis://host:port` or `host:port`, only on loopback; credentials in the URL disqualify it (never sent). */
export function parseRedisEndpoint(value: string | undefined): RedisEndpoint | undefined {
	if (!value) { return undefined; }
	const match = /^(?:redis:\/\/)?(?<auth>[^@/]*@)?\[?(?<host>[\w.:]+?)\]?:(?<port>\d{1,5})\/?$/.exec(value.trim());
	if (!match?.groups || match.groups.auth || !LOOPBACK.has(match.groups.host)) { return undefined; }
	return { host: match.groups.host === 'localhost' ? '127.0.0.1' : match.groups.host, port: Number(match.groups.port) };
}

function encode(args: readonly string[]): string { return '*' + args.length + '\r\n' + args.map(arg => '$' + Buffer.byteLength(arg) + '\r\n' + arg + '\r\n').join(''); }

/** One reply: `+OK`, `-ERR`, `:1`, `$n` bulk or `$-1` nil; undefined while incomplete. */
export function parseReply(buffer: string): { value: string | null; error?: string; rest: string } | undefined {
	const end = buffer.indexOf('\r\n');
	if (end < 0) { return undefined; }
	const kind = buffer[0], line = buffer.slice(1, end);
	if (kind === '+' || kind === ':') { return { value: line, rest: buffer.slice(end + 2) }; }
	if (kind === '-') { return { value: null, error: line, rest: buffer.slice(end + 2) }; }
	if (kind === '$') {
		const length = Number(line);
		if (length < 0) { return { value: null, rest: buffer.slice(end + 2) }; }
		if (Buffer.byteLength(buffer.slice(end + 2)) < length + 2) { return undefined; }
		const body = Buffer.from(buffer.slice(end + 2)).subarray(0, length).toString('utf8');
		return { value: body, rest: buffer.slice(end + 2 + body.length + 2) };
	}
	return { value: null, error: 'protocol', rest: '' };
}

/** Send one command on a fresh connection; rejects on timeout, connection errors or an error reply. */
export function redisCommand(endpoint: RedisEndpoint, args: readonly string[], timeoutMs = CONNECT_TIMEOUT_MS): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(endpoint);
		let buffer = '', done = false;
		const finish = (error?: Error, value?: string | null) => { if (done) { return; } done = true; socket.destroy(); if (error) { reject(error); } else { resolve(value ?? null); } };
		socket.setTimeout(timeoutMs, () => finish(Error('HARNESS_TIMEOUT')));
		socket.once('error', () => finish(Error('HARNESS_UNSUPPORTED')));
		socket.once('connect', () => socket.write(encode(args)));
		socket.on('data', data => {
			buffer += data.toString('utf8');
			const reply = parseReply(buffer);
			if (reply) { finish(reply.error ? Error('HARNESS_UNSUPPORTED') : undefined, reply.value); }
		});
	});
}

/**
 * The first Redis that answers `PING` with `PONG` without authentication, in a fixed order: the user setting,
 * `HARNESS_REDIS_URL`, then the loopback candidates. A Redis that asks for a password is skipped.
 */
export async function detectRedis(sources: { setting?: string; environment?: string; candidates?: readonly string[] }): Promise<RedisEndpoint | undefined> {
	const ordered = [sources.setting, sources.environment, ...(sources.candidates ?? DEFAULT_REDIS_CANDIDATES)].map(parseRedisEndpoint).filter((endpoint): endpoint is RedisEndpoint => !!endpoint);
	for (const endpoint of ordered) {
		if (await redisCommand(endpoint, ['PING']).then(reply => reply === 'PONG', () => false)) { return endpoint; }
	}
	return undefined;
}
