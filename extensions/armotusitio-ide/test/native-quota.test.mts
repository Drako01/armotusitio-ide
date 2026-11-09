/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { liveQuota, mergeQuota, parseClaudeRateLimitEvent, parseCodexRateLimits, parseQuotaEvent, readLatestCodexQuota, type ProviderQuota } from '../src/native-quota.ts';
import { ClaudeEventAccumulator, CodexEventAccumulator } from '../src/native-provider-output.ts';

const NOW = 1_793_660_000_000;
/** Real Codex 0.166 `rate_limits` payload (credits and spend fields are present in the file and must be ignored). */
const CODEX_LIMITS = {
	limit_id: 'codex', limit_name: null,
	primary: { used_percent: 5.0, window_minutes: 300, resets_at: 1793667992 },
	secondary: { used_percent: 53.0, window_minutes: 10080, resets_at: 1794101589 },
	credits: { has_credits: false, unlimited: false, balance: '0' }
};
const codexLine = (limits: unknown, timestamp = '2026-11-02T20:11:15.591Z') =>
	JSON.stringify({ timestamp, ordinal: 15, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } }, rate_limits: limits } });
/** Real Claude Code 2.1.316 `rate_limit_event` (account fields such as overage are present and must be ignored). */
const CLAUDE_EVENT = {
	type: 'rate_limit_event',
	rate_limit_info: {
		status: 'allowed_warning', resetsAt: 1794006000, rateLimitType: 'seven_day', utilization: 0.94, overageStatus: 'rejected', isUsingOverage: false,
		unifiedWindows: { five_hour: { utilization: 0.72, resetsAt: 1793668200, status: 'allowed' }, seven_day: { utilization: 0.94, resetsAt: 1794006000, status: 'allowed_warning' } }
	},
	session_id: '6a9ff9ca-0f8d-4b57-8a52-0a0f3bd8f9ab'
};

