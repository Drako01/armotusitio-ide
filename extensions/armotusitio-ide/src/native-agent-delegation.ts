/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Bounded IDE role delegation. Children are read-only one-shot roles, never provider-native subagents. */
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './native-redact.ts';
import type { AgentExecution } from './native-agent-execution.ts';
import type { ChatStep } from './native-run-steps.ts';

export const DELEGATE_TOOL = {
	name: 'delegate_readonly',
	description: 'Ask an IDE planner or reviewer to analyze the context supplied in the instruction. Requires explicit approval for a model call. Same provider/account as parent, with no filesystem, shell, MCP or delegation tools. At most two child launches per session; this is a tool-free IDE role fallback, not provider-native subagents.',
	inputSchema: { type: 'object', properties: { role: { type: 'string', enum: ['planner', 'reviewer'] }, instruction: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['role', 'instruction'], additionalProperties: false }
};
export interface ReadOnlyDelegation { role: 'planner' | 'reviewer'; instruction: string }

/** The launch callback must hold the parent's authority, reserve quota and pin its environment before spawning. */
export function createDelegationBroker(options: {
	enabled(): boolean;
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
				|| input.instruction.length > 8000 || Object.keys(input).some(key => key !== 'role' && key !== 'instruction')) { throw Error('HARNESS_DELEGATION_INPUT_INVALID'); }
			const request: ReadOnlyDelegation = { role: input.role!, instruction: input.instruction };
			const key = JSON.stringify(request);
			if (stopped || !options.enabled() || active >= 2 || attempts >= 2 || denied.has(key)) { throw Error('HARNESS_DELEGATION_LIMIT_OR_DENIED'); }
			active++; // Pending approvals also occupy a slot, so concurrent requests cannot race the bound.
			const id = 'delegate-' + randomUUID();
			const step = (status: ChatStep['status'], detail: string): void => emit({ id, kind: 'tool', label: 'Read-only ' + request.role, status, detail });
			let execution: AgentExecution | undefined;
			try {
				if (!await options.authorize(request)) { denied.add(key); step('error', 'Denied before launch'); throw Error('HARNESS_DELEGATION_DENIED'); }
				if (stopped || !options.enabled() || attempts >= 2) { throw Error('HARNESS_DELEGATION_LIMIT_OR_DENIED'); }
				attempts++; // Failed launches consume the small retry budget too.
				step('running', 'IDE role fallback; independent model call');
				execution = await options.launch(request);
				children.add(execution);
				if (stopped || !options.enabled()) { execution.cancel(); }
				const outcome = await execution.outcome;
				step(outcome.status === 'passed' ? 'ok' : 'error', outcome.status);
				const output = (options.redact ?? redactSecrets)(outcome.output).slice(0, 16000);
				return { isError: outcome.status !== 'passed' || stopped, content: [{ type: 'text', text: JSON.stringify({ id, implementation: 'ide-readonly-role', status: stopped ? 'cancelled' : outcome.status, output, usage: outcome.usage ?? null, scopeVerified: outcome.scopeVerified ?? false, ...(observerFailures ? { diagnostic: 'HARNESS_DELEGATION_OBSERVER_FAILED', observerFailures } : {}) }) }] };
			} catch (error) {
				step('error', /^HARNESS_[A-Z_]+$/.test((error as Error).message) ? (error as Error).message : 'Delegation failed');
				throw error;
			} finally { active--; if (execution) { children.delete(execution); } }
		},
		dispose() { stopped = true; for (const child of children) { child.cancel(); } }
	};
}
