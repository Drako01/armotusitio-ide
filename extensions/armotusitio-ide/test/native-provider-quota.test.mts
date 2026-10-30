/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireSharedExecutionFence } from '../src/native-shared-fence.ts';
import {
	reserveProviderInvocation, readProviderInvocationQuota, assertProviderBudget, recordProviderSpend, readProviderBudget
} from '../src/native-provider-quota.ts';
import { parseProviderOutput, CodexEventAccumulator } from '../src/native-provider-output.ts';

test('durable provider quota rejects over-budget concurrent readers before CLI launch', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-quota-root-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-quota-state-'));
	try {
		const fence = await acquireSharedExecutionFence(await fs.realpath(root), storage, 'native-workflow');
		try {
			const now = 1700000000000;
			const results = await Promise.allSettled([
				reserveProviderInvocation(storage, 'codex', fence, 1, now),
				reserveProviderInvocation(storage, 'codex', fence, 1, now)
			]);
			assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
			assert.equal(results.filter(result => result.status === 'rejected').length, 1);
			const rejected = results.find(result => result.status === 'rejected');
			assert.equal(rejected?.status, 'rejected');
			if (rejected?.status === 'rejected') {
				assert.match(String(rejected.reason), /HARNESS_PROVIDER_QUOTA_EXCEEDED/);
			}
			const other = await reserveProviderInvocation(storage, 'claude', fence, 1, now);
			assert.deepEqual(other, { used: 1, remaining: 0 });
			const stored = JSON.parse(await fs.readFile(path.join(storage, 'provider-invocations.json'), 'utf8'));
			assert.deepEqual(stored.entries.map(entry => entry.provider), ['codex', 'claude']);
			const status = await readProviderInvocationQuota(storage, 1, now);
			assert.deepEqual(status.providers, {
				codex: { used: 1, remaining: 0 }, claude: { used: 1, remaining: 0 }
			});
			assert.equal(status.enabled, true);
			// Credits expire only after the entire rolling window.
			assert.deepEqual(await reserveProviderInvocation(storage, 'codex', fence, 1, now + 86400001),
				{ used: 1, remaining: 0 });
		} finally { await fence.release(); }
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});