async function codexHome(files: Record<string, string>): Promise<{ home: string; cleanup: () => Promise<void> }> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-quota-'));
	for (const [relative, content] of Object.entries(files)) {
		const file = path.join(home, '.codex', 'sessions', relative);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	}
	return { home, cleanup: () => fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

describe('parseCodexRateLimits', () => {
	test('maps the 5 hour window to session and the weekly one to weekly, without account data', () => {
		assert.deepEqual(parseCodexRateLimits(CODEX_LIMITS, 1, 'rollout', NOW), {
			provider: 'codex', asOf: 1, source: 'rollout',
			windows: [{ id: 'session', label: '5h', usedPercent: 5, resetsAt: 1793667992 }, { id: 'weekly', label: '7d', usedPercent: 53, resetsAt: 1794101589 }]
		});
	});

	test('drops invalid ranges and implausible dates, and ignores other limit ids', () => {
		const quota = parseCodexRateLimits({
			primary: { used_percent: 101, window_minutes: 300, resets_at: 1793667992 },
			secondary: { used_percent: 10, window_minutes: 10080, resets_at: 12 }
		}, 1, 'rollout', NOW);
		assert.deepEqual(quota?.windows, [{ id: 'weekly', label: '7d', usedPercent: 10 }]);
		assert.equal(parseCodexRateLimits({ ...CODEX_LIMITS, limit_id: 'codex_other' }, 1, 'rollout', NOW), undefined);
		for (const garbage of [undefined, null, 5, 'x', [], {}, { primary: 'x' }, { primary: { used_percent: -1, window_minutes: 300 } }, { primary: { used_percent: 1, window_minutes: 0 } }, { primary: { used_percent: Number.NaN, window_minutes: 300 } }]) {
			assert.equal(parseCodexRateLimits(garbage, 1, 'rollout', NOW), undefined);
		}
	});

	test('a reset date too far ahead is dropped, the percentage kept', () => {
		const quota = parseCodexRateLimits({ primary: { used_percent: 1, window_minutes: 300, resets_at: NOW / 1000 + 10 * 365 * 24 * 3600 } }, 1, 'rollout', NOW);
		assert.deepEqual(quota?.windows, [{ id: 'session', label: '5h', usedPercent: 1 }]);
	});
});

describe('parseClaudeRateLimitEvent', () => {
	test('reads both unified windows as percentages', () => {
		assert.deepEqual(parseClaudeRateLimitEvent(CLAUDE_EVENT, NOW), {
			provider: 'claude', asOf: NOW, source: 'stream',
			windows: [{ id: 'session', label: '5h', usedPercent: 72, resetsAt: 1793668200 }, { id: 'weekly', label: '7d', usedPercent: 94, resetsAt: 1794006000 }]
		});
	});

	test('falls back to the single window of an older shape and ignores other event types', () => {
		const single = { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1793668200 } };
		assert.deepEqual(parseClaudeRateLimitEvent(single, NOW)?.windows, [{ id: 'session', label: '5h', usedPercent: 50, resetsAt: 1793668200 }]);
		assert.equal(parseClaudeRateLimitEvent({ type: 'assistant' }, NOW), undefined);
	});

	test('rejects utilization outside 0..1, hostile keys and non-objects', () => {
		const event = (unifiedWindows: unknown) => ({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows } });
		assert.equal(parseClaudeRateLimitEvent(event({ five_hour: { utilization: 72 }, seven_day: { utilization: -0.1 }, 'Bad Key!': { utilization: 0.1 }, x: 'y' }), NOW), undefined);
		assert.equal(parseClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: 'x' }, NOW), undefined);
		assert.equal(parseClaudeRateLimitEvent({ type: 'rate_limit_event' }, NOW), undefined);
	});

	test('keeps an unknown window under its sanitized key, after the known ones', () => {
		const quota = parseClaudeRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day_opus: { utilization: 0.1 }, five_hour: { utilization: 0.2 } } } }, NOW);
		assert.deepEqual(quota?.windows.map(window => window.id), ['session', 'seven_day_opus']);
	});
});

describe('quota in provider streams', () => {
	test('the Claude accumulator surfaces the rate limit event next to the answer', () => {
		const events = new ClaudeEventAccumulator();
		events.push([JSON.stringify(CLAUDE_EVENT), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }), JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', is_error: false }), ''].join('\n'));
		const parsed = events.finish();
		assert.deepEqual(parsed?.quota?.windows.map(window => [window.id, window.usedPercent]), [['session', 72], ['weekly', 94]]);
	});

	test('a stream without limit events has no quota, and Codex stdout is tolerated', () => {
		const events = new CodexEventAccumulator();
		events.push([JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }), ''].join('\n'));
		assert.equal(events.finish()?.quota, undefined);
		assert.equal(parseQuotaEvent('codex', { type: 'turn.completed' }, NOW), undefined);
		assert.deepEqual(parseQuotaEvent('codex', JSON.parse(codexLine(CODEX_LIMITS)), NOW)?.windows.length, 2);
	});
});

describe('mergeQuota and liveQuota', () => {
	const make = (asOf: number, ...windows: Array<[string, number, number?]>): ProviderQuota => ({ provider: 'claude', asOf, source: 'stream', windows: windows.map(([id, usedPercent, resetsAt]) => ({ id, label: id, usedPercent, ...(resetsAt ? { resetsAt } : {}) })) });

	test('a newer partial reading replaces only its own window', () => {
		const merged = mergeQuota(make(1, ['session', 10], ['weekly', 50]), make(2, ['session', 20]));
		assert.deepEqual(merged?.windows.map(window => [window.id, window.usedPercent]), [['session', 20], ['weekly', 50]]);
		assert.equal(mergeQuota(undefined, undefined), undefined);
		assert.equal(mergeQuota(make(1, ['session', 10]), undefined)?.windows[0].usedPercent, 10);
	});

	test('an older reading never overwrites a newer one', () => {
		assert.equal(mergeQuota(make(5, ['session', 30]), make(2, ['session', 10]))?.windows[0].usedPercent, 30);
	});

	test('windows that already reset are dropped, and nothing remains when all did', () => {
		const quota = make(1, ['session', 99, 1000], ['weekly', 40, NOW / 1000 + 100]);
		assert.deepEqual(liveQuota(quota, NOW)?.windows.map(window => window.id), ['weekly']);
		assert.equal(liveQuota(make(1, ['session', 99, 1000]), NOW), undefined);
		assert.equal(liveQuota(undefined, NOW), undefined);
	});
});

