/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* One conversation per project. Sending only converses; code changes require approving the latest plan. */
import type { AgentOutcome } from './native-agent-execution.ts';
import type { NativeProvider } from './native-providers.ts';
import {
	buildConversationInstruction, buildImplementationInstruction, chatMessage, extractChatPlan, harnessErrorCode, latestPlan,
	type ChatConversation, type ChatMessage, type ChatPlan, type ChatProjectContext, type ChatRunSummary, type ChatStore, type GateSummary, type RunStatus
} from './native-chat.ts';

export type ImplementStage = 'preparing' | 'agent' | 'verifying';
export interface ChatRunHooks {
	/** Called once the provider process exists, so the session can cancel it. */
	started(cancel: () => void): void;
	progress(observedBytes: number): void;
}
export interface ChatImplementHooks extends ChatRunHooks {
	stage(stage: ImplementStage): void;
	gates(gates: GateSummary[]): void;
}
export interface ChatImplementOutcome {
	agent: AgentOutcome;
	verification: ChatRunSummary['verification'];
}
/** Engine boundary: the IDE provides the guarded implementation; tests provide a scripted one. */
export interface ChatRuntime {
	context(): Promise<ChatProjectContext>;
	converse(provider: NativeProvider, instruction: string, hooks: ChatRunHooks): Promise<AgentOutcome>;
	implement(request: { provider: NativeProvider; instruction: string; plan: ChatPlan; verificationRevision?: string }, hooks: ChatImplementHooks, signal: AbortSignal): Promise<ChatImplementOutcome>;
}
export interface ChatActivity {
	kind: 'thinking' | 'executing';
	provider: NativeProvider;
	startedAt: string;
	observedBytes: number;
	stage?: ImplementStage;
	planVersion?: number;
	gates?: GateSummary[];
}
export interface ChatSnapshot {
	provider: NativeProvider;
	messages: ChatMessage[];
	activity?: ChatActivity;
	plan?: { version: number; digest: string; approvable: boolean; blockedReason?: string };
	writer: boolean;
	/** Commands that run automatically after an approved implementation. */
	verification: Array<{ id: string; command: string }>;
}
type Translate = (message: string, ...args: string[]) => string;

/** Stable, user-facing explanation of a failed provider turn. Raw provider output is never treated as an error code. */
function failureNotice(t: Translate, outcome: AgentOutcome): string {
	if (outcome.status === 'cancelled') { return t('Consulta cancelada.'); }
	if (outcome.status === 'timeout') { return t('La IA no respondi\u00f3 a tiempo. Pod\u00e9s reintentar o acotar el pedido.'); }
	if (outcome.rateLimited) { return t('El proveedor limit\u00f3 las solicitudes. Esper\u00e1 unos minutos o eleg\u00ed el otro proveedor.'); }
	if (outcome.scopeViolation) { return t('La consulta se descart\u00f3 porque el workspace cambi\u00f3 durante una tarea de solo lectura. Volv\u00e9 a enviarla.'); }
	return t('La IA no pudo completar la respuesta (c\u00f3digo {0}). Revis\u00e1 que el proveedor est\u00e9 instalado y autenticado.', String(outcome.exitCode ?? 'n/a'));
}

export class HarnessChatSession {
	private conversation!: ChatConversation;
	private activity?: ChatActivity;
	private cancelActive?: () => void;
	private context?: ChatProjectContext;
	private loaded?: Promise<void>;

	private readonly store: ChatStore;
	private readonly runtime: ChatRuntime;
	private readonly listener: (snapshot: ChatSnapshot) => void;
	private readonly t: Translate;
	private readonly defaultProvider: NativeProvider;

	constructor(store: ChatStore, runtime: ChatRuntime, listener: (snapshot: ChatSnapshot) => void, t: Translate, defaultProvider: NativeProvider = 'claude') {
		this.store = store; this.runtime = runtime; this.listener = listener; this.t = t; this.defaultProvider = defaultProvider;
	}

