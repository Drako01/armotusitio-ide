/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Privacy-minimized local agent performance ledger. No prompts, credentials, paths or outputs. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentOutcome } from './native-agent-execution.ts';
import type { AgentRole, NativeProvider } from './native-providers.ts';

export interface AgentMetric {
	id: string;
	at: string;
	provider: NativeProvider;
	role: AgentRole;
	status: AgentOutcome['status'];
	durationMs: number;
	truncated: boolean;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	estimatedCostUsd?: number;
}
export interface AgentStatistics {
	count: number;
	successes: number;
	failures: number;
	cancelled: number;
	successRate: number | null;
	averageDurationMs: number | null;
	p95DurationMs: number | null;
	usageSamples: number;
	measuredInputTokens: number | null;
	measuredOutputTokens: number | null;
	measuredCachedInputTokens: number | null;
	unmeteredSamples: number;
	providerBreakdown: ProviderMetricSummary[];
	recommendations: ('usage-unavailable' | 'partial-usage' | 'context-dominates')[];
	estimatedCostUsd: number | null;
	entries: AgentMetric[];
}
export interface ProviderMetricSummary {
	provider: NativeProvider;
	count: number;
	usageSamples: number;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedInputTokens: number | null;
	averageDurationMs: number | null;
}
const LIMIT = 100;
const MAX_LEDGER_BYTES = 64 * 1024;

function validInteger(value: number | undefined): boolean { return value === undefined || (Number.isSafeInteger(value) && value >= 0); }
function validCost(value: number | undefined): boolean { return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1_000_000); }
function validateRecord(record: AgentMetric): boolean {
	return !!record && /^[a-f0-9-]{36}$/.test(record.id) && Number.isFinite(Date.parse(record.at))
		&& ['codex', 'claude'].includes(record.provider) && ['planner', 'reviewer', 'implementer'].includes(record.role)
		&& ['passed', 'failed', 'cancelled', 'timeout'].includes(record.status)
		&& Number.isSafeInteger(record.durationMs) && record.durationMs >= 0 && typeof record.truncated === 'boolean'
		&& validInteger(record.inputTokens) && validInteger(record.outputTokens)
		&& validInteger(record.cachedInputTokens) && validCost(record.estimatedCostUsd);
}
async function load(file: string): Promise<AgentMetric[]> {
	let stat;
	try { stat = await fs.lstat(file); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEDGER_BYTES) { throw Error('HARNESS_METRICS_UNSAFE'); }
	const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
	if (!Array.isArray(parsed) || parsed.length > LIMIT || !parsed.every(validateRecord)) { throw Error('HARNESS_METRICS_INVALID'); }
	return parsed as AgentMetric[];
}
export async function recordAgentMetric(directory: string, provider: NativeProvider, role: AgentRole, result: AgentOutcome): Promise<void> {
	const file = path.join(directory, 'agent-metrics.json');
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const existing = await load(file);
	const entry: AgentMetric = {
		id: randomUUID(), at: new Date().toISOString(), provider, role,
		status: result.status, durationMs: result.durationMs, truncated: result.truncated,
		...(result.usage ? {
			inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
			cachedInputTokens: result.usage.cachedInputTokens, estimatedCostUsd: result.usage.estimatedCostUsd
		} : {})
	};
	const next = [...existing, entry].slice(-LIMIT);
	const tmp = file + '.' + randomUUID() + '.tmp';
	try {
		await fs.writeFile(tmp, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
		await fs.rename(tmp, file);
	} finally { await fs.rm(tmp, { force: true }); }
}
export async function readAgentStatistics(directory: string): Promise<AgentStatistics> {
	const entries = await load(path.join(directory, 'agent-metrics.json'));
	const count = entries.length;
	const successes = entries.filter(e => e.status === 'passed').length;
	const cancelled = entries.filter(e => e.status === 'cancelled').length;
	const failures = count - successes - cancelled;
	const durations = entries.map(e => e.durationMs).sort((a, b) => a - b);
	const metered = entries.filter(e => e.inputTokens !== undefined && e.outputTokens !== undefined);
	const priced = entries.filter(e => e.estimatedCostUsd !== undefined);
	const measuredTotal = (rows: AgentMetric[], key: 'inputTokens' | 'outputTokens' | 'cachedInputTokens'): number | null => {
		const samples = rows.filter(row => row[key] !== undefined);
		if (!samples.length) { return null; }
		const total = samples.reduce((sum, row) => sum + row[key]!, 0);
		return Number.isSafeInteger(total) ? total : null;
	};
	const providerBreakdown = (['codex', 'claude'] as const).flatMap(provider => {
		const rows = entries.filter(entry => entry.provider === provider);
		if (!rows.length) { return []; }
		const measured = rows.filter(entry => entry.inputTokens !== undefined && entry.outputTokens !== undefined);
		return [{
			provider, count: rows.length, usageSamples: measured.length,
			inputTokens: measuredTotal(measured, 'inputTokens'), outputTokens: measuredTotal(measured, 'outputTokens'),
			cachedInputTokens: measuredTotal(rows, 'cachedInputTokens'),
			averageDurationMs: Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length)
		}];
	});
	const measuredInputTokens = measuredTotal(metered, 'inputTokens');
	const measuredOutputTokens = measuredTotal(metered, 'outputTokens');
	const recommendations: AgentStatistics['recommendations'] = [];
	if (count && !metered.length) { recommendations.push('usage-unavailable'); }
	else if (metered.length < count) { recommendations.push('partial-usage'); }
	// A descriptive threshold, not evidence of duplicated context or a claim of potential savings.
	if (metered.length >= 3 && measuredInputTokens !== null && measuredOutputTokens !== null && measuredInputTokens > 4 * Math.max(1, measuredOutputTokens)) { recommendations.push('context-dominates'); }
	return {
		count, successes, failures, cancelled,
		successRate: count ? Math.round(successes / count * 10000) / 100 : null,
		averageDurationMs: count ? Math.round(durations.reduce((a, b) => a + b, 0) / count) : null,
		p95DurationMs: count ? durations[Math.ceil(count * .95) - 1] : null,
		usageSamples: metered.length,
		measuredInputTokens, measuredOutputTokens,
		measuredCachedInputTokens: measuredTotal(entries, 'cachedInputTokens'),
		unmeteredSamples: count - metered.length, providerBreakdown, recommendations,
		estimatedCostUsd: priced.length ? Math.round(priced.reduce((sum, e) => sum + e.estimatedCostUsd!, 0) * 1e6) / 1e6 : null,
		entries
	};
}
