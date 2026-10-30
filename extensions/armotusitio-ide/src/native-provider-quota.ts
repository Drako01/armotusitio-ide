/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Optional, durable per-provider call counts and hard budgets of PROVIDER-REPORTED
 * tokens/cost. Not billing: reported cost is the provider's own estimate.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeProvider } from './native-providers.ts';
import type { SharedExecutionFence } from './native-shared-fence.ts';
import type { ProviderUsage } from './native-provider-output.ts';

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
/** Bounded, non-linked JSON ledger read; a missing file is an empty ledger. */
async function readJsonLedger<T>(file: string, valid: (value: unknown) => value is T, empty: T, maxBytes = MAX_BYTES): Promise<T> {
	let stat;
	try { stat = await fs.lstat(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return empty; }
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
		throw Error('HARNESS_PROVIDER_QUOTA_UNSAFE');
	}
	const bytes = await fs.readFile(file);
	if (bytes.length > maxBytes) { throw Error('HARNESS_PROVIDER_QUOTA_UNSAFE'); }
	let parsed: unknown;
	try { parsed = JSON.parse(bytes.toString('utf8')); }
	catch { throw Error('HARNESS_PROVIDER_QUOTA_INVALID'); }
	if (!valid(parsed)) { throw Error('HARNESS_PROVIDER_QUOTA_INVALID'); }
	return parsed;
}
const readLedger = (file: string): Promise<Ledger> => readJsonLedger(file, validLedger, { schemaVersion: 1, entries: [] });

/** Canonical private directory; `create` makes it, otherwise a missing directory returns false. */
async function privateDirectory(directory: string, create: boolean): Promise<boolean> {
	if (create) { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); }
	let stat;
	try { stat = await fs.lstat(directory); }
	catch (error) {
		if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') { return false; }
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)) {
		throw Error('HARNESS_PROVIDER_QUOTA_STORAGE_UNSAFE');
	}
	return true;
}

/** fsync then rename under a still-current fence. */
async function replaceLedger(file: string, value: unknown, fence: SharedExecutionFence): Promise<void> {
	const temp = file + '.' + randomUUID() + '.tmp';
	const handle = await fs.open(temp, 'wx', 0o600);
	try {
		await handle.writeFile(JSON.stringify(value));
		await handle.sync();
	} finally { await handle.close(); }
	try {
		await fence.assertCurrent();
		await fs.rename(temp, file);
		await fence.assertCurrent();
	} finally { await fs.rm(temp, { force: true }); }
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
		await privateDirectory(directory, true);
		const file = path.join(directory, FILE);
		const ledger = await readLedger(file);
		// Refuse a clock rollback rather than resetting credits early.
		if (ledger.entries.some(e => e.at > now)) { throw Error('HARNESS_PROVIDER_QUOTA_CLOCK_ROLLBACK'); }
		const current = ledger.entries.filter(entry => now - entry.at < WINDOW_MS);
		const used = current.filter(entry => entry.provider === provider).length;
		if (used >= maxCallsPer24h) { throw Error('HARNESS_PROVIDER_QUOTA_EXCEEDED'); }
		if (current.length >= MAX_ENTRIES) { throw Error('HARNESS_PROVIDER_QUOTA_FULL'); }
		const next: Ledger = {
			schemaVersion: 1, entries: [
				...current, { provider, at: now, epoch: fence.epoch }
			]
		};
		await replaceLedger(file, next, fence);
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
	const exists = await privateDirectory(directory, false);
	const ledger: Ledger = exists ? await readLedger(path.join(directory, FILE)) : { schemaVersion: 1, entries: [] };
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

const SPEND_FILE = 'provider-spend.json';
const SPEND_MAX_BYTES = 256 * 1024;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
type Spend = { provider: NativeProvider; at: number; epoch: number; tokens: number | null; costMicroUsd: number | null; rateLimited: boolean };
type SpendLedger = { schemaVersion: 1; entries: Spend[] };
const nullableAmount = (value: unknown): boolean => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
function validSpend(value: unknown): value is SpendLedger {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
	const record = value as SpendLedger;
	return Object.keys(record).sort().join(',') === 'entries,schemaVersion' &&
		record.schemaVersion === 1 && Array.isArray(record.entries) && record.entries.length <= MAX_ENTRIES &&
		record.entries.every(e => e && typeof e === 'object' && !Array.isArray(e) &&
			Object.keys(e).sort().join(',') === 'at,costMicroUsd,epoch,provider,rateLimited,tokens' &&
			(e.provider === 'codex' || e.provider === 'claude') &&
			Number.isSafeInteger(e.at) && e.at >= 0 && Number.isSafeInteger(e.epoch) && e.epoch > 0 &&
			nullableAmount(e.tokens) && nullableAmount(e.costMicroUsd) && typeof e.rateLimited === 'boolean');
}
const readSpend = (file: string): Promise<SpendLedger> =>
	readJsonLedger(file, validSpend, { schemaVersion: 1, entries: [] }, SPEND_MAX_BYTES);

/**
 * Hard 24h budget per provider and project. 0 disables a limit. Usage is only what
 * the provider reported; an invocation without reported usage is "unmetered" and,
 * while a limit is enabled, blocks further calls instead of being assumed free.
 */
export interface ProviderBudgetPolicy {
	maxTokensPer24h: number;
	maxCostUsdPer24h: number;
}
export interface ProviderBudgetUsage {
	tokens: number;
	costUsd: number;
	unmeteredCalls: number;
	rateLimitedUntil: number | null;
}
export function validateProviderBudgetPolicy(policy: ProviderBudgetPolicy): ProviderBudgetPolicy {
	if (!policy || !Number.isSafeInteger(policy.maxTokensPer24h) || policy.maxTokensPer24h < 0 ||
		policy.maxTokensPer24h > 1_000_000_000 || typeof policy.maxCostUsdPer24h !== 'number' ||
		!Number.isFinite(policy.maxCostUsdPer24h) || policy.maxCostUsdPer24h < 0 || policy.maxCostUsdPer24h > 100_000) {
		throw Error('HARNESS_PROVIDER_BUDGET_POLICY_INVALID');
	}
	return policy;
}
/** True when any hard budget limit is configured. */
export function budgetEnabled(policy: ProviderBudgetPolicy): boolean {
	return policy.maxTokensPer24h > 0 || policy.maxCostUsdPer24h > 0;
}

function summarizeSpend(ledger: SpendLedger, provider: NativeProvider, policy: ProviderBudgetPolicy, now: number): ProviderBudgetUsage {
	if (ledger.entries.some(entry => entry.at > now)) { throw Error('HARNESS_PROVIDER_QUOTA_CLOCK_ROLLBACK'); }
	const active = ledger.entries.filter(entry => entry.provider === provider && now - entry.at < WINDOW_MS);
	const throttled = active.filter(entry => entry.rateLimited).map(entry => entry.at + RATE_LIMIT_COOLDOWN_MS);
	const cooldown = throttled.length ? Math.max(...throttled) : 0;
	return {
		tokens: active.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0),
		costUsd: active.reduce((sum, entry) => sum + (entry.costMicroUsd ?? 0), 0) / 1_000_000,
		unmeteredCalls: active.filter(entry => (policy.maxTokensPer24h > 0 && entry.tokens === null) ||
			(policy.maxCostUsdPer24h > 0 && entry.costMicroUsd === null)).length,
		rateLimitedUntil: cooldown > now ? cooldown : null
	};
}

