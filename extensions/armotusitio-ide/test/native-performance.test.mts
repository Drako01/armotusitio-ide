/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeGatePerformance } from '../src/native-performance.ts';

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
  }] as any;
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
