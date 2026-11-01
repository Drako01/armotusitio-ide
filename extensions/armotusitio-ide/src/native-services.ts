/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Service preflight (block G): which services a project needs and whether each one really answers its own protocol,
 * not just an open port (EC-56). No credentials are ever sent. Starting a service is the user's action (D3).
 */
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';

export type ServiceKind = 'postgres' | 'redis' | 'mysql' | 'mongo' | 'http';
export interface ServiceNeed { kind: ServiceKind; host: string; port: number; source: string; composeService?: string }
export interface ServiceProbe extends ServiceNeed { status: 'up' | 'down' | 'other-service' }

const DEFAULT_PORTS: Record<ServiceKind, number> = { postgres: 5432, redis: 6379, mysql: 3306, mongo: 27017, http: 80 };
const IMAGE_KIND: Array<[RegExp, ServiceKind]> = [[/postgres|postgis|timescale/i, 'postgres'], [/redis|valkey|keydb/i, 'redis'], [/mysql|mariadb/i, 'mysql'], [/mongo/i, 'mongo']];
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml', 'docker/compose.yml', 'deploy/docker-compose.yml'];
const PROBE_TIMEOUT_MS = 800;

/** Services of the project's compose file: image kind and the host port each one publishes. */
export function parseCompose(text: string, source: string): ServiceNeed[] {
	const needs: ServiceNeed[] = [];
	const services = /^services:\s*$([\s\S]*)/m.exec(text)?.[1] ?? '';
	for (const block of services.split(/^(?= {2}[\w.-]+:\s*$)/m)) {
		const name = /^ {2}([\w.-]+):\s*$/m.exec(block)?.[1];
		const image = /^\s+image:\s*["']?([^"'\s]+)/m.exec(block)?.[1] ?? '';
		const kind = IMAGE_KIND.find(([pattern]) => pattern.test(image) || pattern.test(name ?? ''))?.[1];
		if (!name || !kind) { continue; }
		// "15432:5432", "127.0.0.1:15432:5432" or the default port when nothing is published.
		const published = /^\s+-\s*["']?(?:[\d.]+:)?(\d{2,5}):\d{2,5}/m.exec(block.slice(block.indexOf('ports:') >= 0 ? block.indexOf('ports:') : block.length))?.[1];
		needs.push({ kind, host: '127.0.0.1', port: published ? Number(published) : DEFAULT_PORTS[kind], source, composeService: name });
	}
	return needs;
}

/** Connection URLs (`postgres://`, `redis://`) in env files and the IDE environment, without reading credentials. */
export function needsFromUrls(values: Record<string, string | undefined>, source: string): ServiceNeed[] {
	const needs: ServiceNeed[] = [];
	for (const [name, value] of Object.entries(values)) {
		if (!value || !/(_URL|_DSN|_HOST|_URI)$/i.test(name)) { continue; }
		const match = /^(postgres(?:ql)?|redis|rediss|mysql|mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^:/?]+)(?::(\d+))?/i.exec(value);
		if (!match) { continue; }
		const kind: ServiceKind = /^postgres/i.test(match[1]) ? 'postgres' : /^redis/i.test(match[1]) ? 'redis' : /^mysql/i.test(match[1]) ? 'mysql' : 'mongo';
		if (!['localhost', '127.0.0.1', '::1'].includes(match[2])) { continue; }
		needs.push({ kind, host: match[2] === 'localhost' ? '127.0.0.1' : match[2], port: match[3] ? Number(match[3]) : DEFAULT_PORTS[kind], source: source + ':' + name });
	}
	return needs;
}

/** Everything the project declares it needs, deduplicated by kind and port. */
export async function detectServiceNeeds(root: string, env: Record<string, string | undefined> = {}): Promise<ServiceNeed[]> {
	const needs: ServiceNeed[] = [];
	for (const file of COMPOSE_FILES) {
		const text = await fs.readFile(path.join(root, file), 'utf8').catch(() => undefined);
		if (text) { needs.push(...parseCompose(text, file)); }
	}
	for (const file of ['.env.example', '.env.test', '.env.sample']) {
		const text = await fs.readFile(path.join(root, file), 'utf8').catch(() => undefined);
		if (!text) { continue; }
		const values = Object.fromEntries(text.split('\n').map(line => /^\s*([A-Z0-9_]+)\s*=\s*["']?([^"'\s#]+)/.exec(line)).filter((match): match is RegExpExecArray => !!match).map(match => [match[1], match[2]]));
		needs.push(...needsFromUrls(values, file));
	}
	needs.push(...needsFromUrls(env, 'env'));
	const seen = new Set<string>();
	return needs.filter(need => { const key = need.kind + ':' + need.port; if (seen.has(key)) { return false; } seen.add(key); return true; });
}

/** Send `request` and read the first bytes of the answer; undefined when nothing answers in time. */
function exchange(host: string, port: number, request: Buffer): Promise<Buffer | undefined> {
	return new Promise(resolve => {
		const socket = net.connect({ host, port });
		let done = false;
		const finish = (value: Buffer | undefined) => { if (!done) { done = true; socket.destroy(); resolve(value); } };
		socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(undefined));
		socket.once('error', () => finish(undefined));
		socket.once('connect', () => { if (request.length) { socket.write(request); } });
		socket.once('data', data => finish(data));
		if (!request.length) { socket.once('connect', () => setTimeout(() => finish(Buffer.alloc(0)), 300)); }
	});
}

/** Protocol handshakes that prove which service answers, without authenticating. */
export async function probeService(need: ServiceNeed): Promise<ServiceProbe> {
	let answer: Buffer | undefined;
	let matches: (data: Buffer) => boolean;
	switch (need.kind) {
		case 'postgres': {
			// SSLRequest: a PostgreSQL server answers exactly one byte, 'S' or 'N'.
			const request = Buffer.alloc(8); request.writeInt32BE(8, 0); request.writeInt32BE(80877103, 4);
			answer = await exchange(need.host, need.port, request); matches = data => data.length === 1 && (data[0] === 0x53 || data[0] === 0x4e); break;
		}
		case 'redis': answer = await exchange(need.host, need.port, Buffer.from('*1\r\n$4\r\nPING\r\n')); matches = data => /^(\+PONG|-NOAUTH|-ERR)/.test(data.toString('latin1')); break;
		// MySQL greets first with protocol version 10; MongoDB has no unauthenticated greeting, so an open port is the best signal.
		case 'mysql': answer = await exchange(need.host, need.port, Buffer.alloc(0)); matches = data => data.length > 4 && data[4] === 10; break;
		case 'mongo': answer = await exchange(need.host, need.port, Buffer.alloc(0)); matches = () => true; break;
		case 'http': answer = await exchange(need.host, need.port, Buffer.from('GET / HTTP/1.0\r\nHost: ' + need.host + '\r\n\r\n')); matches = data => data.toString('latin1').startsWith('HTTP/'); break;
	}
	return { ...need, status: answer === undefined ? 'down' : matches(answer) ? 'up' : 'other-service' };
}

/** The user's one-click start for a missing service: only services declared in the project's own compose file (D3). */
export function composeUpCommand(need: ServiceNeed): { command: 'docker'; args: string[] } | undefined {
	return need.composeService ? { command: 'docker', args: ['compose', '-f', need.source, 'up', '-d', need.composeService] } : undefined;
}
