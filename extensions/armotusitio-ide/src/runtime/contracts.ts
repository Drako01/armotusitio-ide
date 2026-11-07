/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Provider-neutral contracts of the native agent runtime (r8). The chat and the session manager only see these types; each
 * provider adapter (Claude CLI stream-json, Codex app-server) translates its own protocol into them and keeps the raw
 * events in a bounded diagnostic channel. Nothing here depends on VS Code.
 */
import { createHash } from 'node:crypto';
import type { NativeProvider } from '../native-providers.ts';
import type { ProviderUsage } from '../native-provider-output.ts';
import type { ProviderQuota } from '../native-quota.ts';

export type SessionState = 'starting' | 'ready' | 'running' | 'awaiting_approval' | 'awaiting_user_input' | 'interrupted' | 'recovering' | 'failed' | 'closed';

/** Allowed lifecycle transitions; anything else is a bug and is rejected by the session manager. */
export const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
	starting: ['ready', 'failed', 'closed', 'recovering'],
	ready: ['running', 'closed', 'failed', 'recovering', 'starting'],
	running: ['awaiting_approval', 'awaiting_user_input', 'ready', 'interrupted', 'failed', 'closed', 'recovering'],
	awaiting_approval: ['running', 'interrupted', 'failed', 'closed', 'recovering'],
	awaiting_user_input: ['running', 'interrupted', 'failed', 'closed', 'recovering'],
	interrupted: ['ready', 'running', 'closed', 'recovering', 'starting', 'failed'],
	recovering: ['ready', 'failed', 'closed', 'starting'],
	failed: ['starting', 'recovering', 'closed'],
	closed: ['starting', 'recovering']
};

/** Who the session works as: a read-only conversation (plans, answers) or a writer that changes the project. */
export type SessionRole = 'conversation' | 'writer';

/**
 * A session belongs to exactly one project checkout: canonical root + git worktree identity + provider + conversation. Two
 * windows or two roots never share a session, and a native id is never transferred to another provider.
 */
export interface SessionIdentity {
	root: string;
	/** Git common directory + worktree path, or the root itself outside git. */
	worktree: string;
	provider: NativeProvider;
	conversationId: string;
}

export function sessionKey(identity: SessionIdentity): string {
	return createHash('sha256').update([identity.root, identity.worktree, identity.provider, identity.conversationId].join('\u0000')).digest('hex').slice(0, 32);
}

/** What a tool call does, normalized across providers for policy, cards and the timeline. */
export interface ToolCall {
	kind: 'command' | 'file_change' | 'read' | 'mcp' | 'web_search' | 'question' | 'permissions' | 'other';
	/** Provider tool name (`Bash`, `commandExecution`, `mcp__ats-runner__run`, ...). */
	name: string;
	command?: string;
	cwd?: string;
	paths?: string[];
	server?: string;
	tool?: string;
	/** The provider's own justification (Codex `reason`), shown on the card. */
	reason?: string;
}

/** One option of an agent question. */
export interface QuestionOption { label: string; description?: string }
/** A question the agent asks the user mid-turn (Claude `AskUserQuestion`, Codex `requestUserInput`). */
export interface AgentQuestion {
	id: string;
	header: string;
	question: string;
	options: QuestionOption[];
	multiSelect: boolean;
	/** The user may type a free answer. */
	allowOther: boolean;
	/** The answer is a secret: it goes to the provider and is never stored or logged by the IDE. */
	secret: boolean;
}
/** Answers by question id; each answer is one or more option labels or free text. */
export type QuestionAnswers = Record<string, string[]>;

export type TurnStatus = 'completed' | 'interrupted' | 'failed';
export type ToolStatus = 'completed' | 'failed' | 'declined';

export type AgentEventPayload =
	| { type: 'session.ready'; nativeSessionId: string; resumed: boolean; model?: string }
	| { type: 'state'; state: SessionState; detail?: string }
	| { type: 'turn.started' }
	| { type: 'message.delta'; itemId: string; text: string }
	| { type: 'message.completed'; itemId: string; text: string }
	| { type: 'tool.started'; call: ToolCall }
	| { type: 'tool.output'; chunk: string }
	| { type: 'tool.completed'; status: ToolStatus; exitCode?: number; detail?: string }
	| { type: 'approval.requested'; call: ToolCall }
	| { type: 'approval.resolved'; allowed: boolean }
	| { type: 'question.requested'; questions: AgentQuestion[] }
	| { type: 'question.resolved'; answered: boolean }
	| { type: 'usage'; usage?: ProviderUsage; quota?: ProviderQuota }
	| { type: 'turn.completed'; status: TurnStatus; output: string; error?: string; stopReason?: 'max-turns' }
	| { type: 'diagnostic'; source: string; text: string };

