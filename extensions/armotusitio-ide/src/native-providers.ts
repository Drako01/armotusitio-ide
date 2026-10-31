/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Explicit agent review and handoff validation. No provider process is started here. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { validateNativePlan, type Plan } from './native-harness.ts';

export type NativeProvider = 'codex' | 'claude';
/** Per-invocation effort; unsupported combinations are rejected by the selected CLI. */
export type NativeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentRole = 'planner' | 'implementer' | 'reviewer';
export interface AgentDraft {
	schemaVersion: 1;
	provider: NativeProvider;
	role: AgentRole;
	projectRoot: string;
	instruction: string;
	readOnly: boolean;
	/** Explicit model; absent means the provider CLI default. */
	model?: string;
	/** Explicit reasoning effort; absent preserves the provider CLI setting. */
	effort?: NativeEffort;
}
export interface AgentReview {
	draft: AgentDraft;
	fingerprint: string;
	argv: readonly string[];
	capabilities: readonly string[];
	warnings: readonly string[];
}
export interface Handoff {
	id: string;
	role: AgentRole;
	provider: NativeProvider;
	dependsOn: string[];
	instruction: string;
}
export interface HandoffPlan { schemaVersion: 1; handoffs: Handoff[] }

const MAX_INSTRUCTION = 16 * 1024;
const IGNORED = new Set(['node_modules', '.git', '.env', 'dist', 'build', '.harness']);
const ROLES: readonly AgentRole[] = ['planner', 'implementer', 'reviewer'];
const PROVIDERS: readonly NativeProvider[] = ['codex', 'claude'];
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

/** A model id or alias passed as a CLI argument: it can never start like a flag. */
export function validModel(value: unknown): value is string {
	return typeof value === 'string' && MODEL.test(value);
}
/** Draft fields for an optional model: absent keeps the CLI default and the draft fingerprint unchanged. */
export function modelOption(model: string | undefined): { model?: string } {
	return model ? { model } : {};
}

/** Known CLI effort levels, never forwarded as unvalidated command-line data. */
export function validEffort(provider: NativeProvider, value: unknown): value is NativeEffort {
	return typeof value === 'string' && (['low', 'medium', 'high', 'xhigh'].includes(value) || (provider === 'claude' && value === 'max'));
}
export function effortOption(effort: NativeEffort | undefined): { effort?: NativeEffort } {
	return effort ? { effort } : {};
}

export function validateAgentDraft(input: unknown): AgentDraft {
	if (!input || typeof input !== 'object' || Array.isArray(input)) { throw Error('HARNESS_AGENT_DRAFT_SCHEMA'); }
	const value = input as AgentDraft;
	if (value.schemaVersion !== 1 || !PROVIDERS.includes(value.provider) || !ROLES.includes(value.role)
		|| typeof value.projectRoot !== 'string' || !path.isAbsolute(value.projectRoot)
		|| typeof value.instruction !== 'string' || !value.instruction.trim()
		|| Buffer.byteLength(value.instruction, 'utf8') > MAX_INSTRUCTION || typeof value.readOnly !== 'boolean'
		|| value.instruction.includes('\0') || value.projectRoot.includes('\0')
		|| (value.model !== undefined && !validModel(value.model))
		|| (value.effort !== undefined && !validEffort(value.provider, value.effort))) {
		throw Error('HARNESS_AGENT_DRAFT_SCHEMA');
	}
	return value;
}

export function reviewAgentDraft(input: unknown): AgentReview {
	const draft = validateAgentDraft(input);
	const fingerprint = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
	return {
		draft: Object.freeze({ ...draft }), fingerprint,
		argv: Object.freeze([]),
		capabilities: Object.freeze(['explicit-review', 'no-shell', 'workspace-trust', 'manual-provider-setup']),
		warnings: Object.freeze(['Provider CLI flags and permissions must be checked against the installed version before execution',
			'No model, Git or shell command is started by this review']),
	};
}

export function validateReviewedAgent(review: AgentReview, current: AgentDraft): void {
	const expected = reviewAgentDraft(current);
	if (expected.fingerprint !== review.fingerprint || review.draft.provider !== current.provider || review.draft.projectRoot !== current.projectRoot) {
		throw Error('HARNESS_AGENT_REVIEW_CHANGED');
	}
}

export function validateHandoffPlan(plan: HandoffPlan): HandoffPlan {
	if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.handoffs) || plan.handoffs.length < 1 || plan.handoffs.length > 16) {
		throw Error('HARNESS_HANDOFF_SCHEMA');
	}
	const seen = new Set<string>();
	for (const h of plan.handoffs) {
		if (!h || !/^[a-z][a-z0-9_-]{0,63}$/.test(h.id) || seen.has(h.id)
			|| !ROLES.includes(h.role) || !PROVIDERS.includes(h.provider)
			|| !Array.isArray(h.dependsOn) || h.dependsOn.length > 16 || !h.dependsOn.every(x => typeof x === 'string')
			|| typeof h.instruction !== 'string' || !h.instruction.trim() || Buffer.byteLength(h.instruction, 'utf8') > MAX_INSTRUCTION) {
			throw Error('HARNESS_HANDOFF_SCHEMA');
		}
		seen.add(h.id);
	}
	const nodes = new Map(plan.handoffs.map(h => [h.id, h]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const check = (id: string): void => {
		if (visiting.has(id)) { throw Error('HARNESS_HANDOFF_CYCLE'); }
		if (visited.has(id)) { return; }
		const h = nodes.get(id);
		if (!h) { throw Error('HARNESS_HANDOFF_DEPENDENCY'); }
		visiting.add(id);
		for (const dep of h.dependsOn) { check(dep); }
		visiting.delete(id);
		visited.add(id);
	};
	for (const h of plan.handoffs) { check(h.id); }
	return plan;
}

export async function inspectAgentWorkspace(root: string): Promise<{ root: string; topLevel: string[] }> {
	const canonical = await fs.realpath(root);
	const names: string[] = [];
	for (const entry of await fs.readdir(canonical, { withFileTypes: true })) {
		if (names.length >= 64) { break; }
		if (entry.isSymbolicLink() || IGNORED.has(entry.name) || entry.name.startsWith('.')) { continue; }
		if (entry.isDirectory() || entry.isFile()) { names.push(entry.name); }
	}
	return { root: canonical, topLevel: names.sort() };
}

/** Local checks only. This function must not invoke a model or an external provider. */
export function localVerificationPlan(commands: { executable: string; args: string[] }[]): Plan {
	const plan: Plan = {
		schemaVersion: 1,
		gates: commands.map((command, index) => ({ id: `gate_${index}`, executable: command.executable, args: command.args, cwd: '.' })),
	};
	validateNativePlan(plan);
	return plan;
}
