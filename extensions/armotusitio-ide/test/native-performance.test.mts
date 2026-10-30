/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveWorkerBudget, sampleHostLoad, summarizeGatePerformance } from '../src/native-performance.ts';
import { selectNativeWave } from '../src/native-harness.ts';

test('reports only measured wall time and per-gate concurrency ratios', () => {
	const tasks = [{
		attempts: [{
			startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:01.000Z',
			status: 'passed',
			results: [
				{ startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:00.800Z' },
				{ startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:00.800Z' }
			]
		}]
	}] as unknown as Parameters<typeof summarizeGatePerformance>[0];
	const result = summarizeGatePerformance(tasks);
	assert.equal(result.attempts, 1);
	assert.equal(result.completionRate, 100);
	assert.equal(result.p95WallMs, 1000);
	assert.equal(result.averageParallelFactor, 1.6);
});
test('does not fabricate speedups or success rate when no evidence is present', () => {
	const result = summarizeGatePerformance([]);
	assert.equal(result.attempts, 0);
	assert.equal(result.averageParallelFactor, null);
	assert.equal(result.completionRate, null);
});

test('adaptive worker budget follows idle CPUs and memory pressure, never below one', () => {
	const gib = 1024 ** 3;
	const budget = (cpus: number, loadAverage1m: number, freeGiB: number) =>
		adaptiveWorkerBudget({ cpus, loadAverage1m, freeMemoryBytes: freeGiB * gib, totalMemoryBytes: 16 * gib });
	assert.deepEqual({
		idle: budget(8, 0, 8), busy: budget(8, 6, 8), saturated: budget(8, 12, 8),
		lowMemory: budget(8, 0, 3), criticalMemory: budget(8, 0, 1), invalid: adaptiveWorkerBudget({ cpus: 0, loadAverage1m: Number.NaN, freeMemoryBytes: 0, totalMemoryBytes: 0 })
	}, { idle: 8, busy: 2, saturated: 1, lowMemory: 2, criticalMemory: 1, invalid: 1 });
	const sample = sampleHostLoad();
	assert.ok(sample.cpus >= 1 && sample.totalMemoryBytes > 0);
	const gates = ['a', 'b', 'c', 'd'].map(id => ({ id, executable: 'node', args: [], parallelSafe: true, resources: [id] }));
	assert.deepEqual(selectNativeWave(gates, budget(8, 7, 8)).map(gate => gate.id), ['a']);
});
