/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Shared Codex read-only child limits (one-shot and app-server).
 * Codex enables `multi_agent` by default, so "off" is an explicit override, never the absence of flags.
 * V2 ignores agents.max_depth; force V1 explicitly so the depth limit is enforced.
 * Never rely on model prompts as a security boundary.
 */

/** Children alive at once; enforced by the Codex CLI. */
export const CODEX_CHILD_CONCURRENCY = 2;
/** Children started or resumed in one turn; enforced by the IDE, because concurrency is not a cumulative bound. */
export const CODEX_CHILD_SPAWNS_PER_TURN = 4;

/** Only `features.*` keys: an older CLI ignores an unknown feature, but rejects an unknown `agents.*` key as a malformed role. */
const DISABLED: readonly string[] = ['--config', 'features.multi_agent=false', '--config', 'features.multi_agent_v2=false'];

export function readonlyCodexSubagentOverrides(enabled: boolean): string[] {
	return enabled ? [
		'--config', 'features.multi_agent_v2=false',
		'--config', 'features.multi_agent=true',
		'--config', 'tools.web_search=false',
		'--config', 'agents.enabled=true',
		'--config', 'agents.max_threads=' + String(CODEX_CHILD_CONCURRENCY),
		'--config', 'agents.max_concurrent_threads_per_session=' + String(CODEX_CHILD_CONCURRENCY),
		'--config', 'agents.max_depth=1',
		'--config', 'agents.interrupt_message=true'
	] : [...DISABLED];
}

/** Collaboration tools that start child work, normalized across both stream spellings (spawnAgent, spawn_agent). */
const SPAWNING_TOOLS: ReadonlySet<string> = new Set(['spawnagent', 'resumeagent']);

export type CodexChildViolation = 'HARNESS_DELEGATION_CHILD_UNEXPECTED' | 'HARNESS_DELEGATION_CHILD_DEPTH' | 'HARNESS_DELEGATION_CHILD_LIMIT';

/** One collaboration tool call, as reported by `codex exec --json` (snake_case) or the app-server (camelCase). */
export interface CodexChildActivity {
	id: string;
	tool: string;
	senderThreadId?: string;
}

/** Reads the collaboration item of either Codex stream; `undefined` for every other item. */
export function codexChildActivity(item: Record<string, unknown> | undefined): CodexChildActivity | undefined {
	if (item?.type !== 'collabAgentToolCall' && item?.type !== 'collab_tool_call') { return undefined; }
	const sender = item.senderThreadId ?? item.sender_thread_id;
	return { id: String(item.id ?? ''), tool: String(item.tool ?? ''), ...(typeof sender === 'string' ? { senderThreadId: sender } : {}) };
}

/**
 * Independent check of what the CLI was configured to enforce. The caller stops the whole provider process
 * on the first violation: a child that should not exist is never left running or reported as a success.
 */
export class CodexChildGuard {
	private readonly enabled: boolean;
	private readonly spawned = new Set<string>();

	constructor(enabled: boolean) { this.enabled = enabled; }

	beginTurn(): void { this.spawned.clear(); }

	observe(activity: CodexChildActivity, rootThreadId?: string): CodexChildViolation | undefined {
		if (!this.enabled) { return 'HARNESS_DELEGATION_CHILD_UNEXPECTED'; }
		if (rootThreadId && activity.senderThreadId && activity.senderThreadId !== rootThreadId) { return 'HARNESS_DELEGATION_CHILD_DEPTH'; }
		if (!SPAWNING_TOOLS.has(activity.tool.replace(/_/g, '').toLowerCase())) { return undefined; }
		this.spawned.add(activity.id);
		return this.spawned.size > CODEX_CHILD_SPAWNS_PER_TURN ? 'HARNESS_DELEGATION_CHILD_LIMIT' : undefined;
	}
}
