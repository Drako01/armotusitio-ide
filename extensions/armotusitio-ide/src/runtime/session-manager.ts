/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * AgentSessionManager: identity, lifecycle and durability of native agent sessions, independent of the provider. It owns
 * the journal (written before a turn starts), the state machine, reconnection and recovery. A turn cut off by a crash or a
 * restart is reported as lost and never replayed; the next turn resumes the native session by id. A native id that the
 * provider no longer knows starts a new session with an explicit handoff notice, never with invented history.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { NativeProvider } from '../native-providers.ts';
import { validateChatImages, type ChatImage } from '../native-chat-images.ts';
import {
	RuntimeError, SESSION_TRANSITIONS, sessionKey, type AdapterHost, type AgentAdapter, type AgentConnection, type AgentEvent, type AgentQuestion,
	type ApprovalVerdict, type QuestionAnswers, type RuntimeCapabilities, type SessionIdentity, type SessionOpenOptions, type SessionRole, type SessionState, type ToolCall, type TurnResult
} from './contracts.ts';
import { EventBridge } from './event-bridge.ts';
import { ProviderRequestError } from './json-rpc.ts';
import { digestInput, type AgentSessionStore, type SessionRecord, type TurnJournalEntry } from './session-store.ts';

/** What the IDE provides for each connection: launch options per role, and the policy + UI for approvals and questions. */
export interface SessionServices {
	/** Launch options for this identity and role (instructions, tool server, env, model, effort); `dispose` runs after the process ends. */
	prepare(identity: SessionIdentity, role: SessionRole): Promise<{ options: Omit<SessionOpenOptions, 'identity' | 'role' | 'resume' | 'fork'>; dispose(): Promise<void> }>;
	/** Provider-initiated approval (Codex): IDE policy, broker grants and the user's card. Must not throw. */
	approve(session: ManagedSession, call: ToolCall, turnId: string | undefined): Promise<ApprovalVerdict>;
	ask(session: ManagedSession, questions: AgentQuestion[], turnId: string | undefined): Promise<QuestionAnswers | undefined>;
}

export interface ManagerOptions {
	/** Delay before the single automatic retry of a failed start (R06). */
	retryDelayMs?: number;
}

/** A recovery the user must know about (shown as a notice in the chat). */
export interface RecoveryNotice { kind: 'lost-turn' | 'new-session' | 'resumed' | 'quarantined'; detail?: string }

/** Provider answers that mean "this session/thread id does not exist (any more)". */
const UNKNOWN_SESSION = /not found|no (?:such )?(?:conversation|session|thread)|unknown (?:thread|session)|does not exist|invalid (?:thread|session)/i;

export class ManagedSession {
	readonly key: string;
	readonly identity: SessionIdentity;
	readonly bridge: EventBridge;
	private stateValue: SessionState = 'closed';
	private connection?: AgentConnection;
	private connectionRole?: SessionRole;
	private dispose?: () => Promise<void>;
	private running?: { clientTurnId: string; promise: Promise<TurnResult> };
	private readonly manager: AgentSessionManager;
	private readonly listeners = new Set<(notice: RecoveryNotice) => void>();
	/** Approvals and questions in flight, so state returns to `running` only when the last one is answered. */
	private waiting = 0;
	private turns = 0;
	/** Registry writes triggered by provider events, chained so they never overtake each other. */
	private writes: Promise<void> = Promise.resolve();
	/** This handle already delivered a turn on its current native session, so later turns continue it. */
	private continued = false;

	constructor(manager: AgentSessionManager, identity: SessionIdentity, cursor: number) {
		this.manager = manager;
		this.identity = identity;
		this.key = sessionKey(identity);
		this.bridge = new EventBridge(this.key, cursor);
	}

	get state(): SessionState { return this.stateValue; }
	get busy(): boolean { return !!this.running; }
	/** Turns started by this handle; the tool server uses it to scope refusals and budgets to one turn. */
	get turnNumber(): number { return this.turns; }

