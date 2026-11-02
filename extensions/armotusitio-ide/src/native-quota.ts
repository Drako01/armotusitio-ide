/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Session/weekly usage windows the agent CLIs report about the user's own subscription. Pure and tolerant parsing:
 * unknown fields are ignored, out-of-range numbers are dropped, and nothing is ever estimated. Account data (plan, email,
 * credits, balances) is deliberately never read.
 *
 * Verified formats:
 * - Claude Code 2.1.x `--output-format stream-json` emits `{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":
 *   {"five_hour":{"utilization":0.72,"resetsAt":<epoch s>},"seven_day":{...}}}}`; utilization is a 0..1 fraction.
 * - Codex writes `token_count` events with `rate_limits.{primary,secondary}.{used_percent,window_minutes,resets_at}` to its
 *   rollout files; `codex exec --json` (0.166) does NOT print them, so the latest rollout is read instead.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { asObject as object } from './native-json.ts';
import type { NativeProvider } from './native-providers.ts';

export interface QuotaWindow {
	/** `session` (shortest window), `weekly`, or a sanitized provider key for any other window. */
	id: string;
	/** Short neutral label ("5h", "7d"); the UI translates `session` and `weekly` by id. */
	label: string;
	/** 0..100. */
	usedPercent: number;
	/** Epoch seconds; absent when the provider gave none or an implausible one. */
	resetsAt?: number;
}
export interface ProviderQuota {
	provider: NativeProvider;
	windows: QuotaWindow[];
	/** Epoch milliseconds of the observation. */
	asOf: number;
	source: 'stream' | 'rollout';
}

const TAIL_BYTES = 64 * 1024;
const MAX_ROLLOUT_FILES = 5;
const MAX_ROLLOUT_DAYS = 4;
const MIN_EPOCH_SECONDS = 1_500_000_000;
const MAX_RESET_AHEAD_SECONDS = 400 * 24 * 3600;
const WINDOW_ID = /^[a-z0-9_]{1,32}$/;

function percent(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}
function reset(value: unknown, now: number): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= MIN_EPOCH_SECONDS && value <= now / 1000 + MAX_RESET_AHEAD_SECONDS ? Math.floor(value) : undefined;
}
function minutesLabel(minutes: number): string {
	return minutes % 1440 === 0 ? minutes / 1440 + 'd' : minutes % 60 === 0 ? minutes / 60 + 'h' : minutes + 'm';
}
const byLength = (a: { minutes: number }, b: { minutes: number }): number => a.minutes - b.minutes;

