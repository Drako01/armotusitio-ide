/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { recordAgentMetric, readAgentStatistics } from '../src/native-agent-metrics.ts';

test('records bounded metrics without prompts, paths, outputs or credentials', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-metrics-'));
	try {
		const before = await readAgentStatistics(directory);
		assert.equal(before.count, 0);
		assert.equal(before.successRate, null);
		await recordAgentMetric(directory, 'codex', 'implementer', { status: 'passed', exitCode: 0,
			durationMs: 100, truncated: false, output: 'SECRET_PROMPT_VALUE', usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 500 } });
		await recordAgentMetric(directory, 'claude', 'reviewer', { status: 'failed', exitCode: 1,
			durationMs: 300, truncated: false, output: 'SECRET_OUTPUT_VALUE', usage: { inputTokens: 500, outputTokens: 50, estimatedCostUsd: 0.023 } });
		const result = await readAgentStatistics(directory);
		assert.deepEqual({ count: result.count, successes: result.successes, failures: result.failures,
			successRate: result.successRate, average: result.averageDurationMs, p95: result.p95DurationMs },
			{ count: 2, successes: 1, failures: 1, successRate: 50, average: 200, p95: 300 });
		const raw = await fs.readFile(path.join(directory, 'agent-metrics.json'), 'utf8');
		assert.ok(!raw.includes('SECRET_'));
		assert.equal(result.entries[0].provider, 'codex');
		assert.equal(result.usageSamples, 2);
		assert.equal(result.measuredInputTokens, 1500);
		assert.equal(result.measuredOutputTokens, 250);
		assert.equal(result.estimatedCostUsd, 0.023);
	} finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('rejects oversized or corrupted metrics rather than rewriting them', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-metrics-invalid-'));
	try {
		await fs.writeFile(path.join(directory, 'agent-metrics.json'), JSON.stringify([{ fake: 'secret' }]));
		await assert.rejects(readAgentStatistics(directory), /HARNESS_METRICS_INVALID/);
	} finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('provider summaries distinguish absent receipts from measured zero and recommend without claiming savings', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-metrics-summary-'));
	try {
		const outcome = { status: 'passed' as const, exitCode: 0, durationMs: 100, truncated: false, output: '' };
		await recordAgentMetric(directory, 'claude', 'reviewer', outcome);
		assert.deepEqual((await readAgentStatistics(directory)).recommendations, ['usage-unavailable']);
		for (let index = 0; index < 3; index++) {
			await recordAgentMetric(directory, 'codex', 'implementer', { ...outcome, usage: { inputTokens: 100, outputTokens: 0, cachedInputTokens: 0 } });
		}
		const result = await readAgentStatistics(directory);
		assert.deepEqual({ unmetered: result.unmeteredSamples, cache: result.measuredCachedInputTokens, recommendations: result.recommendations, providers: result.providerBreakdown }, {
			unmetered: 1, cache: 0, recommendations: ['partial-usage', 'context-dominates'], providers: [
				{ provider: 'codex', count: 3, usageSamples: 3, inputTokens: 300, outputTokens: 0, cachedInputTokens: 0, averageDurationMs: 100 },
				{ provider: 'claude', count: 1, usageSamples: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, averageDurationMs: 100 }
			]
		});
	} finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('an overflowing token aggregate is unavailable, never a rounded measurement', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-metrics-overflow-'));
	try {
		for (let index = 0; index < 2; index++) {
			await recordAgentMetric(directory, 'codex', 'implementer', { status: 'passed', exitCode: 0, durationMs: 1, truncated: false, output: '', usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 } });
		}
		const result = await readAgentStatistics(directory);
		assert.deepEqual([result.measuredInputTokens, result.providerBreakdown[0].inputTokens, result.measuredCachedInputTokens], [null, null, null]);
	} finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