/**
 * Refuse an invocation BEFORE launching a CLI when the provider is cooling down
 * after throttling or the reported spend reached a limit. Concurrent in-flight
 * calls (at most two per window) can overshoot by their own usage only.
 */
export async function assertProviderBudget(
	directory: string, provider: NativeProvider, policy: ProviderBudgetPolicy, fence: SharedExecutionFence, now = Date.now()
): Promise<ProviderBudgetUsage | null> {
	validateProviderBudgetPolicy(policy);
	if (!budgetEnabled(policy)) { return null; }
	return exclusiveLocal(directory, async () => {
		await fence.assertCurrent();
		const usage = (await privateDirectory(directory, false))
			? summarizeSpend(await readSpend(path.join(directory, SPEND_FILE)), provider, policy, now)
			: { tokens: 0, costUsd: 0, unmeteredCalls: 0, rateLimitedUntil: null };
		if (usage.rateLimitedUntil !== null) { throw Error('HARNESS_PROVIDER_RATE_LIMITED'); }
		if (usage.unmeteredCalls) { throw Error('HARNESS_PROVIDER_BUDGET_UNMETERED'); }
		if (policy.maxTokensPer24h > 0 && usage.tokens >= policy.maxTokensPer24h) { throw Error('HARNESS_PROVIDER_TOKEN_BUDGET_EXCEEDED'); }
		if (policy.maxCostUsdPer24h > 0 && usage.costUsd >= policy.maxCostUsdPer24h) { throw Error('HARNESS_PROVIDER_COST_BUDGET_EXCEEDED'); }
		return usage;
	});
}

/** Persist what the provider reported after an invocation; never estimates missing usage. */
export async function recordProviderSpend(
	directory: string, provider: NativeProvider, fence: SharedExecutionFence,
	outcome: { usage?: ProviderUsage; rateLimited?: true }, now = Date.now()
): Promise<void> {
	if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_QUOTA_PROVIDER_INVALID'); }
	if (!Number.isSafeInteger(now) || now < 0) { throw Error('HARNESS_PROVIDER_QUOTA_POLICY_INVALID'); }
	const usage = outcome.usage;
	const tokens = usage && Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens)
		? usage.inputTokens + usage.outputTokens : null;
	const cost = usage?.estimatedCostUsd;
	const costMicroUsd = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? Math.ceil(cost * 1_000_000) : null;
	await exclusiveLocal(directory, async () => {
		await fence.assertCurrent();
		await privateDirectory(directory, true);
		const file = path.join(directory, SPEND_FILE);
		const ledger = await readSpend(file);
		if (ledger.entries.some(entry => entry.at > now)) { throw Error('HARNESS_PROVIDER_QUOTA_CLOCK_ROLLBACK'); }
		const current = ledger.entries.filter(entry => now - entry.at < WINDOW_MS);
		if (current.length >= MAX_ENTRIES) { throw Error('HARNESS_PROVIDER_QUOTA_FULL'); }
		await replaceLedger(file, {
			schemaVersion: 1, entries: [
				...current, { provider, at: now, epoch: fence.epoch, tokens, costMicroUsd, rateLimited: outcome.rateLimited === true }
			]
		}, fence);
	});
}

/** Metadata-only budget view for the IDE. */
export async function readProviderBudget(
	directory: string, policy: ProviderBudgetPolicy, now = Date.now()
): Promise<{ enabled: boolean; policy: ProviderBudgetPolicy; windowHours: 24; providers: Record<NativeProvider, ProviderBudgetUsage> }> {
	validateProviderBudgetPolicy(policy);
	const ledger: SpendLedger = (await privateDirectory(directory, false))
		? await readSpend(path.join(directory, SPEND_FILE)) : { schemaVersion: 1, entries: [] };
	return {
		enabled: budgetEnabled(policy), policy, windowHours: 24,
		providers: { codex: summarizeSpend(ledger, 'codex', policy, now), claude: summarizeSpend(ledger, 'claude', policy, now) }
	};
}
