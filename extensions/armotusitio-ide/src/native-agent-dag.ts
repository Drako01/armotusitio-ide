/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Deterministic bounded DAG scheduling. Writers never run beside another agent in one wave. */
import { validateHandoffPlan, type Handoff, type HandoffPlan } from './native-providers.ts';

export interface AgentWave { readonly ids: readonly string[]; readonly readOnly: boolean }

/** Topological waves for up to sixteen agents. Read-only nodes may share a wave, writers never do. */
export function planAgentWaves(input: HandoffPlan, maxReaders = 2): AgentWave[] {
	const plan = validateHandoffPlan(input);
	if (!Number.isSafeInteger(maxReaders) || maxReaders < 1 || maxReaders > 4) { throw Error('HARNESS_DAG_CONCURRENCY_INVALID'); }
	const completed = new Set<string>();
	const result: AgentWave[] = [];
	while (completed.size < plan.handoffs.length) {
		const ready = plan.handoffs.filter(h => !completed.has(h.id) && h.dependsOn.every(dep => completed.has(dep)));
		if (!ready.length) { throw Error('HARNESS_DAG_DEADLOCK'); }
		const writer = ready.find(h => h.role === 'implementer');
		const wave = writer ? [writer] : ready.slice(0, maxReaders);
		result.push({ ids: wave.map(h => h.id), readOnly: !writer });
		for (const handoff of wave) { completed.add(handoff.id); }
	}
	return result;
}

export interface AgentDAGOutcome {
	id: string;
	status: 'passed' | 'failed' | 'cancelled';
}

/**
 * Bounded execution driver for preapproved tasks. Only supplies dependency-safe
 * dispatch order; callers must still enforce provider permissions and OS isolation.
 * A failed wave prevents all dependent work from starting.
 */
export async function executeAgentDAG(
	plan: HandoffPlan,
	execute: (handoff: Handoff) => Promise<AgentDAGOutcome['status']>,
	signal?: AbortSignal,
	maxReaders = 2
): Promise<AgentDAGOutcome[]> {
	const waves = planAgentWaves(plan, maxReaders);
	const handoffs = new Map(plan.handoffs.map(h => [h.id, h]));
	const outcomes: AgentDAGOutcome[] = [];
	for (const wave of waves) {
		if (signal?.aborted) { break; }
		const completed = await Promise.all(wave.ids.map(async id => {
			if (signal?.aborted) { return { id, status: 'cancelled' as const }; }
			const handoff = handoffs.get(id);
			if (!handoff) { throw Error('HARNESS_DAG_MISSING_NODE'); }
			try {
				const status = await execute(handoff);
				return { id, status };
			} catch { return { id, status: 'failed' as const }; }
		}));
		outcomes.push(...completed);
		if (completed.some(outcome => outcome.status !== 'passed') || signal?.aborted) { break; }
	}
	return outcomes;
}
