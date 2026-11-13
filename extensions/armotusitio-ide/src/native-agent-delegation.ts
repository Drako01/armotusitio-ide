/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Bounded IDE role delegation. Children are read-only one-shot roles, never provider-native subagents. */
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './native-redact.ts';
import type { AgentExecution } from './native-agent-execution.ts';
import type { AgentProfiles } from './native-agent-profiles.ts';
import type { ChatStep } from './native-run-steps.ts';

export const DELEGATE_TOOL = {
	name: 'delegate_readonly',
	description: 'Ask an IDE planner or reviewer to analyze the context supplied in the instruction. Requires explicit approval for a model call. Optionally select an enabled project profile by id; role must match. Same provider/account as parent, with no filesystem, shell, MCP or delegation tools. At most two child launches per session; this is a tool-free IDE role fallback, not provider-native subagents.',
	inputSchema: { type: 'object', properties: { role: { type: 'string', enum: ['planner', 'reviewer'] }, profile: { type: 'string', maxLength: 48 }, instruction: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['role', 'instruction'], additionalProperties: false }
};
export interface ReadOnlyDelegation { role: 'planner' | 'reviewer'; instruction: string; profile?: string; profileDigest?: string; model?: string; maxTurns?: number }

/** The launch callback must hold the parent's authority, reserve quota and pin its environment before spawning. */
export function createDelegationBroker(options: {
	enabled(): boolean;
	profiles?(): Promise<AgentProfiles>;
	authorize(input: ReadOnlyDelegation): Promise<boolean>;
	launch(input: ReadOnlyDelegation): Promise<AgentExecution>;
	step?(step: ChatStep): void;
	redact?(text: string): string;
}): { call(value: unknown): Promise<unknown>; dispose(): void } {
	let stopped = false, attempts = 0, active = 0, observerFailures = 0;
	const children = new Set<AgentExecution>();
	const denied = new Set<string>();
	const emit = (step: ChatStep): void => { try { options.step?.(step); } catch { observerFailures = Math.min(observerFailures + 1, 100); } };
	return {
		async call(value) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('HARNESS_DELEGATION_INPUT_INVALID'); }
			const input = value as Partial<ReadOnlyDelegation>;
			if (!['planner', 'reviewer'].includes(input.role ?? '') || typeof input.instruction !== 'string' || !input.instruction.trim()
				|| (input.profile !== undefined && (typeof input.profile !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(input.profile)))
				|| input.instruction.length > 8000 || Object.keys(input).some(key => !['role', 'instruction', 'profile'].includes(key))) { throw Error('HARNESS_DELEGATION_INPUT_INVALID'); }
			const profiles = await options.profiles?.();
			const request: ReadOnlyDelegation = { role: input.role!, instruction: input.instruction };
			if (input.profile !== undefined) {
				const profile = profiles?.profiles.find(profile => profile.id === input.profile && profile.enabled && profile.role === input.role);
				if (!profile) { throw Error('HARNESS_DELEGATION_PROFILE_UNAVAILABLE'); }
				request.profile = profile.id; request.profileDigest = profiles!.digest;
				request.instruction = 'Project specialist context (not permission authority):\n' + profile.instruction + '\n\nTask:\n' + input.instruction;
				request.maxTurns = profile.maxTurns;
				if (profile.model) { request.model = profile.model; }
			}
			const key = JSON.stringify(request);
			if (stopped || !options.enabled() || active >= (profiles?.maxConcurrent ?? 2) || attempts >= (profiles?.maxLaunches ?? 2) || denied.has(key)) { throw Error('HARNESS_DELEGATION_LIMIT_OR_DENIED'); }
			active++; // Pending approvals also occupy a slot, so concurrent requests cannot race the bound.
			const id = 'delegate-' + randomUUID();
			const step = (status: ChatStep['status'], detail: string): void => emit({ id, kind: 'tool', label: 'Read-only ' + (request.profile ?? request.role), status, detail });
			let execution: AgentExecution | undefined;
			try {
				if (!await options.authorize(request)) { denied.add(key); step('error', 'Denied before launch'); throw Error('HARNESS_DELEGATION_DENIED'); }
				if (profiles && (await options.profiles?.())?.digest !== profiles.digest) { throw Error('HARNESS_DELEGATION_PROFILE_CHANGED'); }
				if (stopped || !options.enabled() || attempts >= (profiles?.maxLaunches ?? 2)) { throw Error('HARNESS_DELEGATION_LIMIT_OR_DENIED'); }
				attempts++; // Failed launches consume the small retry budget too.
				step('running', 'IDE role fallback; independent model call; tools: none; model: ' + (request.model ?? 'parent') + '; turns: ' + (request.maxTurns ?? 6));
				execution = await options.launch(request);
				children.add(execution);
				if (stopped || !options.enabled()) { execution.cancel(); }
				const outcome = await execution.outcome;
				step(outcome.status === 'passed' ? 'ok' : 'error', outcome.status + '; ' + outcome.durationMs + ' ms; ' + (outcome.usage ? 'tokens: ' + outcome.usage.inputTokens + ' in / ' + outcome.usage.outputTokens + ' out' : 'usage unavailable'));
				const output = (options.redact ?? redactSecrets)(outcome.output).slice(0, 16000);
				return { isError: outcome.status !== 'passed' || stopped, content: [{ type: 'text', text: JSON.stringify({ id, implementation: 'ide-readonly-role', profile: request.profile ?? null, model: request.model ?? null, permissions: 'tool-free', durationMs: outcome.durationMs, status: stopped ? 'cancelled' : outcome.status, output, usage: outcome.usage ?? null, scopeVerified: outcome.scopeVerified ?? false, ...(observerFailures ? { diagnostic: 'HARNESS_DELEGATION_OBSERVER_FAILED', observerFailures } : {}) }) }] };
			} catch (error) {
				step('error', /^HARNESS_[A-Z_]+$/.test((error as Error).message) ? (error as Error).message : 'Delegation failed');
				throw error;
			} finally { active--; if (execution) { children.delete(execution); } }
		},
		dispose() { stopped = true; for (const child of children) { child.cancel(); } }
	};
}
