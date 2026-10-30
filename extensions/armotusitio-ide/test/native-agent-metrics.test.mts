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
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('rejects oversized or corrupted metrics rather than rewriting them', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-metrics-invalid-'));
	try {
		await fs.writeFile(path.join(directory, 'agent-metrics.json'), JSON.stringify([{ fake: 'secret' }]));
		await assert.rejects(readAgentStatistics(directory), /HARNESS_METRICS_INVALID/);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