export interface AgentEvent {
	eventId: string;
	sessionId: string;
	turnId?: string;
	toolCallId?: string;
	sequence: number;
	timestamp: number;
	payload: AgentEventPayload;
}

/** What the adapter reports; the bridge adds identity, order and dedup. `nativeKey` dedups replays of the same native event. */
export interface AdapterEvent {
	turnId?: string;
	toolCallId?: string;
	nativeKey?: string;
	payload: AgentEventPayload;
}

/** The decision for a provider permission prompt, already through the IDE's policy and the user's card. */
export interface ApprovalVerdict {
	allowed: boolean;
	/** How long the user allowed it; adapters translate only what the provider really supports. */
	scope: 'once' | 'task' | 'session' | 'always';
	/** Text the model receives on a denial (`POLICY_DENIED: ...`, `DENIED: ...`). */
	reason?: string;
}

/** Services the runtime gives an adapter for one connection. Every callback fails closed. */
export interface AdapterHost {
	emit(event: AdapterEvent): void;
	/** Decide one tool call the provider asks about (Codex server requests). */
	approve(call: ToolCall, turnId: string | undefined): Promise<ApprovalVerdict>;
	/** Ask the user; `undefined` = not answered (cancelled, timed out, no UI). */
	ask(questions: AgentQuestion[], turnId: string | undefined): Promise<QuestionAnswers | undefined>;
}

export interface TurnInput {
	/** The user's text for this turn (the conversation contract is sent once, when the session starts). */
	text: string;
	/** Client-side id written to the journal before the turn starts; the provider never sees it as content. */
	clientTurnId: string;
	role: SessionRole;
}

export interface TurnResult {
	turnId: string;
	status: TurnStatus;
	output: string;
	error?: string;
	usage?: ProviderUsage;
	quota?: ProviderQuota;
	stopReason?: 'max-turns';
}

export interface SessionOpenOptions {
	identity: SessionIdentity;
	role: SessionRole;
	/** Resume this provider session/thread instead of starting a new one. */
	resume?: string;
	/** Fork `resume` into a new native session (the original stays untouched). */
	fork?: boolean;
	/** Role contract and project guidance, sent once per native session. */
	instructions: string;
	model?: string;
	effort?: string;
	/** The IDE's `ats-runner` tool server for this session (MCP config file for Claude, launch for Codex). */
	toolServer?: { command: string; args: string[]; env: Record<string, string>; mcpConfigFile: string };
	/** Writable roots beyond the project (toolchain caches), for the provider sandbox. */
	writableRoots?: readonly string[];
	env: NodeJS.ProcessEnv;
	maxTurns?: number;
	webSearch?: boolean;
}

/** A live provider connection. `startTurn` resolves when the turn ends; events stream through the host meanwhile. */
export interface AgentConnection {
	readonly nativeSessionId: string;
	readonly resumed: boolean;
	startTurn(input: TurnInput): Promise<TurnResult>;
	/** Add input to the running turn, when the provider supports it (Codex `turn/steer`). */
	steer?(text: string): Promise<boolean>;
	/** Stop the running turn; the session stays resumable. */
	interrupt(): Promise<void>;
	close(): Promise<void>;
	/** Resolves when the provider process ends, for whatever reason. */
	readonly exited: Promise<{ code: number | null; expected: boolean }>;
}

export type CapabilityLevel = 'supported' | 'experimental' | 'unavailable';
export interface RuntimeCapabilities {
	provider: NativeProvider;
	version: string;
	transport: 'stream-json' | 'app-server';
	/** The installed version speaks the protocol this build was generated or validated for. */
	compatible: boolean;
	/** Why it is not compatible, in user terms. */
	incompatibility?: string;
	features: Record<'session' | 'streaming' | 'resume' | 'fork' | 'interrupt' | 'steer' | 'approvals' | 'questions' | 'commandOutput' | 'mcp' | 'usage', CapabilityLevel>;
}

export interface AgentAdapter {
	readonly provider: NativeProvider;
	capabilities(env: NodeJS.ProcessEnv): Promise<RuntimeCapabilities>;
	open(options: SessionOpenOptions, host: AdapterHost): Promise<AgentConnection>;
}

/** Errors with a stable code; the message never contains provider output or secrets. */
export class RuntimeError extends Error {
	readonly code: string;
	readonly recoverable: boolean;
	constructor(code: string, recoverable = false) { super(code); this.code = code; this.recoverable = recoverable; }
}
