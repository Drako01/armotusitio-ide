/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Adaptive assignment of providers to the agents of a workflow. Pure and deterministic: it decides from facts the
 * caller measured (installed and signed in, quota left, rate-limit cooldown, writer isolation) and justifies every
 * choice with a stable reason code. Specialised readers come only from a fixed catalogue of read-only roles, never
 * from free text, so a task description cannot create an agent with new permissions. The result is an ordinary
 * handoff plan: it still needs the same review and approval as a hand-written one.
 */
import { proposedWorkflow } from './native-agent-workflow.ts';
import { validateHandoffPlan, type AgentRole, type HandoffPlan, type NativeProvider } from './native-providers.ts';

export interface ProviderAvailability {
	provider: NativeProvider;
	/** Installed, compatible and signed in; the caller derives it from local diagnostics. */
	usable: boolean;
	/** Provider calls left in the quota window; undefined when no limit applies. */
	remainingCalls?: number;
	/** True while a detected rate limit is cooling down. */
	coolingDown?: boolean;
	/** Whether the user's isolation requirement lets this provider's writer run. */
	writerAllowed: boolean;
}
export type AssignmentReason = 'only-option' | 'independent-review' | 'most-capacity' | 'preferred' | 'default-order' | 'no-independent-provider';
export interface Assignment { id: string; role: AgentRole; provider: NativeProvider; reason: AssignmentReason }

/** Read-only specialists the planner may add. Each runs concurrently with the others before the plan. */
export const READER_CATALOG = {
	architecture: 'Read-only analysis of the architecture, module boundaries and conventions relevant to the task below. Report findings; do not modify files.',
	tests: 'Read-only analysis of the existing tests and the checks that are missing for the task below. Report findings; do not modify files.',
	security: 'Read-only review of the security-sensitive areas the task below touches (input validation, authorization, secrets). Report findings; do not modify files.'
} as const;
export type ReaderId = keyof typeof READER_CATALOG;
/** The workflow dialog authorizes at most five provider invocations; two readers plus plan, implement and review fill them. */
export const MAX_READERS = 2;

const ORDER: readonly NativeProvider[] = ['codex', 'claude'];
const capacity = (state: ProviderAvailability): number => state.remainingCalls ?? Number.POSITIVE_INFINITY;

/** Pick the provider for one role, or fail closed when none can take it. */
export function chooseProvider(
	role: AgentRole, states: readonly ProviderAvailability[], options: { avoid?: NativeProvider; preferred?: NativeProvider } = {}
): { provider: NativeProvider; reason: AssignmentReason } {
	const eligible = states.filter(state => state.usable && !state.coolingDown && capacity(state) > 0 && (role !== 'implementer' || state.writerAllowed));
	if (!eligible.length) { throw Error('HARNESS_NO_PROVIDER_AVAILABLE'); }
	if (eligible.length === 1) { return { provider: eligible[0].provider, reason: 'only-option' }; }
	if (options.avoid) {
		// An independent reviewer is worth more than spare capacity.
		const independent = eligible.filter(state => state.provider !== options.avoid);
		if (independent.length === 1) { return { provider: independent[0].provider, reason: 'independent-review' }; }
	}
	const sorted = [...eligible].sort((left, right) => capacity(right) - capacity(left) || ORDER.indexOf(left.provider) - ORDER.indexOf(right.provider));
	if (capacity(sorted[0]) > capacity(sorted[1])) { return { provider: sorted[0].provider, reason: 'most-capacity' }; }
	const preferred = sorted.find(state => state.provider === options.preferred);
	return preferred ? { provider: preferred.provider, reason: 'preferred' } : { provider: sorted[0].provider, reason: 'default-order' };
}

export interface AdaptiveWorkflow { plan: HandoffPlan; assignments: Assignment[] }

/**
 * Plan, implement and review a task with providers chosen from live availability, optionally preceded by
 * catalogued read-only specialists. The reviewer is a different provider whenever one is available.
 */
export function buildAdaptiveWorkflow(
	instruction: string, states: readonly ProviderAvailability[], options: { readers?: readonly string[]; preferred?: NativeProvider } = {}
): AdaptiveWorkflow {
	const readers = options.readers ?? [];
	if (readers.length > MAX_READERS || new Set(readers).size !== readers.length || !readers.every(id => Object.hasOwn(READER_CATALOG, id))) {
		throw Error('HARNESS_ADAPTIVE_READER_INVALID');
	}
	const planner = chooseProvider('planner', states, { preferred: options.preferred });
	const implementer = chooseProvider('implementer', states, { preferred: planner.provider });
	let reviewer: { provider: NativeProvider; reason: AssignmentReason };
	try { reviewer = chooseProvider('reviewer', states, { avoid: implementer.provider }); }
	catch { reviewer = { provider: implementer.provider, reason: 'no-independent-provider' }; }
	// Reviewing with the provider that wrote the change is allowed, but never presented as independent.
	if (reviewer.provider === implementer.provider) { reviewer = { provider: reviewer.provider, reason: 'no-independent-provider' }; }
	const base = proposedWorkflow(planner.provider, instruction);
	const byId = new Map(base.handoffs.map(handoff => [handoff.id, handoff]));
	byId.get('implement')!.provider = implementer.provider;
	byId.get('review')!.provider = reviewer.provider;
	const assignments: Assignment[] = [];
	const specialists = readers.map((id, index) => {
		// Readers alternate providers so the two analyses are independent and share the load.
		const choice = chooseProvider('planner', states, { preferred: ORDER[(ORDER.indexOf(planner.provider) + index) % ORDER.length] });
		assignments.push({ id: 'read-' + id, role: 'planner', provider: choice.provider, reason: choice.reason });
		return { id: 'read-' + id, role: 'planner' as const, provider: choice.provider, dependsOn: [], instruction: READER_CATALOG[id as ReaderId] + '\n' + instruction };
	});
	const plan = byId.get('plan')!;
	plan.dependsOn = specialists.map(specialist => specialist.id);
	assignments.push(
		{ id: 'plan', role: 'planner', provider: planner.provider, reason: planner.reason },
		{ id: 'implement', role: 'implementer', provider: implementer.provider, reason: implementer.reason },
		{ id: 'review', role: 'reviewer', provider: reviewer.provider, reason: reviewer.reason }
	);
	return { plan: validateHandoffPlan({ schemaVersion: 1, handoffs: [...specialists, ...base.handoffs] }), assignments };
}