	open(): Promise<void> {
		this.loaded ??= (async () => {
			const { conversation, recovered } = await this.store.load(this.defaultProvider);
			this.conversation = conversation;
			if (recovered) { this.conversation.messages.push(chatMessage('notice', this.t('El historial anterior estaba da\u00f1ado y se archiv\u00f3. Empez\u00e1s una conversaci\u00f3n nueva.'), { tone: 'error' })); }
			await this.refreshContext();
		})();
		return this.loaded;
	}

	get busy(): boolean { return !!this.activity; }

	/** Re-read project facts (writer authority, verification gates, skills) so the plan card never shows stale permissions. */
	async refreshContext(): Promise<void> {
		try { this.context = await this.runtime.context(); }
		catch { this.context = undefined; }
		this.emit();
	}

	snapshot(): ChatSnapshot {
		const plan = latestPlan(this.conversation.messages);
		const writer = !!this.context?.writer;
		const blockedReason = plan && this.blockedReason(plan, writer);
		return {
			provider: this.conversation.provider,
			messages: this.conversation.messages,
			activity: this.activity ? { ...this.activity } : undefined,
			plan: plan ? { version: plan.version, digest: plan.digest, approvable: !this.activity && !blockedReason, blockedReason } : undefined,
			writer,
			verification: this.context?.verification?.gates ?? []
		};
	}

	/** Why the latest plan cannot be approved right now, if anything blocks it. */
	private blockedReason(plan: ChatPlan, writer: boolean): string | undefined {
		if (!this.context) { return this.t('No se pudo leer el estado del proyecto. Reintent\u00e1 en unos segundos.'); }
		if (!writer) { return this.t('Este proyecto tiene su propio Harness. El IDE no aplica cambios sin coordinaci\u00f3n verificable con ese motor.'); }
		// A plan that already ran successfully is never applied twice; failed or cancelled runs can be retried.
		const applied = this.conversation.messages.some(message => message.run?.planVersion === plan.version && message.run.status === 'passed');
		return applied ? this.t('Este plan ya se ejecut\u00f3. Ped\u00ed cambios para generar una nueva versi\u00f3n.') : undefined;
	}

