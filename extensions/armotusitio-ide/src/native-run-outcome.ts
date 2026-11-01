/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** How a run ended, from objective signals (stop reason, diff, verification, a structured block), never from prose alone. */
import type { AgentOutcome } from './native-agent-execution.ts';
import { validRunDiff, type RunDiffSummary } from './native-run-diff.ts';
import { validSessionId } from './native-provider-output.ts';

export type RunOutcomeKind = 'completed' | 'partial' | 'blocked' | 'unchanged' | 'failed';
export type RunNeed = 'service' | 'credential' | 'policy' | 'decision' | 'toolchain' | 'disk';
export interface RunOutcome {
	kind: RunOutcomeKind;
	/** Machine reason (`max-turns`, `timeout`, `cancelled`, `verification`, `provider`) or the agent's own blocked reason. */
	reason?: string;
	needs?: RunNeed;
	/** Provider session a continuation can resume. */
	sessionId?: string;
	diff: RunDiffSummary;
}
export interface RunBlock { reason: string; needs: RunNeed; detail?: string }

const KINDS: readonly RunOutcomeKind[] = ['completed', 'partial', 'blocked', 'unchanged', 'failed'];
const NEEDS: readonly RunNeed[] = ['service', 'credential', 'policy', 'decision', 'toolchain', 'disk'];
const BLOCK = /^harness-blocked:\s*(\{.*\})\s*$/gm;

/** The last valid `harness-blocked: {...}` line of an agent report; invalid lines are ignored, not guessed. */
export function parseRunBlock(report: string): RunBlock | undefined {
	let found: RunBlock | undefined;
	for (const match of report.matchAll(BLOCK)) {
		try {
			const value = JSON.parse(match[1]) as Partial<RunBlock>;
			if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500 || !NEEDS.includes(value.needs as RunNeed)) { continue; }
			found = { reason: value.reason.trim(), needs: value.needs as RunNeed, ...(typeof value.detail === 'string' && value.detail.trim() ? { detail: value.detail.trim().slice(0, 2000) } : {}) };
		} catch { /* Not a block: it stays visible as text. */ }
	}
	return found;
}

/**
 * Classify a finished run. Only `completed` marks a plan as applied; every other kind leaves it approvable.
 * A run stopped by its budget, by the user or by a timeout is `partial` when it changed files, so it can be continued.
 */
export function classifyRun(input: { agent: AgentOutcome; verification: 'passed' | 'failed' | 'cancelled' | 'timeout' | 'skipped'; diff: RunDiffSummary }): RunOutcome {
	const { agent, verification, diff } = input;
	const base = { diff, ...(agent.sessionId ? { sessionId: agent.sessionId } : {}) };
	const changed = !diff.available || diff.count > 0;
	// A query with a secret already left: the run is failed whatever it changed (EC-145).
	if (agent.searchLeak) { return { ...base, kind: 'failed', reason: 'web-search-secret' }; }
	const block = parseRunBlock(agent.output);
	if (block) { return { ...base, kind: 'blocked', reason: block.reason, needs: block.needs }; }
	const stopped = agent.stopReason === 'max-turns' ? 'max-turns' : agent.status === 'timeout' ? 'timeout' : agent.status === 'cancelled' ? 'cancelled' : undefined;
	if (stopped) { return { ...base, kind: diff.available && !diff.count ? 'unchanged' : 'partial', reason: stopped }; }
	if (agent.status !== 'passed') { return { ...base, kind: 'failed', reason: 'provider' }; }
	if (verification === 'failed' || verification === 'timeout') { return { ...base, kind: 'failed', reason: 'verification' }; }
	if (verification === 'cancelled') { return { ...base, kind: 'partial', reason: 'cancelled' }; }
	return { ...base, kind: changed ? 'completed' : 'unchanged' };
}

export function validRunOutcome(value: RunOutcome | undefined): boolean {
	return value === undefined || (!!value && KINDS.includes(value.kind) && !!value.diff && validRunDiff(value.diff) &&
		(value.reason === undefined || (typeof value.reason === 'string' && value.reason.length <= 500)) &&
		(value.needs === undefined || NEEDS.includes(value.needs)) && (value.sessionId === undefined || validSessionId(value.sessionId)));
}