describe('readLatestCodexQuota', () => {
	test('reads the last token_count of the newest rollout', async () => {
		const older = codexLine({ ...CODEX_LIMITS, primary: { ...CODEX_LIMITS.primary, used_percent: 1 } }, '2026-11-02T19:00:00.000Z');
		const newer = codexLine(CODEX_LIMITS);
		const { home, cleanup } = await codexHome({
			'2026/11/01/rollout-2026-11-01T10-00-00-a.jsonl': codexLine({ ...CODEX_LIMITS, primary: { ...CODEX_LIMITS.primary, used_percent: 99 } }),
			'2026/11/02/rollout-2026-11-02T10-00-00-b.jsonl': [older, '{"type":"response_item","payload":{"text":"hello"}}', newer, 'not json {', ''].join('\n')
		});
		try {
			const quota = await readLatestCodexQuota(home, NOW);
			assert.deepEqual({ provider: quota?.provider, source: quota?.source, asOf: quota?.asOf, session: quota?.windows[0].usedPercent, weekly: quota?.windows[1].usedPercent },
				{ provider: 'codex', source: 'rollout', asOf: Date.parse('2026-11-02T20:11:15.591Z'), session: 5, weekly: 53 });
		} finally { await cleanup(); }
	});

	test('falls back to an older rollout when the newest has no limits', async () => {
		const { home, cleanup } = await codexHome({
			'2026/11/02/rollout-2026-11-02T09-00-00-a.jsonl': codexLine(CODEX_LIMITS),
			'2026/11/02/rollout-2026-11-02T18-00-00-b.jsonl': '{"type":"session_meta","payload":{}}\n'
		});
		try { assert.equal((await readLatestCodexQuota(home, NOW))?.windows[1].usedPercent, 53); } finally { await cleanup(); }
	});

	test('reads only the bounded tail of a huge rollout', async () => {
		const filler = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(2000) } });
		const lines = Array.from({ length: 300 }, () => filler);
		// The only limits event sits at the very start, far outside the 64 KiB tail: it must not be found.
		const { home, cleanup } = await codexHome({ '2026/11/02/rollout-2026-11-02T09-00-00-a.jsonl': [codexLine(CODEX_LIMITS), ...lines, ''].join('\n') });
		try {
			assert.ok((await fs.stat(path.join(home, '.codex/sessions/2026/11/02/rollout-2026-11-02T09-00-00-a.jsonl'))).size > 500_000);
			assert.equal(await readLatestCodexQuota(home, NOW), undefined);
			await fs.appendFile(path.join(home, '.codex/sessions/2026/11/02/rollout-2026-11-02T09-00-00-a.jsonl'), codexLine(CODEX_LIMITS) + '\n');
			assert.equal((await readLatestCodexQuota(home, NOW))?.windows.length, 2);
		} finally { await cleanup(); }
	});

	test('is silent when there is no sessions directory or nothing readable', async () => {
		const { home, cleanup } = await codexHome({});
		try {
			assert.equal(await readLatestCodexQuota(home, NOW), undefined);
			assert.equal(await readLatestCodexQuota(path.join(home, 'missing'), NOW), undefined);
		} finally { await cleanup(); }
	});
});
