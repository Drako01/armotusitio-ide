/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Native transport of the chat (r8): the bridge between the guarded agent pipeline (`runGuardedAgent`: trust, fence, quota,
 * lease, metrics) and the provider-neutral session runtime. A chat turn becomes one `AgentExecution` over a persistent
 * native session, so the rest of the chat (cards, timeline, verification, diff, undo) does not know which transport or
 * provider ran it. Every dependency on VS Code arrives through `NativeTransportDeps`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureAgentScope, scopeChanged } from './native-agent-scope.ts';
import type { AgentExecution, AgentOutcome, ToolServerLaunch } from './native-agent-execution.ts';
import type { ApprovalAsk } from './native-approval.ts';
import type { CommandPolicy } from './native-command-policy.ts';
import type { PermissionSet } from './native-permissions.ts';
import type { NativeProvider } from './native-providers.ts';
import { redactSecrets } from './native-redact.ts';
import { MAX_STEP_DETAIL, MAX_STEP_LABEL, relativeStepPath, type ChatStep, type ChatStepKind } from './native-run-steps.ts';
import { ClaudeAdapter } from './runtime/claude-adapter.ts';
import { CodexAdapter } from './runtime/codex-adapter.ts';
import type { AgentEvent, AgentQuestion, QuestionAnswers, RuntimeCapabilities, SessionIdentity, SessionRole, ToolCall, TurnResult } from './runtime/contracts.ts';
import { decideProviderCall } from './runtime/provider-policy.ts';
import { AgentSessionManager, type ManagedSession, type RecoveryNotice } from './runtime/session-manager.ts';
import { AgentSessionStore } from './runtime/session-store.ts';

const run = promisify(execFile);
export type TransportSetting = 'structured' | 'native' | 'auto';

/** Hooks of one chat turn: what the user sees and answers while it runs. */
export interface NativeTurnHooks {
	onMessage?(text: string): void;
	onStep?(step: ChatStep): void;
	approval?: ApprovalAsk;
	question?(questions: AgentQuestion[]): Promise<QuestionAnswers | undefined>;
	notice?(notice: RecoveryNotice): void;
}

export interface NativeTransportDeps {
	/** Private per-project storage (the chat's parent directory). */
	storageFor(root: string): string;
	setting(): TransportSetting;
	trusted(root: string): boolean;
	/** Provider environment (toolchain PATH, provider config) and the toolchain caches a writer may also write. */
	environment(provider: NativeProvider): Promise<{ env: NodeJS.ProcessEnv; writableRoots: readonly string[] }>;
	/** The `ats-runner` tool server of a session; `approve`/`question`/`epoch` reach the current turn through these callbacks. */
	toolServer(root: string, provider: NativeProvider, role: SessionRole, channel: { approve: ApprovalAsk; question: NonNullable<NativeTurnHooks['question']>; epoch(): number }): Promise<{ launch: ToolServerLaunch; dispose(): Promise<void> }>;
	/** Policy and permissions of the project, read fresh for each provider-initiated approval. */
	policy(root: string): Promise<{ policy: CommandPolicy; permissions: PermissionSet }>;
	/** Session-level contract and project guidance for this role. */
	instructions(root: string, provider: NativeProvider, role: SessionRole): Promise<string>;
	model(provider: NativeProvider): string | undefined;
	effort(provider: NativeProvider): string | undefined;
	codexFullAccess(): boolean;
	maxTurns(role: SessionRole): number;
	webSearch(root: string): boolean;
	/** Extra redaction for project dev secrets. */
	redact?(text: string): string;
	clientVersion: string;
}

/** Fails closed to the r7 behavior: anything but an exact value keeps the structured transport. */
export function parseTransportSetting(value: unknown): TransportSetting {
	return value === 'native' || value === 'auto' ? value : 'structured';
}

