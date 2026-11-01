/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Goal quota and cost (block AB): an estimate before approval calibrated with local history, a reserve that autonomous
 * goals never consume, and warnings at 80% of the goal budget and of the provider quota.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GoalCharter } from './native-goal.ts';

export interface GoalUsage { size: GoalCharter['size']; tasks: number; calls: number; at: string }
export interface GoalEstimate { low: number; high: number; basis: 'history' | 'default' }

const DEFAULTS: Record<GoalCharter['size'], [number, number]> = { question: [1, 1], small: [2, 4], goal: [8, 20] };
const MAX_HISTORY = 200;

export class GoalUsageHistory {
	private readonly file: string;
	constructor(directory: string) { this.file = path.join(directory, 'goal-usage.json'); }
	async list(): Promise<GoalUsage[]> {
		const raw = await fs.readFile(this.file, 'utf8').catch(() => undefined);
		const value = raw ? JSON.parse(raw) as unknown : [];
		return Array.isArray(value) ? value.filter((item): item is GoalUsage => !!item && Number.isSafeInteger(item.calls)) : [];
	}
	async record(usage: GoalUsage): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
		await fs.writeFile(this.file, JSON.stringify([...(await this.list()), usage].slice(-MAX_HISTORY)), { mode: 0o600 });
	}
}

/** Calls a goal of this size usually takes ("esto suele usar 3550 llamadas"): the 25th and 90th percentiles of history. */
export function estimateCalls(size: GoalCharter['size'], tasks: number, history: readonly GoalUsage[]): GoalEstimate {
	const similar = history.filter(item => item.size === size).map(item => item.calls / Math.max(1, item.tasks) * Math.max(1, tasks)).sort((left, right) => left - right);
	if (similar.length < 3) { const [low, high] = DEFAULTS[size]; return { low: low * Math.max(1, size === 'goal' ? Math.ceil(tasks / 3) : 1), high: high * Math.max(1, size === 'goal' ? Math.ceil(tasks / 3) : 1), basis: 'default' }; }
	const at = (ratio: number) => Math.round(similar[Math.min(similar.length - 1, Math.floor(ratio * (similar.length - 1)))]);
	return { low: at(0.25), high: Math.max(at(0.25), at(0.9)), basis: 'history' };
}

/**
 * Whether the goal fits: the remaining provider quota minus the reserve kept for manual work must cover the high estimate.
 * `remaining` is undefined when no limit is configured or reported.
 */
export function quotaCheck(estimate: GoalEstimate, remaining: number | undefined, limit: number | undefined, reservePercent: number): { fits: boolean; available?: number; advice?: 'split-or-other-provider' } {
	if (remaining === undefined || limit === undefined) { return { fits: true }; }
	const available = Math.max(0, remaining - Math.ceil(limit * reservePercent / 100));
	return estimate.high <= available ? { fits: true, available } : { fits: false, available, advice: 'split-or-other-provider' };
}

/** 80% warning and 100% hard stop of a goal's own budget (runs). */
export function budgetLevel(used: number, maximum: number): 'ok' | 'warning' | 'exhausted' {
	return used >= maximum ? 'exhausted' : used >= Math.ceil(maximum * 0.8) ? 'warning' : 'ok';
}
