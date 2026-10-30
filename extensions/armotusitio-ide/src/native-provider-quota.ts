/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Optional, durable per-provider call count policy. This is NOT a monetary budget. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeProvider } from './native-providers.ts';
import type { SharedExecutionFence } from './native-shared-fence.ts';

const FILE = 'provider-invocations.json';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 128 * 1024;
const MAX_ENTRIES = 2000;
type Entry = { provider: NativeProvider; at: number; epoch: number };
type Ledger = { schemaVersion: 1; entries: Entry[] };
const serial = new Map<string, Promise<void>>();

async function exclusiveLocal<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const preceding = serial.get(key) || Promise.resolve();
	let signal!: () => void;
	const current = new Promise<void>(resolve => { signal = resolve; });
	const next = preceding.then(() => current, () => current);
	serial.set(key, next);
	await preceding;
	try { return await operation(); }
	finally {
		signal();
		if (serial.get(key) === next) { serial.delete(key); }
	}
}

function validLedger(value: unknown): value is Ledger {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
	const record = value as Ledger;
	return Object.keys(record).sort().join(',') === 'entries,schemaVersion' &&
		record.schemaVersion === 1 && Array.isArray(record.entries) &&
		record.entries.length <= MAX_ENTRIES && record.entries.every(e =>
			e && typeof e === 'object' && !Array.isArray(e) &&
			Object.keys(e).sort().join(',') === 'at,epoch,provider' &&
			(e.provider === 'codex' || e.provider === 'claude') &&
			Number.isSafeInteger(e.at) && e.at >= 0 &&
			Number.isSafeInteger(e.epoch) && e.epoch > 0);
}
async function readLedger(file: string): Promise<Ledger> {
	let stat;
	try { stat = await fs.lstat(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { schemaVersion: 1, entries: [] }; }
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
		throw Error('HARNESS_PROVIDER_QUOTA_UNSAFE');
	}
	const bytes = await fs.readFile(file);
	if (bytes.length > MAX_BYTES) { throw Error('HARNESS_PROVIDER_QUOTA_UNSAFE'); }
	let parsed: unknown;
	try { parsed = JSON.parse(bytes.toString('utf8')); }
	catch { throw Error('HARNESS_PROVIDER_QUOTA_INVALID'); }
	if (!validLedger(parsed)) { throw Error('HARNESS_PROVIDER_QUOTA_INVALID'); }
	return parsed;
}

/**
 * Persist a credit BEFORE launching a CLI. A crash does not refund it.
 * A shared fence serializes different IDE processes and this queue serializes
 * concurrent read-only waves belonging to the same workflow.
 */
export async function reserveProviderInvocation(
	directory: string, provider: NativeProvider, fence: SharedExecutionFence,
	maxCallsPer24h: number, now = Date.now()
): Promise<{ used: number; remaining: number }> {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_QUOTA_PROVIDER_INVALID'); }
	if (!Number.isSafeInteger(maxCallsPer24h) || maxCallsPer24h < 1 || maxCallsPer24h > 1000 ||
		!Number.isSafeInteger(now) || now < 0) { throw Error('HARNESS_PROVIDER_QUOTA_POLICY_INVALID'); }
	return exclusiveLocal(directory, async () => {
		await fence.assertCurrent();
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const stat = await fs.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() ||
			await fs.realpath(directory) !== path.resolve(directory)) {
			throw Error('HARNESS_PROVIDER_QUOTA_STORAGE_UNSAFE');
		}
		const file = path.join(directory, FILE);
		const ledger = await readLedger(file);
		// Refuse a clock rollback rather than resetting credits early.
		if (ledger.entries.some(e => e.at > now)) { throw Error('HARNESS_PROVIDER_QUOTA_CLOCK_ROLLBACK'); }
		const current = ledger.entries.filter(entry => now - entry.at < WINDOW_MS);
		const used = current.filter(entry => entry.provider === provider).length;
		if (used >= maxCallsPer24h) { throw Error('HARNESS_PROVIDER_QUOTA_EXCEEDED'); }
		if (current.length >= MAX_ENTRIES) { throw Error('HARNESS_PROVIDER_QUOTA_FULL'); }
		const next: Ledger = { schemaVersion: 1, entries: [
			...current, { provider, at: now, epoch: fence.epoch }
		] };
		const temp = file + '.' + randomUUID() + '.tmp';
		const handle = await fs.open(temp, 'wx', 0o600);
		try {
			await handle.writeFile(JSON.stringify(next));
			await handle.sync();
		} finally { await handle.close(); }
		try {
			await fence.assertCurrent();
			await fs.rename(temp, file);
			await fence.assertCurrent();
		} finally { await fs.rm(temp, { force: true }); }
		return { used: used + 1, remaining: maxCallsPer24h - used - 1 };
	});
}

export interface ProviderInvocationQuotaStatus {
	enabled: boolean;
	maxCallsPer24h: number | null;
	windowHours: 24;
	providers: {
		codex: { used: number; remaining: number | null };
		claude: { used: number; remaining: number | null };
	};
}

/** Metadata-only view; never reads model output, prompts, token contents or credentials. */
export async function readProviderInvocationQuota(
	directory: string, maxCallsPer24h: number, now = Date.now()
): Promise<ProviderInvocationQuotaStatus> {
	if (!Number.isSafeInteger(maxCallsPer24h) || maxCallsPer24h < 0 || maxCallsPer24h > 1000 ||
		!Number.isSafeInteger(now) || now < 0) { throw Error('HARNESS_PROVIDER_QUOTA_POLICY_INVALID'); }
	let info;
	try { info = await fs.lstat(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
	}
	if (info && (!info.isDirectory() || info.isSymbolicLink() ||
		await fs.realpath(directory) !== path.resolve(directory))) {
		throw Error('HARNESS_PROVIDER_QUOTA_STORAGE_UNSAFE');
	}
	const ledger = info ? await readLedger(path.join(directory, FILE)) : { schemaVersion: 1 as const, entries: [] as Entry[] };
	if (ledger.entries.some(entry => entry.at > now)) { throw Error('HARNESS_PROVIDER_QUOTA_CLOCK_ROLLBACK'); }
	const active = ledger.entries.filter(entry => now - entry.at < WINDOW_MS);
	const count = (provider: NativeProvider): { used: number; remaining: number | null } => {
		const used = active.filter(entry => entry.provider === provider).length;
		return { used, remaining: maxCallsPer24h === 0 ? null : Math.max(0, maxCallsPer24h - used) };
	};
	return {
		enabled: maxCallsPer24h > 0, maxCallsPer24h: maxCallsPer24h || null, windowHours: 24,
		providers: { codex: count('codex'), claude: count('claude') }
	};
}
