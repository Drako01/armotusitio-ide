/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* One conversation per project. Sending only converses; code changes require approving the latest plan. */
import type { AgentOutcome } from './native-agent-execution.ts';
import type { NativeProvider } from './native-providers.ts';
import { redactSecrets } from './native-redact.ts';
import { absorbMessages, compactionSplit } from './native-chat-memory.ts';
import {
	buildConversationInstruction, buildImplementationInstruction, chatMessage, extractChatPlan, harnessErrorCode, latestPlanMessage, pendingAlive, samePlanContent,
	type ChatConversation, type ChatMessage, type ChatPlan, type ChatProjectContext, type ChatRunSummary, type ChatStore, type GateSummary, type RunStatus
} from './native-chat.ts';

export type ImplementStage = 'preparing' | 'agent' | 'verifying';
export interface ChatRunHooks {
	/** Called once the provider process exists, so the session can cancel it. */
	started(cancel: () => void): void;
	progress(observedBytes: number): void;
	/** Intermediate assistant message, already redacted, when the provider streams them. */
	message?(text: string): void;
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
	converse(provider: NativeProvider, instruction: string, hooks: ChatRunHooks, signal: AbortSignal): Promise<AgentOutcome>;
	implement(request: { provider: NativeProvider; instruction: string; plan: ChatPlan; verificationRevision?: string }, hooks: ChatImplementHooks, signal: AbortSignal): Promise<ChatImplementOutcome>;
}
export interface ChatActivity {
	kind: 'thinking' | 'executing';
	provider: NativeProvider;
	startedAt: string;
	observedBytes: number;
	/** Cancellation was requested; the UI stops offering it while the process winds down. */
	cancelling?: boolean;
	/** Latest streamed assistant message of this turn; never persisted, replaced by the final answer. */
	partial?: string;
	stage?: ImplementStage;
	planVersion?: number;
	gates?: GateSummary[];
}
export interface ChatSnapshot {
	provider: NativeProvider;
	/** Increments whenever `messages` changes, so hosts can skip resending an unchanged history. */
	revision: number;
	messages: ChatMessage[];
	activity?: ChatActivity;
	plan?: { messageId: string; version: number; digest: string; approvable: boolean; blockedReason?: string };
	writer: boolean;
	/** Commands that run automatically after an approved implementation. */
	verification: Array<{ id: string; command: string }>;
}
type Translate = (message: string, ...args: string[]) => string;

/** Stable, user-facing explanation of a failed provider turn. Raw provider output is never treated as an error code. */
function failureNotice(t: Translate, outcome: AgentOutcome): string {
	if (outcome.status === 'cancelled') { return t('Consulta cancelada.'); }
	if (outcome.status === 'timeout') { return t('La IA no respondi\u00f3 a tiempo. Pod\u00e9s reintentar o acotar el pedido.'); }
	if (outcome.rateLimited) {
		// The provider's own text says when the limit resets (minutes for throttling, days for an exhausted plan).
		const detail = outcome.output.trim().slice(0, 400);
		return detail
			? t('El proveedor rechaz\u00f3 la consulta por l\u00edmite de uso: \u00ab{0}\u00bb. Eleg\u00ed el otro proveedor o esper\u00e1 a que se renueve el cupo.', detail)
			: t('El proveedor limit\u00f3 las solicitudes. Esper\u00e1 unos minutos o eleg\u00ed el otro proveedor.');
	}
	if (outcome.scopeViolation) { return t('La consulta se descart\u00f3 porque el workspace cambi\u00f3 durante una tarea de solo lectura. Volv\u00e9 a enviarla.'); }
	return t('La IA no pudo completar la respuesta (c\u00f3digo {0}). Revis\u00e1 que el proveedor est\u00e9 instalado y autenticado.', String(outcome.exitCode ?? 'n/a'));
}

