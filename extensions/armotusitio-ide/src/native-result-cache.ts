/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Verification result cache (block I): a gate is reused only when its exact inputs repeat. The key covers the whole
 * tracked tree plus uncommitted content, so any change invalidates it. Values hold status and duration, never output.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gitOutput } from './native-git.ts';
import { captureWorkingTree } from './native-run-diff.ts';
import { detectRedis, redisCommand, type RedisEndpoint } from './native-redis.ts';

/** A gate result valid for the exact inputs digested into its key. */
export interface CachedResult { status: 'passed' | 'failed'; durationMs: number; at: string }
export interface ResultCache {
	get(key: string): Promise<CachedResult | undefined>;
	set(key: string, value: CachedResult, ttlSeconds: number): Promise<void>;
	readonly backend: 'disk' | 'redis';
	/** "Cache: Redis 127.0.0.1:16379" or "Cache: disco", for the status bar tooltip. */
	describe(): string;
}

export const CACHE_TTL_SECONDS = 7 * 24 * 3600;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Digest of every tracked blob and every uncommitted file: conservative, any change invalidates. */
export async function treeDigest(root: string): Promise<string | undefined> {
	const tracked = await gitOutput(root, ['ls-files', '-s']).catch(() => undefined);
	if (!tracked) { return undefined; }
	const tree = await captureWorkingTree(root);
	return sha(tracked.toString('utf8') + '\n' + [...tree.entries].sort(([left], [right]) => left.localeCompare(right)).map(([file, hash]) => file + ':' + hash).join('\n'));
}

export function cacheKey(input: { command: string; args: readonly string[]; cwd: string; tree: string; toolchain?: string; env?: Record<string, string | undefined> }): string {
	return sha(JSON.stringify([input.command, input.args, input.cwd, input.tree, input.toolchain ?? '', Object.entries(input.env ?? {}).sort()]));
}

const valid = (value: unknown): value is CachedResult => !!value && typeof value === 'object' && ['passed', 'failed'].includes((value as CachedResult).status) &&
	Number.isFinite((value as CachedResult).durationMs) && typeof (value as CachedResult).at === 'string';

class DiskCache implements ResultCache {
	readonly backend = 'disk' as const;
	private readonly directory: string;
	constructor(directory: string) { this.directory = directory; }
	describe(): string { return 'disco'; }
	async get(key: string): Promise<CachedResult | undefined> {
		const raw = await fs.readFile(path.join(this.directory, key + '.json'), 'utf8').catch(() => undefined);
		if (!raw) { return undefined; }
		try {
			const entry = JSON.parse(raw) as { value: unknown; expires: number };
			return entry.expires > Date.now() && valid(entry.value) ? entry.value : undefined;
		} catch { return undefined; }
	}
	async set(key: string, value: CachedResult, ttlSeconds: number): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(this.directory, key + '.json'), JSON.stringify({ value, expires: Date.now() + ttlSeconds * 1000 }), { mode: 0o600 });
	}
}

/** Only `ats:<project>:gate:<key>` keys, always with a TTL; never FLUSH, KEYS or SCAN on other keys. */
class RedisCache implements ResultCache {
	readonly backend = 'redis' as const;
	private readonly endpoint: RedisEndpoint;
	private readonly prefix: string;
	private readonly fallback: ResultCache;
	constructor(endpoint: RedisEndpoint, prefix: string, fallback: ResultCache) { this.endpoint = endpoint; this.prefix = prefix; this.fallback = fallback; }
	describe(): string { return 'Redis ' + this.endpoint.host + ':' + this.endpoint.port; }
	async get(key: string): Promise<CachedResult | undefined> {
		// Redis is disposable: if it stops answering, the disk cache answers without error.
		const raw = await redisCommand(this.endpoint, ['GET', this.prefix + key]).catch(() => undefined);
		if (raw === undefined) { return this.fallback.get(key); }
		try { const value = raw ? JSON.parse(raw) : undefined; return valid(value) ? value : undefined; } catch { return undefined; }
	}
	async set(key: string, value: CachedResult, ttlSeconds: number): Promise<void> {
		const stored = await redisCommand(this.endpoint, ['SET', this.prefix + key, JSON.stringify(value), 'EX', String(ttlSeconds)]).then(() => true, () => false);
		if (!stored) { await this.fallback.set(key, value, ttlSeconds); }
	}
}

export async function createResultCache(options: { directory: string; projectRoot: string; setting?: string; environment?: string; candidates?: readonly string[] }): Promise<ResultCache> {
	const disk = new DiskCache(options.directory);
	const endpoint = await detectRedis({ setting: options.setting, environment: options.environment, candidates: options.candidates });
	return endpoint ? new RedisCache(endpoint, 'ats:' + sha(options.projectRoot).slice(0, 16) + ':gate:', disk) : disk;
}