	onNotice(listener: (notice: RecoveryNotice) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Run one turn: journal, connect (resume / reopen for another role), stream, and record the end. Never replays input. */
	async runTurn(text: string, role: SessionRole, signal?: AbortSignal, inputRef?: string, freshText?: string, images?: readonly ChatImage[]): Promise<TurnResult & { nativeSessionId: string }> {
		if (images) { validateChatImages(images); }
		if (this.running) { throw new RuntimeError('RUNTIME_TURN_ALREADY_RUNNING'); }
		if (signal?.aborted) { throw new RuntimeError('RUNTIME_CANCELLED_BEFORE_START'); }
		const clientTurnId = randomUUID();
		this.turns++;
		const entry: TurnJournalEntry = { clientTurnId, role, status: 'pending', inputDigest: digestInput(text), startedAt: new Date().toISOString(), pid: process.pid };
		await this.manager.store.update(this.key, record => {
			const current = record ?? this.manager.newRecord(this.identity);
			current.journal.push(entry);
			return current;
		});
		const settle = async (result: TurnResult): Promise<TurnResult & { nativeSessionId: string }> => {
			await this.writes;
			const status = result.error === 'RUNTIME_CONNECTION_LOST' ? 'lost' as const : result.status;
			await this.journal(clientTurnId, { status, endedAt: new Date().toISOString(), ...(result.error ? { error: result.error } : {}), ...(result.turnId ? { turnId: result.turnId } : {}) }, status === 'completed' ? inputRef : undefined);
			if (status === 'lost') { await this.dropConnection(); this.transition('interrupted', 'connection lost'); }
			else { this.transition(result.status === 'interrupted' ? 'interrupted' : 'ready'); }
			return { ...result, nativeSessionId: this.connection?.nativeSessionId ?? (await this.manager.store.get(this.key))?.nativeSessionId ?? '' };
		};
		try {
			const connection = await this.connect(role, signal);
			if (signal?.aborted) {
				await this.journal(clientTurnId, { status: 'interrupted', endedAt: new Date().toISOString() });
				this.transition('ready');
				throw new RuntimeError('RUNTIME_CANCELLED_BEFORE_START');
			}
			await this.journal(clientTurnId, { status: 'running' });
			this.transition('running');
			// A follow-up written for an existing native session is replaced by the full input when the provider had to start over.
			const promise = connection.startTurn({ text: freshText && !connection.resumed && !this.continued ? freshText : text, clientTurnId, role, ...(images?.length ? { images } : {}) });
			this.continued = true;
			this.running = { clientTurnId, promise };
			const abort = () => { void connection.interrupt(); };
			signal?.addEventListener('abort', abort, { once: true });
			try { return await settle(await promise); }
			finally { signal?.removeEventListener('abort', abort); }
		} catch (error) {
			if (error instanceof RuntimeError && error.code === 'RUNTIME_CANCELLED_BEFORE_START') { throw error; }
			await this.journal(clientTurnId, { status: 'failed', endedAt: new Date().toISOString(), error: error instanceof RuntimeError ? error.code : 'RUNTIME_TURN_FAILED' });
			if (this.stateValue !== 'failed') { this.transition(this.connection ? 'ready' : 'failed'); }
			throw error;
		} finally {
			this.running = undefined;
		}
	}

	/** Add input to the running turn when the provider supports it; `false` means "queue it for the next turn". */
	async steer(text: string): Promise<boolean> {
		if (!this.running || !this.connection?.steer) { return false; }
		return this.connection.steer(text);
	}

	async interrupt(): Promise<void> { await this.connection?.interrupt(); }

	/** End the process; the native session stays resumable from the registry. */
	async close(): Promise<void> {
		await this.dropConnection();
		if (this.stateValue !== 'closed') { this.transition('closed'); }
	}

	/** Track an approval or question so the state says the session waits for the user (both providers use this). */
	async awaitUser<T>(kind: 'approval' | 'question', work: () => Promise<T>, accepted: (result: T) => boolean, turnId?: string, call?: ToolCall): Promise<T> {
		this.waiting++;
		if (this.stateValue === 'running') { this.transition(kind === 'approval' ? 'awaiting_approval' : 'awaiting_user_input'); }
		if (kind === 'approval' && call) { this.publish({ turnId, payload: { type: 'approval.requested', call } }); }
		let yes = false;
		try {
			const result = await work();
			yes = accepted(result);
			return result;
		} finally {
			this.waiting--;
			this.publish({ turnId, payload: kind === 'approval' ? { type: 'approval.resolved', allowed: yes } : { type: 'question.resolved', answered: yes } });
			if (!this.waiting && (this.stateValue === 'awaiting_approval' || this.stateValue === 'awaiting_user_input')) { this.transition('running'); }
		}
	}

	notify(notice: RecoveryNotice): void {
		for (const listener of this.listeners) {
			try { listener(notice); } catch { /* Observers never break recovery. */ }
		}
	}

	private publish(event: Parameters<EventBridge['publish']>[0]): AgentEvent | undefined { return this.bridge.publish(event); }

	private transition(next: SessionState, detail?: string): void {
		if (next === this.stateValue) { return; }
		if (!SESSION_TRANSITIONS[this.stateValue].includes(next)) { throw new RuntimeError('RUNTIME_INVALID_TRANSITION'); }
		this.stateValue = next;
		this.publish({ payload: { type: 'state', state: next, ...(detail ? { detail } : {}) } });
	}

	/** `delivered`: the caller's reference of an input the provider has now fully received (a completed turn). */
	private async journal(clientTurnId: string, patch: Partial<TurnJournalEntry>, delivered?: string): Promise<void> {
		await this.manager.store.update(this.key, record => {
			if (!record) { return record; }
			if (delivered) { record.lastInputRef = delivered; }
			const entry = record.journal.find(item => item.clientTurnId === clientTurnId);
			if (entry) { Object.assign(entry, patch); }
			record.state = this.stateValue === 'closed' ? record.state : this.stateValue;
			record.cursor = this.bridge.cursor;
			return record;
		});
	}

	/** A live connection for `role`: reuse, reopen for another role, resume by native id, or start a new session. */
	private async connect(role: SessionRole, signal?: AbortSignal): Promise<AgentConnection> {
		if (this.connection && this.connectionRole === role) { return this.connection; }
		if (this.connection) { await this.dropConnection(); }
		this.transition(this.stateValue === 'closed' || this.stateValue === 'failed' ? 'starting' : 'recovering');
		const record = await this.manager.store.get(this.key);
		// A fork's first connection branches from the source session; later ones resume the fork's own id.
		const fork = !record?.nativeSessionId && !!record?.forkedFrom;
		const resume = record?.nativeSessionId ?? record?.forkedFrom;
		let attempt = 0;
		for (; ;) {
			try {
				const connection = await this.open(role, resume, fork);
				if (resume && connection.nativeSessionId === resume) { this.notify({ kind: 'resumed' }); }
				return connection;
			} catch (error) {
				if (signal?.aborted) { this.transition('failed'); throw new RuntimeError('RUNTIME_CANCELLED_BEFORE_START'); }
				// The stored id is unknown to the provider (expired, deleted, other machine): start fresh, say so (R08).
				if (resume && error instanceof ProviderRequestError && UNKNOWN_SESSION.test(error.providerMessage)) {
					await this.manager.store.update(this.key, current => current && { ...current, nativeSessionId: undefined, forkedFrom: undefined, lastInputRef: undefined });
					this.continued = false;
					this.notify({ kind: 'new-session', detail: 'unknown-native-session' });
					const connection = await this.open(role, undefined);
					return connection;
				}
				// One automatic retry for a provider that died during the handshake or did not answer in time (R06, R07).
				if (attempt++ === 0 && (!(error instanceof RuntimeError) || error.recoverable)) {
					await new Promise(resolve => setTimeout(resolve, this.manager.retryDelayMs));
					continue;
				}
				this.transition('failed', error instanceof RuntimeError ? error.code : 'RUNTIME_START_FAILED');
				throw error instanceof RuntimeError ? error : new RuntimeError('RUNTIME_START_FAILED');
			}
		}
	}

	private async open(role: SessionRole, resume: string | undefined, fork = false): Promise<AgentConnection> {
		const adapter = this.manager.adapter(this.identity.provider);
		const prepared = await this.manager.services.prepare(this.identity, role);
		const host: AdapterHost = {
			emit: event => {
				const published = this.publish(event);
				// A late id (a fork learns it from the first event) is stored in order; turns wait for it before ending.
				if (published?.payload.type === 'session.ready') {
					const id = published.payload.nativeSessionId;
					this.writes = this.writes.then(() => this.remember(id)).catch(() => undefined);
				}
			},
			approve: (call, turnId) => this.awaitUser('approval', () => this.manager.services.approve(this, call, turnId).catch(() => ({ allowed: false, scope: 'once' as const, reason: 'DENIED: the approval could not be requested' })), verdict => verdict.allowed, turnId, call),
			ask: (questions, turnId) => this.awaitUser('question', () => this.manager.services.ask(this, questions, turnId).catch(() => undefined), answers => !!answers, turnId)
		};
		let connection: AgentConnection;
		try {
			connection = await adapter.open({ ...prepared.options, identity: this.identity, role, ...(resume ? { resume } : {}), ...(resume && fork ? { fork: true } : {}) }, host);
		} catch (error) {
			await prepared.dispose().catch(() => undefined);
			throw error;
		}
		this.connection = connection;
		this.connectionRole = role;
		this.dispose = prepared.dispose;
		await this.remember(connection.nativeSessionId, role);
		void connection.exited.then(exit => {
			if (this.connection !== connection) { return; }
			// A crash between turns: the next turn reconnects and resumes (R01).
			this.connection = undefined;
			void prepared.dispose().catch(() => undefined);
			if (!exit.expected && !this.running && this.stateValue === 'ready') { this.transition('interrupted', 'provider exited'); }
		});
		this.transition('ready');
		return connection;
	}

	private async remember(nativeSessionId: string, role?: SessionRole): Promise<void> {
		if (!nativeSessionId) { return; }
		await this.manager.store.update(this.key, record => {
			const current = record ?? this.manager.newRecord(this.identity);
			current.nativeSessionId = nativeSessionId;
			if (role) { current.role = role; }
			current.cursor = this.bridge.cursor;
			return current;
		});
	}

	private async dropConnection(): Promise<void> {
		const connection = this.connection, dispose = this.dispose;
		this.connection = undefined; this.connectionRole = undefined; this.dispose = undefined;
		if (connection) { await connection.close().catch(() => undefined); }
		if (dispose) { await dispose().catch(() => undefined); }
	}
}

export class AgentSessionManager {
	readonly store: AgentSessionStore;
	readonly services: SessionServices;
	readonly retryDelayMs: number;
	private readonly adapters: Map<NativeProvider, AgentAdapter>;
	private readonly sessions = new Map<string, ManagedSession>();
	private readonly capabilityCache = new Map<string, { expires: number; result: Promise<RuntimeCapabilities> }>();