/** What the user can do about a known failure; unknown codes fall back to a generic retry hint. */
function recoveryHint(t: Translate, code: string): string {
	if (code === 'HARNESS_FENCE_HELD_RECONCILIATION_REQUIRED') { return t('Otra ejecuci\u00f3n tiene el lock del proyecto o qued\u00f3 colgada. Si no hay nada corriendo, us\u00e1 \u00abArmoTuSitio: Reconciliar lock compartido obsoleto\u00bb y reintent\u00e1.'); }
	if (code === 'HARNESS_ALREADY_RUNNING' || code === 'HARNESS_PROVIDER_CAPACITY_REACHED') { return t('Hay otra tarea de IA en curso. Esper\u00e1 a que termine o cancelala.'); }
	if (code === 'HARNESS_UNTRUSTED_WORKSPACE') { return t('Marc\u00e1 el workspace como confiable para continuar.'); }
	if (code === 'HARNESS_CANCELLED_BEFORE_START') { return t('La ejecuci\u00f3n se cancel\u00f3 antes de iniciar; no se modific\u00f3 ning\u00fan archivo.'); }
	if (code.startsWith('HARNESS_PROVIDER_') && /BUDGET|QUOTA|RATE_LIMITED/.test(code)) { return t('Se alcanz\u00f3 un l\u00edmite local de uso del proveedor. Revis\u00e1 \u00abArmoTuSitio: Consultar cupo local de llamadas de IA\u00bb o eleg\u00ed el otro proveedor.'); }
	if (code === 'HARNESS_CHAT_VERIFICATION_CHANGED' || code === 'HARNESS_PROJECT_SKILL_CHANGED' || code === 'HARNESS_PROJECT_GUIDANCE_CHANGED') { return t('La configuraci\u00f3n del proyecto cambi\u00f3 despu\u00e9s de revisar el plan. Pedile a la IA que lo confirme de nuevo.'); }
	return t('La conversaci\u00f3n se conserva; pod\u00e9s reintentar.');
}

const cancelledBeforeStart = (error: unknown): boolean => harnessErrorCode(error) === 'HARNESS_CANCELLED_BEFORE_START';

/** User-facing failure: a safe error code plus what to do next. Shared by the session and its host. */
export function describeFailure(t: Translate, error: unknown): string {
	const code = harnessErrorCode(error);
	return t('No se pudo completar la operaci\u00f3n ({0}). {1}', code, recoveryHint(t, code));
}