/** Questions a tool server sends through its channel, bounded and validated; `undefined` when malformed. */
export function parseAgentQuestions(params: unknown): AgentQuestion[] | undefined {
	const raw = (params as { questions?: unknown } | undefined)?.questions;
	if (!Array.isArray(raw) || !raw.length || raw.length > 4) { return undefined; }
	const questions: AgentQuestion[] = [];
	for (const item of raw) {
		const value = (item ?? {}) as Partial<AgentQuestion>;
		if (typeof value.id !== 'string' || !/^[\w-]{1,40}$/.test(value.id) || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 1000 ||
			!Array.isArray(value.options) || value.options.length > 8 || !value.options.every(option => typeof option?.label === 'string' && option.label.length <= 200)) { return undefined; }
		questions.push({
			id: value.id, header: typeof value.header === 'string' ? value.header.slice(0, 60) : '', question: value.question,
			options: value.options.map(option => ({ label: option.label, ...(typeof option.description === 'string' ? { description: option.description.slice(0, 400) } : {}) })),
			multiSelect: value.multiSelect === true, allowOther: value.allowOther !== false, secret: value.secret === true
		});
	}
	return questions;
}

const STEP_KINDS: Record<ToolCall['kind'], ChatStepKind> = { command: 'command', file_change: 'edit', read: 'read', web_search: 'search', mcp: 'tool', question: 'tool', permissions: 'tool', other: 'tool' };
const clip = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** The step a tool call shows in the chat timeline; paths are relative to the project. */
export function stepOf(root: string, id: string, call: ToolCall): ChatStep {
	const files = (call.paths ?? []).map(file => relativeStepPath(root, file)).filter(Boolean);
	const label = call.kind === 'command' || call.kind === 'web_search' ? clip(call.command ?? '', MAX_STEP_LABEL)
		: files.length ? clip(files.slice(0, 3).join(', ') + (files.length > 3 ? ' +' + (files.length - 3) : ''), MAX_STEP_LABEL)
			: call.kind === 'mcp' ? clip([call.server, call.tool].filter(Boolean).join('.'), MAX_STEP_LABEL) : clip(call.name, MAX_STEP_LABEL);
	return { id, kind: STEP_KINDS[call.kind], label: label || call.name, status: 'running' };
}

/** AgentOutcome of a native turn, in the same terms as the structured transport. */
export function outcomeOf(result: TurnResult & { nativeSessionId: string }, durationMs: number, timedOut: boolean, redact: (text: string) => string): AgentOutcome {
	const status: AgentOutcome['status'] = timedOut ? 'timeout' : result.status === 'completed' && !result.stopReason ? 'passed' : result.status === 'interrupted' ? 'cancelled' : 'failed';
	return {
		status, exitCode: result.status === 'completed' ? 0 : null, durationMs, output: redact(result.output || (result.error ?? '')), truncated: false, structuredOutput: true,
		...(result.usage ? { usage: result.usage } : {}), ...(result.quota ? { quota: result.quota } : {}), ...(result.stopReason ? { stopReason: result.stopReason } : {}),
		...(result.error === 'RUNTIME_RATE_LIMITED' ? { rateLimited: true as const } : {}), ...(result.nativeSessionId ? { sessionId: result.nativeSessionId } : {})
	};
}

export class NativeChatTransport {
	private readonly deps: NativeTransportDeps;
	private readonly managers = new Map<string, AgentSessionManager>();
	private readonly turnHooks = new Map<string, NativeTurnHooks>();
	private readonly worktrees = new Map<string, Promise<string>>();
	private readonly recovered = new Map<string, Promise<unknown>>();
	private readonly adapters = [new ClaudeAdapter(), new CodexAdapter()];
	private readonly capabilities = new Map<NativeProvider, Promise<RuntimeCapabilities>>();

	constructor(deps: NativeTransportDeps) { this.deps = deps; }

	/**
	 * Whether this provider runs natively now. `auto` requires a compatible installed CLI; `native` uses it too, and says why
	 * when it cannot. Never silently less safe: an incompatible CLI falls back to the structured transport, which is stricter.
	 */
	async decide(provider: NativeProvider): Promise<{ native: boolean; reason?: string; capabilities?: RuntimeCapabilities }> {
		const setting = this.deps.setting();
		if (setting === 'structured') { return { native: false }; }
		try {
			// Probed once per IDE session (no tokens); a failed probe is retried next time.
			let probe = this.capabilities.get(provider);
			if (!probe) {
				const env = (await this.deps.environment(provider)).env;
				probe = this.adapters.find(adapter => adapter.provider === provider)!.capabilities(env);
				this.capabilities.set(provider, probe);
				probe.catch(() => this.capabilities.delete(provider));
			}
			const capabilities = await probe;
			return capabilities.compatible ? { native: true, capabilities } : { native: false, reason: capabilities.incompatibility, capabilities };
		} catch {
			return { native: false, reason: 'RUNTIME_CAPABILITIES_UNAVAILABLE' };
		}
	}

