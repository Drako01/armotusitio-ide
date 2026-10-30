/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
/** Observed task performance, never extrapolated or presented as external-agent speedup. */
import type { Task } from './native-harness.ts';

export interface GatePerformance {
  attempts: number;
  passed: number;
  failed: number;
  cancelled: number;
  completionRate: number | null;
  p95WallMs: number | null;
  medianWallMs: number | null;
  averageParallelFactor: number | null;
}
function percentile(sorted: number[], pct: number): number | null {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * pct) - 1)] : null;
}
export function summarizeGatePerformance(tasks: Task[]): GatePerformance {
  const attempts = tasks.flatMap(task => task.attempts)
    .filter(attempt => attempt.endedAt && attempt.status !== 'running');
  const wall = attempts.map(attempt => Date.parse(attempt.endedAt!) - Date.parse(attempt.startedAt))
    .filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const factors: number[] = [];
  for (const attempt of attempts) {
    const elapsed = Date.parse(attempt.endedAt!) - Date.parse(attempt.startedAt);
    const sequential = attempt.results.reduce((sum, gate) => sum + Math.max(0,
      Date.parse(gate.endedAt) - Date.parse(gate.startedAt)), 0);
    if (Number.isFinite(elapsed) && elapsed > 0 && Number.isFinite(sequential) && sequential > 0) {
      factors.push(Math.round(sequential / elapsed * 100) / 100);
    }
  }
  const passed = attempts.filter(attempt => attempt.status === 'passed').length;
  const cancelled = attempts.filter(attempt => attempt.status === 'cancelled').length;
  return {
    attempts: attempts.length, passed,
    failed: attempts.length - passed - cancelled, cancelled,
    completionRate: attempts.length ? Math.round(10000 * passed / attempts.length) / 100 : null,
    p95WallMs: percentile(wall, .95),
    medianWallMs: percentile(wall, .5),
    averageParallelFactor: factors.length ? Math.round(factors.reduce((a, b) => a + b, 0) / factors.length * 100) / 100 : null
  };
}