	/** Switching provider affects only future turns; a running turn keeps the provider it started with. */
	async selectProvider(provider: NativeProvider): Promise<void> {
		if (provider !== 'codex' && provider !== 'claude') { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
		this.conversation.provider = provider;
		await this.persist();
	}

	async reset(): Promise<void> {
		if (this.activity) { throw Error('HARNESS_ALREADY_RUNNING'); }
		this.conversation.messages = [];
		await this.persist();
	}

	cancel(): void { this.cancelActive?.(); }

	/** Local, non-AI entries (slash command results, environment warnings) shown in the same timeline. */
	async note(body: string, tone: 'info' | 'error' = 'info'): Promise<void> {
		this.conversation.messages.push(chatMessage('notice', body, { tone }));
		await this.persist();
	}

	/** Send = converse. This path can only launch a read-only provider turn. */
	async send(input: string): Promise<void> {
		const body = typeof input === 'string' ? input.trim() : '';
		if (!body || body.length > 10000) { throw Error('HARNESS_CHAT_MESSAGE_INVALID'); }
		if (this.activity) { throw Error('HARNESS_ALREADY_RUNNING'); }
		const provider = this.conversation.provider;
		this.conversation.messages.push(chatMessage('user', body));
		this.activity = { kind: 'thinking', provider, startedAt: new Date().toISOString(), observedBytes: 0 };
		// Every failure after the activity starts, including storage, must end in `finally` and clear it.
		try {
			await this.persist();
			await this.refreshContext();
			if (!this.context) { throw Error('HARNESS_CHAT_CONTEXT_UNAVAILABLE'); }
			const current = latestPlan(this.conversation.messages);
			const instruction = buildConversationInstruction(this.conversation.messages, this.context, current);
			const outcome = await this.runtime.converse(provider, instruction, this.hooks());
			if (outcome.status !== 'passed' || !outcome.output.trim()) {
				this.conversation.messages.push(chatMessage('notice', failureNotice(this.t, outcome), { tone: outcome.status === 'cancelled' ? 'info' : 'error', provider }));
				return;
			}
			const { text, plan } = extractChatPlan(outcome.output, (current?.version ?? 0) + 1);
			this.conversation.messages.push(chatMessage('assistant', text || this.t('Plan actualizado.'), { provider, plan }));
		} catch (error) {
			this.conversation.messages.push(chatMessage('notice', this.errorNotice(error), { tone: 'error', provider }));
		} finally {
			this.activity = undefined; this.cancelActive = undefined;
			await this.persist();
		}
	}

	/** Approve and run = change code. Only the latest plan, by exact digest, in a writer-enabled project. */
	async approve(digest: string): Promise<void> {
		if (this.activity) { throw Error('HARNESS_ALREADY_RUNNING'); }
		await this.refreshContext();
		const plan = latestPlan(this.conversation.messages);
		if (!plan || plan.digest !== digest) { throw Error('HARNESS_CHAT_PLAN_CHANGED'); }
		const state = this.snapshot().plan;
		if (!state?.approvable || !this.context) { throw Error(this.context?.writer ? 'HARNESS_CHAT_PLAN_ALREADY_APPLIED' : 'HARNESS_HYBRID_WRITER_UNAVAILABLE'); }
		const provider = this.conversation.provider;
		const controller = new AbortController();
		this.conversation.messages.push(chatMessage('notice', this.t('Plan v{0} aprobado. Ejecutando con {1}.', String(plan.version), provider === 'claude' ? 'Claude Code' : 'Codex'), { tone: 'info', provider }));
		this.activity = { kind: 'executing', provider, startedAt: new Date().toISOString(), observedBytes: 0, stage: 'preparing', planVersion: plan.version, gates: this.context.verification?.gates.map(gate => ({ id: gate.id, status: 'pending' as const })) ?? [] };
		const started = Date.now();
		try {
			await this.persist();
			const instruction = buildImplementationInstruction(plan, this.conversation.messages);
			const hooks: ChatImplementHooks = {
				...this.hooks(() => controller.abort()),
				stage: stage => { if (this.activity) { this.activity.stage = stage; this.emit(); } },
				gates: gates => { if (this.activity) { this.activity.gates = gates; this.emit(); } }
			};
			const result = await this.runtime.implement({ provider, instruction, plan, verificationRevision: this.context.verification?.revision }, hooks, controller.signal);
			// The agent result decides first; a passing agent is only as good as its verification.
			let status: RunStatus = result.agent.status;
			if (status === 'passed' && result.verification.status !== 'skipped') { status = result.verification.status; }
			this.conversation.messages.push(chatMessage('run', result.agent.output.trim() || this.t('El agente no devolvi\u00f3 un informe.'), {
				provider, tone: status === 'passed' ? 'info' : 'error',
				run: { planVersion: plan.version, provider, status, durationMs: Date.now() - started, verification: result.verification }
			}));
		} catch (error) {
			this.conversation.messages.push(chatMessage('notice', this.errorNotice(error), { tone: 'error', provider }));
		} finally {
			this.activity = undefined; this.cancelActive = undefined;
			await this.persist();
		}
	}

	private hooks(onCancel?: () => void): ChatRunHooks {
		let cancelProcess: (() => void) | undefined;
		this.cancelActive = () => { onCancel?.(); cancelProcess?.(); };
		return {
			started: cancel => { cancelProcess = cancel; if (this.activity?.stage === 'preparing') { this.activity.stage = 'agent'; } this.emit(); },
			progress: observedBytes => { if (this.activity) { this.activity.observedBytes = observedBytes; this.emit(); } }
		};
	}

	private errorNotice(error: unknown): string {
		const code = harnessErrorCode(error);
		return this.t('No se pudo completar la operaci\u00f3n ({0}). La conversaci\u00f3n se conserva; pod\u00e9s reintentar.', code);
	}

	private async persist(): Promise<void> {
		if (this.conversation.messages.length > 200) { this.conversation.messages.splice(0, this.conversation.messages.length - 200); }
		this.emit();
		await this.store.save(this.conversation);
	}

	private emit(): void { if (this.conversation) { this.listener(this.snapshot()); } }
}