	constructor(store: AgentSessionStore, adapters: AgentAdapter[], services: SessionServices, options: ManagerOptions = {}) {
		this.store = store;
		this.services = services;
		this.adapters = new Map(adapters.map(adapter => [adapter.provider, adapter]));
		this.retryDelayMs = options.retryDelayMs ?? 1000;
	}

	adapter(provider: NativeProvider): AgentAdapter {
		const adapter = this.adapters.get(provider);
		if (!adapter) { throw new RuntimeError('RUNTIME_PROVIDER_UNSUPPORTED'); }
		return adapter;
	}

	/** Probe without model calls; isolate environments/accounts and refresh after CLI upgrades. */
	capabilities(provider: NativeProvider, env: NodeJS.ProcessEnv): Promise<RuntimeCapabilities> {
		const snapshot = { ...env };
		// Environment values can contain credentials: retain only their digest in the cache key.
		const key = provider + ':' + createHash('sha256').update(JSON.stringify(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
		const cached = this.capabilityCache.get(key);
		if (cached && cached.expires > Date.now()) { return cached.result; }
		const result = this.adapter(provider).capabilities(snapshot);
		if (this.capabilityCache.size >= 32) { this.capabilityCache.delete(this.capabilityCache.keys().next().value!); }
		this.capabilityCache.set(key, { expires: Date.now() + 60_000, result });
		void result.catch(() => {
			if (this.capabilityCache.get(key)?.result === result) { this.capabilityCache.delete(key); }
		});
		return result;
	}

	newRecord(identity: SessionIdentity): SessionRecord {
		const now = new Date().toISOString();
		return { key: sessionKey(identity), identity, state: 'closed', createdAt: now, updatedAt: now, cursor: 0, journal: [] };
	}

	/** Startup reconciliation: turns of a dead IDE process become `lost` notices (R02-R04). */
	async recover(): Promise<Array<{ key: string; entry: TurnJournalEntry }>> {
		return this.store.reconcile();
	}

	/** The live handle of a session, created lazily (no process until the first turn). */
	async session(identity: SessionIdentity): Promise<ManagedSession> {
		const key = sessionKey(identity);
		let session = this.sessions.get(key);
		if (!session) {
			const record = await this.store.get(key);
			session = new ManagedSession(this, identity, record?.cursor ?? 0);
			this.sessions.set(key, session);
		}
		return session;
	}

	/**
	 * A new conversation id for the same project and provider, branching from `from`'s native session when the provider
	 * forks (the original is never touched). Without fork support it is a fresh session.
	 */
	async fork(from: SessionIdentity, conversationId: string): Promise<ManagedSession> {
		const source = await this.store.get(sessionKey(from));
		const identity = { ...from, conversationId };
		await this.store.update(sessionKey(identity), record => ({ ...(record ?? this.newRecord(identity)), forkedFrom: source?.nativeSessionId, nativeSessionId: undefined }));
		return this.session(identity);
	}

	/** Provider switch: a new session for the other provider. The handoff is explicit; native ids never cross providers. */
	async handoff(from: SessionIdentity, provider: NativeProvider): Promise<ManagedSession> {
		const source = await this.store.get(sessionKey(from));
		const identity: SessionIdentity = { ...from, provider };
		await this.store.update(sessionKey(identity), record => ({ ...(record ?? this.newRecord(identity)), handoffFrom: { provider: from.provider, ...(source?.nativeSessionId ? { nativeSessionId: source.nativeSessionId } : {}) } }));
		return this.session(identity);
	}

	/** Stop every process (IDE shutdown). Sessions stay resumable. */
	async dispose(): Promise<void> {
		await Promise.all([...this.sessions.values()].map(session => session.close().catch(() => undefined)));
		this.sessions.clear();
	}
}