test('provider quota fails closed on invalid policy, corrupt state or a lost fence', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-quota-bad-root-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-quota-bad-state-'));
	try {
		const fence = await acquireSharedExecutionFence(await fs.realpath(root), storage, 'native-agent');
		try {
			await assert.rejects(reserveProviderInvocation(storage, 'codex', fence, 0),
				/HARNESS_PROVIDER_QUOTA_POLICY_INVALID/);
			const now = 1700000000000;
			await reserveProviderInvocation(storage, 'codex', fence, 2, now);
			await assert.rejects(reserveProviderInvocation(storage, 'codex', fence, 2, now - 1),
				/HARNESS_PROVIDER_QUOTA_CLOCK_ROLLBACK/);
			const ledger = path.join(storage, 'provider-invocations.json');
			await fs.writeFile(ledger, '{"schemaVersion":999}');
			await assert.rejects(reserveProviderInvocation(storage, 'codex', fence, 2, now + 1000),
				/HARNESS_PROVIDER_QUOTA_INVALID/);
			await fs.rm(ledger);
			await fence.release();
			await assert.rejects(reserveProviderInvocation(storage, 'codex', fence, 2, now + 1000),
				/HARNESS_FENCE_ALREADY_RELEASED/);
		} finally {
			// If an assertion fails, never remove the owner's lock without checking identity.
			await fence.release().catch(() => { });
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});

async function withBudgetStorage(work: (storage: string, fence: Awaited<ReturnType<typeof acquireSharedExecutionFence>>) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-budget-root-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-budget-state-'));
	try {
		const fence = await acquireSharedExecutionFence(await fs.realpath(root), path.join(storage, 'fences'), 'native-workflow');
		try { await work(storage, fence); }
		finally { await fence.release(); }
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
}

test('token budget refuses the next invocation once reported usage reaches the cap', () => withBudgetStorage(async (storage, fence) => {
	const now = 1700000000000;
	const policy = { maxTokensPer24h: 1000, maxCostUsdPer24h: 0 };
	assert.equal(await assertProviderBudget(storage, 'codex', { maxTokensPer24h: 0, maxCostUsdPer24h: 0 }, fence, now), null);
	await recordProviderSpend(storage, 'codex', fence, { usage: { inputTokens: 600, outputTokens: 300 } }, now);
	assert.deepEqual(await assertProviderBudget(storage, 'codex', policy, fence, now + 1),
		{ tokens: 900, costUsd: 0, unmeteredCalls: 0, rateLimitedUntil: null });
	await recordProviderSpend(storage, 'codex', fence, { usage: { inputTokens: 90, outputTokens: 10 } }, now + 2);
	await assert.rejects(assertProviderBudget(storage, 'codex', policy, fence, now + 3), /HARNESS_PROVIDER_TOKEN_BUDGET_EXCEEDED/);
	// Budgets are per provider and expire with the rolling window.
	assert.equal((await assertProviderBudget(storage, 'claude', policy, fence, now + 3))?.tokens, 0);
	assert.equal((await assertProviderBudget(storage, 'codex', policy, fence, now + 24 * 3600 * 1000 + 3))?.tokens, 0);
}));

test('cost budget uses provider-reported cost and fails closed on unmetered or throttled calls', () => withBudgetStorage(async (storage, fence) => {
	const now = 1700000000000;
	const policy = { maxTokensPer24h: 0, maxCostUsdPer24h: 0.5 };
	await recordProviderSpend(storage, 'claude', fence, { usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.25 } }, now);
	assert.equal((await assertProviderBudget(storage, 'claude', policy, fence, now))?.costUsd, 0.25);
	await recordProviderSpend(storage, 'claude', fence, { usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.25 } }, now);
	await assert.rejects(assertProviderBudget(storage, 'claude', policy, fence, now), /HARNESS_PROVIDER_COST_BUDGET_EXCEEDED/);
	// A provider that never reports cost cannot be assumed free.
	await recordProviderSpend(storage, 'codex', fence, { usage: { inputTokens: 1, outputTokens: 1 } }, now);
	await assert.rejects(assertProviderBudget(storage, 'codex', policy, fence, now), /HARNESS_PROVIDER_BUDGET_UNMETERED/);
	// Throttling blocks for 15 minutes even without spend.
	const tokenPolicy = { maxTokensPer24h: 10_000, maxCostUsdPer24h: 0 };
	const later = now + 10;
	await recordProviderSpend(storage, 'codex', fence, { usage: { inputTokens: 1, outputTokens: 1 }, rateLimited: true }, later);
	await assert.rejects(assertProviderBudget(storage, 'codex', tokenPolicy, fence, later + 60_000), /HARNESS_PROVIDER_RATE_LIMITED/);
	assert.equal((await assertProviderBudget(storage, 'codex', tokenPolicy, fence, later + 15 * 60_000))?.rateLimitedUntil, null);
	const view = await readProviderBudget(storage, tokenPolicy, later + 1);
	assert.deepEqual({ enabled: view.enabled, codex: view.providers.codex }, {
		enabled: true, codex: { tokens: 4, costUsd: 0, unmeteredCalls: 0, rateLimitedUntil: later + 15 * 60_000 }
	});
}));

test('budget ledger rejects tampering, clock rollback and invalid policies', () => withBudgetStorage(async (storage, fence) => {
	const now = 1700000000000;
	const policy = { maxTokensPer24h: 10, maxCostUsdPer24h: 0 };
	await assert.rejects(assertProviderBudget(storage, 'codex', { maxTokensPer24h: -1, maxCostUsdPer24h: 0 }, fence, now), /HARNESS_PROVIDER_BUDGET_POLICY_INVALID/);
	await recordProviderSpend(storage, 'codex', fence, { usage: { inputTokens: 1, outputTokens: 1 } }, now);
	await assert.rejects(assertProviderBudget(storage, 'codex', policy, fence, now - 1), /HARNESS_PROVIDER_QUOTA_CLOCK_ROLLBACK/);
	const file = path.join(storage, 'provider-spend.json');
	const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
	ledger.entries[0].prompt = 'secret';
	await fs.writeFile(file, JSON.stringify(ledger));
	await assert.rejects(assertProviderBudget(storage, 'codex', policy, fence, now), /HARNESS_PROVIDER_QUOTA_INVALID/);
}));

test('provider throttling is detected from structured error events only', () => {
	const claude = (body: object) => parseProviderOutput('claude', JSON.stringify({ type: 'result', result: 'x', ...body })).rateLimited;
	const codex = new CodexEventAccumulator();
	codex.push(JSON.stringify({ type: 'turn.failed', error: { message: 'Rate limit reached, retry later' } }) + '\n');
	assert.deepEqual({
		claude429: claude({ is_error: true, api_error_status: 429 }),
		claudeAnswerMentionsLimit: claude({ is_error: false, result: 'Explain rate limit design' }),
		codexStream: codex.finish()?.rateLimited,
		codexBatch: parseProviderOutput('codex', JSON.stringify({ type: 'error', message: 'usage limit reached' })).rateLimited,
		codexOtherError: parseProviderOutput('codex', JSON.stringify({ type: 'error', message: 'sandbox denied' })).rateLimited
	}, { claude429: true, claudeAnswerMentionsLimit: undefined, codexStream: true, codexBatch: true, codexOtherError: undefined });
});
