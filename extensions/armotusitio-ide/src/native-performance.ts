/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Observed task performance, never extrapolated or presented as external-agent speedup. */
import * as os from 'node:os';
import type { Task } from './native-harness.ts';

/** Host telemetry sampled right before scheduling a wave. */
export interface HostLoad {
	cpus: number;
	loadAverage1m: number;
	freeMemoryBytes: number;
	totalMemoryBytes: number;
}
const LOW_FREE_MEMORY = 0.20;
const CRITICAL_FREE_MEMORY = 0.10;
export function sampleHostLoad(): HostLoad {
	return { cpus: os.availableParallelism(), loadAverage1m: os.loadavg()[0], freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem() };
}

/**
 * Worker budget from observed capacity: idle CPUs when the OS reports load
 * (Windows always reports 0, so only memory pressure applies there), and at
 * most two workers under 20% free memory or one under 10%. Never below one.
 */
export function adaptiveWorkerBudget(load: HostLoad): number {
	const cpus = Number.isSafeInteger(load.cpus) && load.cpus > 0 ? load.cpus : 1;
	let budget = Number.isFinite(load.loadAverage1m) && load.loadAverage1m > 0
		? Math.floor(cpus - load.loadAverage1m + 0.5) : cpus;
	const free = load.totalMemoryBytes > 0 ? load.freeMemoryBytes / load.totalMemoryBytes : 1;
	if (free < CRITICAL_FREE_MEMORY) { budget = 1; }
	else if (free < LOW_FREE_MEMORY) { budget = Math.min(budget, 2); }
	return Math.max(1, Math.min(cpus, budget));
}

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