export class HarnessChatSession {
	private conversation!: ChatConversation;
	private activity?: ChatActivity;
	private cancelActive?: () => void;
	private context?: ChatProjectContext;
	private loaded?: Promise<void>;
	private revision = 0;

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
			// Another window's live operation is not ours to report (the store keeps it); only a dead owner means interrupted.
			const interrupted = (this.conversation.pending ?? []).filter(entry => entry.pid === process.pid || !pendingAlive(entry));
			this.conversation.pending = undefined;
			for (const entry of interrupted) {
				// The process that owned this operation is gone: say exactly what may be incomplete.
				this.conversation.messages.push(chatMessage('notice', entry.kind === 'executing'
					? this.t('La ejecuci\u00f3n del plan v{0} se interrumpi\u00f3 porque el IDE se cerr\u00f3. Revis\u00e1 los cambios del workspace (por ejemplo con git status) y, si el lock qued\u00f3 tomado, us\u00e1 \u00abArmoTuSitio: Reconciliar lock compartido obsoleto\u00bb antes de reintentar.', String(entry.planVersion ?? '?'))
					: this.t('La respuesta anterior se interrumpi\u00f3 porque el IDE se cerr\u00f3. Volv\u00e9 a enviar el mensaje.'), { tone: 'error' }));
			}
			if (recovered || interrupted.length) { await this.persist(); }
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
		const current = latestPlanMessage(this.conversation.messages);
		const writer = !!this.context?.writer;
		const blockedReason = current && this.blockedReason(current, writer);
		return {
			provider: this.conversation.provider,
			revision: this.revision,
			messages: this.conversation.messages,
			activity: this.activity ? { ...this.activity } : undefined,
			plan: current ? { messageId: current.id, version: current.plan.version, digest: current.plan.digest, approvable: !this.activity && !blockedReason, blockedReason } : undefined,
			writer,
			verification: this.context?.verification?.gates ?? []
		};
	}

	/** Why the latest plan cannot be approved right now, if anything blocks it. */
	private blockedReason(current: ChatMessage & { plan: ChatPlan }, writer: boolean): string | undefined {
		if (!this.context) { return this.t('No se pudo leer el estado del proyecto. Reintent\u00e1 en unos segundos.'); }
		if (!writer) { return this.t('Este proyecto tiene su propio Harness. El IDE no aplica cambios sin coordinaci\u00f3n verificable con ese motor. Si el motor soporta el lease de escritura (protocolo v2), pod\u00e9s habilitar \u00abatsHarness.coordinatedProjectWriters\u00bb.'); }
		const position = this.conversation.messages.indexOf(current);
		// New requirements suspend the plan until the assistant confirms or revises it.
		if (this.conversation.messages.slice(position + 1).some(message => message.role === 'user')) { return this.t('Escribiste despu\u00e9s de este plan. Esper\u00e1 a que la IA lo confirme o lo actualice antes de aprobarlo.'); }
		// A plan that already ran successfully is never applied twice; failed or cancelled runs can be retried.
		// Once the writer finished, files may have changed even if verification failed: re-applying would duplicate work.
		const applied = this.conversation.messages.some(message => message.run?.planVersion === current.plan.version && (message.run.status === 'passed' || message.run.agentStatus === 'passed'));
		return applied ? this.t('Este plan ya se aplic\u00f3. Ped\u00ed a la IA los ajustes necesarios para generar una nueva versi\u00f3n.') : undefined;
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
		this.conversation.memory = undefined;
		await this.persist({ replace: true });
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
		// Credentials pasted by mistake are neither stored nor sent to the provider.
		this.conversation.messages.push(chatMessage('user', redactSecrets(body)));
		this.activity = { kind: 'thinking', provider, startedAt: new Date().toISOString(), observedBytes: 0 };
		this.conversation.pending = [{ kind: 'thinking', startedAt: this.activity.startedAt, pid: process.pid }];
		const controller = new AbortController();
		const hooks = this.hooks(() => controller.abort());
		// Every failure after the activity starts, including storage, must end in `finally` and clear it.
		try {
			await this.persist();
			await this.refreshContext();
			if (!this.context) { throw Error('HARNESS_CHAT_CONTEXT_UNAVAILABLE'); }
			const current = latestPlanMessage(this.conversation.messages)?.plan;
			const instruction = buildConversationInstruction(this.conversation.messages, this.context, current, this.conversation.memory);
			if (controller.signal.aborted) { throw Error('HARNESS_CANCELLED_BEFORE_START'); }
			const outcome = await this.runtime.converse(provider, instruction, hooks, controller.signal);
			if (outcome.status !== 'passed' || !outcome.output.trim()) {
				this.conversation.messages.push(chatMessage('notice', failureNotice(this.t, outcome), { tone: outcome.status === 'cancelled' ? 'info' : 'error', provider }));
				return;
			}
			const extracted = extractChatPlan(outcome.output, Math.max(current?.version ?? 0, this.conversation.memory?.lastPlanVersion ?? 0) + 1);
			// A confirmed, unchanged plan keeps its version so the approval refers to what the user already reviewed.
			const plan = extracted.plan && current && samePlanContent(extracted.plan, current) ? current : extracted.plan;
			this.conversation.messages.push(chatMessage('assistant', extracted.text || this.t('Plan actualizado.'), { provider, plan }));
		} catch (error) {
			this.conversation.messages.push(chatMessage('notice', this.errorNotice(error), { tone: cancelledBeforeStart(error) ? 'info' : 'error', provider }));
		} finally {
			this.finish();
			await this.persist();
		}
	}

	/** Approve and run = change code. Only the latest plan, by exact digest, in a writer-enabled project. */
	async approve(digest: string): Promise<void> {
		if (this.activity) { throw Error('HARNESS_ALREADY_RUNNING'); }
		await this.refreshContext();
		const plan = latestPlanMessage(this.conversation.messages)?.plan;
		if (!plan || plan.digest !== digest) { throw Error('HARNESS_CHAT_PLAN_CHANGED'); }
		const state = this.snapshot().plan;
		if (!state?.approvable || !this.context) { throw Error(this.context?.writer ? 'HARNESS_CHAT_PLAN_NOT_APPROVABLE' : 'HARNESS_HYBRID_WRITER_UNAVAILABLE'); }
		const provider = this.conversation.provider;
		const controller = new AbortController();
		this.conversation.messages.push(chatMessage('notice', this.t('Plan v{0} aprobado. Ejecutando con {1}.', String(plan.version), provider === 'claude' ? 'Claude Code' : 'Codex'), { tone: 'info', provider }));
		this.activity = { kind: 'executing', provider, startedAt: new Date().toISOString(), observedBytes: 0, stage: 'preparing', planVersion: plan.version, gates: this.context.verification?.gates.map(gate => ({ id: gate.id, status: 'pending' as const })) ?? [] };
		this.conversation.pending = [{ kind: 'executing', startedAt: this.activity.startedAt, planVersion: plan.version, pid: process.pid }];
		const started = Date.now();
		const runHooks = this.hooks(() => controller.abort());
		try {
			await this.persist();
			const instruction = buildImplementationInstruction(plan, this.conversation.messages);
			const hooks: ChatImplementHooks = {
				...runHooks,
				stage: stage => { if (this.activity) { this.activity.stage = stage; this.emit(); } },
				gates: gates => { if (this.activity) { this.activity.gates = gates; this.emit(); } }
			};
			const result = await this.runtime.implement({ provider, instruction, plan, verificationRevision: this.context.verification?.revision }, hooks, controller.signal);
			// The agent result decides first; a passing agent is only as good as its verification.
			let status: RunStatus = result.agent.status;
			if (status === 'passed' && result.verification.status !== 'skipped') { status = result.verification.status; }
			this.conversation.messages.push(chatMessage('run', result.agent.output.trim() || this.t('El agente no devolvi\u00f3 un informe.'), {
				provider, tone: status === 'passed' ? 'info' : 'error',
				run: { planVersion: plan.version, provider, status, agentStatus: result.agent.status, durationMs: Date.now() - started, verification: result.verification }
			}));
		} catch (error) {
			this.conversation.messages.push(chatMessage('notice', this.errorNotice(error), { tone: cancelledBeforeStart(error) ? 'info' : 'error', provider }));
		} finally {
			this.finish();
			await this.persist();
		}
	}

	/** Cancellation requested before the provider process exists is applied as soon as it starts. */
	private hooks(onCancel?: () => void): ChatRunHooks {
		let cancelProcess: (() => void) | undefined;
		let requested = false;
		this.cancelActive = () => {
			requested = true;
			if (this.activity) { this.activity.cancelling = true; this.emit(); }
			onCancel?.(); cancelProcess?.();
		};
		return {
			started: cancel => {
				cancelProcess = cancel;
				if (requested) { cancel(); }
				if (this.activity?.stage === 'preparing') { this.activity.stage = 'agent'; }
				this.emit();
			},
			progress: observedBytes => { if (this.activity) { this.activity.observedBytes = observedBytes; this.emit(); } },
			message: text => { if (this.activity) { this.activity.partial = text.length > 8000 ? text.slice(-8000) : text; this.emit(); } }
		};
	}

	private finish(): void {
		this.activity = undefined; this.cancelActive = undefined; this.conversation.pending = undefined;
	}

	private errorNotice(error: unknown): string { return describeFailure(this.t, error); }

	private async persist(options: { replace?: boolean } = {}): Promise<void> {
		// Old messages become memory; the latest plan and what follows it always stay.
		const folded = compactionSplit(this.conversation.messages);
		if (folded) { this.conversation.memory = absorbMessages(this.conversation.memory, this.conversation.messages.splice(0, folded), this.context?.root ?? ''); }
		this.revision++;
		this.emit();
		const stored = await this.store.save(this.conversation, options);
		// Another window added messages to this project's conversation: adopt the merged history.
		if (stored.length !== this.conversation.messages.length || stored.some((message, index) => message.id !== this.conversation.messages[index].id)) {
			this.conversation.messages = stored;
			this.revision++;
			this.emit();
		}
	}

	private emit(): void { if (this.conversation) { this.listener(this.snapshot()); } }
}