/** The shortest window is the session; one of at least a week is the weekly cap; anything else keeps a neutral id. */
function codexWindow(raw: unknown, now: number): (QuotaWindow & { minutes: number }) | undefined {
	const data = object(raw);
	const used = percent(data?.used_percent);
	const minutes = data?.window_minutes;
	if (used === undefined || typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 60 * 24 * 366) { return undefined; }
	const resetsAt = reset(data?.resets_at, now);
	return { id: minutes <= 1440 ? 'session' : minutes >= 10080 ? 'weekly' : 'window_' + minutes, label: minutesLabel(minutes), usedPercent: used, minutes, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

/** Quota from a Codex `rate_limits` object (the `payload.rate_limits` of a rollout `token_count` event). */
export function parseCodexRateLimits(raw: unknown, asOf: number, source: ProviderQuota['source'], now = Date.now()): ProviderQuota | undefined {
	const limits = object(raw);
	if (!limits || (limits.limit_id !== undefined && limits.limit_id !== 'codex')) { return undefined; }
	const windows = [codexWindow(limits.primary, now), codexWindow(limits.secondary, now)]
		.filter((window): window is NonNullable<typeof window> => !!window).sort(byLength)
		.filter((window, index, all) => all.findIndex(other => other.id === window.id) === index)
		.map(({ minutes: _minutes, ...window }) => window);
	return windows.length ? { provider: 'codex', windows, asOf, source } : undefined;
}

const CLAUDE_WINDOWS: Record<string, { id: string; label: string; minutes: number }> = {
	five_hour: { id: 'session', label: '5h', minutes: 300 },
	seven_day: { id: 'weekly', label: '7d', minutes: 10080 }
};
function claudeWindow(key: string, raw: unknown, now: number): (QuotaWindow & { minutes: number }) | undefined {
	const data = object(raw);
	const fraction = data?.utilization;
	if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) { return undefined; }
	const known = CLAUDE_WINDOWS[key];
	if (!known && !WINDOW_ID.test(key)) { return undefined; }
	const resetsAt = reset(data?.resetsAt, now);
	return {
		id: known?.id ?? key, label: known?.label ?? key, minutes: known?.minutes ?? Number.MAX_SAFE_INTEGER,
		usedPercent: Math.round(fraction * 1000) / 10, ...(resetsAt === undefined ? {} : { resetsAt })
	};
}

/** Quota from a Claude Code `rate_limit_event` (0..1 utilization fractions; the percent form is not accepted). */
export function parseClaudeRateLimitEvent(event: Record<string, unknown>, now = Date.now()): ProviderQuota | undefined {
	if (event.type !== 'rate_limit_event') { return undefined; }
	const info = object(event.rate_limit_info);
	const unified = object(info?.unifiedWindows);
	const entries: Array<[string, unknown]> = unified ? Object.entries(unified) : [];
	// Older shape: one window named by `rateLimitType`, with its numbers on the info object itself.
	if (!entries.length && typeof info?.rateLimitType === 'string') { entries.push([info.rateLimitType, info]); }
	const windows = entries.slice(0, 8).map(([key, raw]) => claudeWindow(key, raw, now)).filter((window): window is NonNullable<typeof window> => !!window)
		.sort(byLength).map(({ minutes: _minutes, ...window }) => window);
	return windows.length ? { provider: 'claude', windows, asOf: now, source: 'stream' } : undefined;
}

/** Quota carried by one provider stream event, if any. Codex's stream normally has none (see the module note). */
export function parseQuotaEvent(provider: NativeProvider, event: Record<string, unknown>, now = Date.now()): ProviderQuota | undefined {
	if (provider === 'claude') { return parseClaudeRateLimitEvent(event, now); }
	const payload = object(event.payload);
	return event.type === 'event_msg' && payload?.type === 'token_count' ? parseCodexRateLimits(payload.rate_limits, now, 'stream', now) : undefined;
}

/** The newer observation wins window by window, so a partial event never erases the other window. */
export function mergeQuota(previous: ProviderQuota | undefined, next: ProviderQuota | undefined): ProviderQuota | undefined {
	if (!previous || !next) { return next ?? previous; }
	if (previous.provider !== next.provider) { return next; }
	const [older, newer] = previous.asOf > next.asOf ? [next, previous] : [previous, next];
	const kept = older.windows.filter(window => !newer.windows.some(other => other.id === window.id));
	return { ...newer, windows: [...kept, ...newer.windows].sort((a, b) => (a.id === 'session' ? 0 : a.id === 'weekly' ? 1 : 2) - (b.id === 'session' ? 0 : b.id === 'weekly' ? 1 : 2)) };
}

/** Drops windows that already reset (their percentage is stale); undefined when none are left. */
export function liveQuota(quota: ProviderQuota | undefined, now = Date.now()): ProviderQuota | undefined {
	const windows = quota?.windows.filter(window => window.resetsAt === undefined || window.resetsAt * 1000 > now);
	return quota && windows?.length ? { ...quota, windows } : undefined;
}

async function newestNames(directory: string, accept: RegExp, limit: number): Promise<string[]> {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		return entries.filter(entry => accept.test(entry.name) && (entry.isFile() || entry.isDirectory()) && !entry.isSymbolicLink()).map(entry => entry.name).sort().reverse().slice(0, limit);
	} catch { return []; }
}

/** Last `token_count` with rate limits in the bounded tail of one rollout; conversation lines are parsed only to be skipped. */
async function quotaFromRolloutTail(file: string, now: number): Promise<ProviderQuota | undefined> {
	const handle = await fs.open(file, 'r');
	try {
		const { size, mtimeMs } = await handle.stat();
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		const lines = buffer.toString('utf8').split('\n');
		// A tail that starts mid-file begins with a partial line.
		if (size > length) { lines.shift(); }
		for (let index = lines.length - 1; index >= 0; index--) {
			if (!lines[index].includes('"token_count"') || !lines[index].includes('rate_limits')) { continue; }
			try {
				const event = object(JSON.parse(lines[index]));
				const payload = object(event?.payload);
				if (payload?.type !== 'token_count') { continue; }
				const stamp = typeof event?.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
				const quota = parseCodexRateLimits(payload.rate_limits, Number.isFinite(stamp) && stamp <= now ? stamp : mtimeMs, 'rollout', now);
				if (quota) { return quota; }
			} catch { /* A damaged line is skipped, never fatal. */ }
		}
		return undefined;
	} finally { await handle.close(); }
}

/** Codex's most recent reported limits, from the tail of its newest rollout files. Silent (undefined) when nothing is readable. */
export async function readLatestCodexQuota(home: string = os.homedir(), now = Date.now()): Promise<ProviderQuota | undefined> {
	const root = path.join(home, '.codex', 'sessions');
	let inspected = 0;
	for (const year of await newestNames(root, /^\d{4}$/, 2)) {
		for (const month of await newestNames(path.join(root, year), /^\d{2}$/, 2)) {
			for (const day of await newestNames(path.join(root, year, month), /^\d{2}$/, MAX_ROLLOUT_DAYS)) {
				const directory = path.join(root, year, month, day);
				for (const name of await newestNames(directory, /^rollout-.*\.jsonl$/, MAX_ROLLOUT_FILES)) {
					if (++inspected > MAX_ROLLOUT_FILES) { return undefined; }
					try {
						const quota = await quotaFromRolloutTail(path.join(directory, name), now);
						if (quota) { return quota; }
					} catch { /* Unreadable rollout: try the next one. */ }
				}
			}
		}
	}
	return undefined;
}