	/** Reference of the last input a completed turn delivered to this conversation's native session (chat message id). */
	async lastInputRef(root: string, provider: NativeProvider, conversationId: string): Promise<string | undefined> {
		const session = await this.session(root, provider, conversationId);
		return (await this.manager(root).store.get(session.key))?.lastInputRef;
	}

	/** One chat turn over the persistent native session, as an `AgentExecution` for the guarded pipeline. */
	/** `freshText`: the full input, used instead of a follow-up `text` when the provider had to start a new session. */
	async execute(request: { root: string; provider: NativeProvider; conversationId: string; role: SessionRole; text: string; freshText?: string; inputRef?: string; durationMs: number }, hooks: NativeTurnHooks): Promise<AgentExecution> {
		const { root, role } = request;
		const session = await this.session(root, request.provider, request.conversationId);
		const redact = (text: string): string => this.deps.redact ? this.deps.redact(redactSecrets(text)) : redactSecrets(text);
		const scope = role === 'conversation' ? await captureAgentScope(root) : undefined;
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.durationMs);
		timer.unref();
		this.turnHooks.set(session.key, hooks);
		const steps = new Map<string, ChatStep>();
		const unsubscribe = session.bridge.subscribe(event => this.forward(root, event, hooks, redact, steps));
		const stopNotices = session.onNotice(notice => hooks.notice?.(notice));
		const started = Date.now();
		const outcome = (async (): Promise<AgentOutcome> => {
			try {
				const result = await session.runTurn(request.text, role, controller.signal, request.inputRef, request.freshText);
				const outcome = outcomeOf(result, Date.now() - started, timedOut, redact);
				if (scope) {
					// A conversation is read-only: a changed tree fails the turn, exactly like the structured transport.
					try {
						const after = await captureAgentScope(root);
						const violation = scopeChanged(scope, after);
						const unscanned = [...new Set([...scope.unscanned, ...after.unscanned])].sort();
						return { ...outcome, ...(violation ? { status: 'failed' as const } : {}), scopeViolation: violation, scopeVerified: scope.source === 'git' && after.source === 'git', ...(unscanned.length ? { scopeUnscanned: unscanned } : {}) };
					} catch {
						return { ...outcome, status: 'failed' };
					}
				}
				return outcome;
			} catch (error) {
				const code = (error as { code?: string }).code ?? 'RUNTIME_TURN_FAILED';
				if (code === 'RUNTIME_CANCELLED_BEFORE_START') { throw Error('HARNESS_CANCELLED_BEFORE_START'); }
				return { status: timedOut ? 'timeout' : 'failed', exitCode: null, durationMs: Date.now() - started, output: code, truncated: false, structuredOutput: false };
			} finally {
				clearTimeout(timer);
				unsubscribe();
				stopNotices();
				if (this.turnHooks.get(session.key) === hooks) { this.turnHooks.delete(session.key); }
			}
		})();
		return { outcome, cancel: () => controller.abort() };
	}

	/** Branch the conversation's native session (Bifurcar); the chat keeps its history, the provider gets a fork. */
	async fork(root: string, provider: NativeProvider, conversationId: string, newConversationId: string): Promise<void> {
		const identity = await this.identity(root, provider, conversationId);
		await this.manager(root).fork(identity, newConversationId);
	}

	/** Startup reconciliation of one project: turns cut off by a previous IDE process, reported once. */
	recover(root: string): Promise<unknown> {
		let pending = this.recovered.get(root);
		if (!pending) { pending = this.manager(root).recover(); this.recovered.set(root, pending); }
		return pending;
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.managers.values()].map(manager => manager.dispose()));
		this.managers.clear();
	}

	/** Adapter events to the chat's hooks: partial text, and timeline steps merged by tool call id. */
	private forward(root: string, event: AgentEvent, hooks: NativeTurnHooks, redact: (text: string) => string, steps: Map<string, ChatStep>): void {
		const payload = event.payload;
		const put = (id: string, patch: Partial<ChatStep>): void => {
			const known = steps.get(id);
			if (!known && !patch.kind) { return; }
			const next: ChatStep = Object.assign({}, known, patch);
			steps.set(id, next);
			hooks.onStep?.({ ...next });
		};
		switch (payload.type) {
			case 'message.delta':
			case 'message.completed':
				hooks.onMessage?.(redact(payload.text));
				return;
			case 'tool.started':
				if (event.toolCallId) { put(event.toolCallId, stepOf(root, event.toolCallId, payload.call)); }
				return;
			case 'tool.output':
				if (event.toolCallId) {
					const line = payload.chunk.split('\n').map(item => item.trim()).filter(Boolean).at(-1);
					if (line) { put(event.toolCallId, { detail: clip(redact(line), MAX_STEP_DETAIL) }); }
				}
				return;
			case 'tool.completed':
				if (event.toolCallId) { put(event.toolCallId, { status: payload.status === 'completed' ? 'ok' : 'error', ...(payload.detail ? { detail: clip(redact(payload.detail), MAX_STEP_DETAIL) } : payload.exitCode ? { detail: 'exit ' + payload.exitCode } : {}) }); }
				return;
			default:
				return;
		}
	}

	private async identity(root: string, provider: NativeProvider, conversationId: string): Promise<SessionIdentity> {
		let worktree = this.worktrees.get(root);
		if (!worktree) {
			// The git common directory + this checkout: two worktrees of one repository never share a session.
			worktree = run('git', ['rev-parse', '--git-common-dir'], { cwd: root, windowsHide: true, timeout: 10_000 })
				.then(result => result.stdout.trim() + '|' + root, () => root);
			this.worktrees.set(root, worktree);
		}
		return { root, worktree: await worktree, provider, conversationId };
	}

	private async session(root: string, provider: NativeProvider, conversationId: string): Promise<ManagedSession> {
		await this.recover(root);
		return this.manager(root).session(await this.identity(root, provider, conversationId));
	}

	/** One manager per project storage (the registry file lives next to the project's chat). */
	private manager(root: string): AgentSessionManager {
		const key = root;
		let manager = this.managers.get(key);
		if (!manager) {
			const deps = this.deps;
			const hooksOf = (session: ManagedSession) => this.turnHooks.get(session.key);
			manager = new AgentSessionManager(new AgentSessionStore(deps.storageFor(root)), [new ClaudeAdapter(), new CodexAdapter({ fullAccess: () => deps.codexFullAccess(), clientVersion: deps.clientVersion })], {
				async prepare(identity, role) {
					const { env, writableRoots } = await deps.environment(identity.provider);
					// The handle exists before its process: the tool server reaches the current turn through it.
					const session = await managerOf().session(identity);
					const current = (): NativeTurnHooks | undefined => session && hooksOf(session);
					const server = await deps.toolServer(identity.root, identity.provider, role, {
						approve: async draft => {
							const hooks = current();
							if (!hooks?.approval || !session) { return 'deny'; }
							return session.awaitUser('approval', () => hooks.approval!(draft), answer => answer !== 'deny');
						},
						question: async questions => {
							const hooks = current();
							if (!hooks?.question || !session) { return undefined; }
							return session.awaitUser('question', () => hooks.question!(questions), answers => !!answers);
						},
						epoch: () => session?.turnNumber ?? 0
					});
					return {
						options: {
							instructions: await deps.instructions(identity.root, identity.provider, role), env, writableRoots, toolServer: server.launch,
							model: deps.model(identity.provider), effort: deps.effort(identity.provider), maxTurns: deps.maxTurns(role), webSearch: deps.webSearch(identity.root)
						},
						dispose: () => server.dispose()
					};
				},
				async approve(session, call) {
					const hooks = hooksOf(session);
					const { policy, permissions } = await deps.policy(session.identity.root);
					return decideProviderCall({
						root: session.identity.root, policy, permissions, sandboxed: !deps.codexFullAccess(), trusted: () => deps.trusted(session.identity.root),
						ask: async draft => hooks?.approval ? hooks.approval(draft) : 'deny'
					}, call);
				},
				async ask(session, questions) {
					const hooks = hooksOf(session);
					return hooks?.question ? hooks.question(questions) : undefined;
				}
			}, { retryDelayMs: 1000 });
			const managerOf = () => manager!;
			this.managers.set(key, manager);
		}
		return manager;
	}
}
