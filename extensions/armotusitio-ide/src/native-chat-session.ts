/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* One conversation per project. Sending only converses; code changes require approving the latest plan. */
import type { AgentOutcome } from './native-agent-execution.ts';
import type { NativeProvider } from './native-providers.ts';
import { redactSecrets } from './native-redact.ts';
import { absorbMessages, compactionSplit } from './native-chat-memory.ts';
import { classifyRun } from './native-run-outcome.ts';
import { recoveryHint } from './native-error-catalog.ts';
import type { ActivityActionId, ActivityItem } from './native-activity-feed.ts';
import type { RunDiffSummary } from './native-run-diff.ts';
import {
	buildContinuationInstruction, buildConversationInstruction, buildImplementationInstruction, chatMessage, extractChatPlan, harnessErrorCode, latestPlanMessage, MAX_USER_MESSAGE_CHARS, pendingAlive, samePlanContent,
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
	/** Files the writer changed, measured under the execution fence before and after it ran. */
	diff: RunDiffSummary;
}
/** Engine boundary: the IDE provides the guarded implementation; tests provide a scripted one. */
export interface ChatRuntime {
	context(): Promise<ChatProjectContext>;
	converse(provider: NativeProvider, instruction: string, hooks: ChatRunHooks, signal: AbortSignal): Promise<AgentOutcome>;
	/** `resumeSession` continues the provider session of an earlier partial run (Claude only). */
	implement(request: { provider: NativeProvider; instruction: string; plan: ChatPlan; verificationRevision?: string; resumeSession?: string }, hooks: ChatImplementHooks, signal: AbortSignal): Promise<ChatImplementOutcome>;
	/** Undo the files a run changed, under the same fence and lease as a writer; files the user touched are skipped. */
	discard?(diff: RunDiffSummary): Promise<{ discarded: string[]; skipped: string[] }>;
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
	/** Latest run of the latest plan and what can be done with it right now. */
	run?: { messageId: string; continuable: boolean; retryable: boolean; discardable: boolean };
	writer: boolean;
	/** Isolation of the selected provider's writer, for display next to the approval. */
	isolation?: { writes: string; allowed: boolean };
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
	if (outcome.stopReason === 'max-turns') { return t('La IA us\u00f3 todos sus turnos de consulta antes de responder. Acot\u00e1 la pregunta o ped\u00ed que revise menos archivos a la vez.'); }
	return t('La IA no pudo completar la respuesta (c\u00f3digo {0}). Revis\u00e1 que el proveedor est\u00e9 instalado y autenticado.', String(outcome.exitCode ?? 'n/a'));
}

/** The read-only integrity check skipped trees that were too large or deep; say which, so nothing is skipped silently. */
function unscannedNotice(t: Translate, folders: readonly string[]): string {
	const shown = folders.slice(0, 5).map(folder => '\u00ab' + folder + '\u00bb').join(', ');
	return t('El control de archivos sensibles no analiz\u00f3 estas carpetas por su tama\u00f1o: {0}{1}. Si son cach\u00e9s o salida generada, agregalas al .gitignore.', shown, folders.length > 5 ? ' (+' + (folders.length - 5) + ')' : '');
}

/** The single next step that unblocks writing in a project with its own Harness. */
function writerBlockReason(t: Translate, block: ChatProjectContext['writerBlock']): string {
	if (block === 'untrusted') { return t('Marc\u00e1 el workspace como confiable para ejecutar planes.'); }
	if (block === 'setting-off') { return t('Este proyecto tiene su propio Harness. Activ\u00e1 \u00abatsHarness.coordinatedProjectWriters\u00bb en la configuraci\u00f3n de Usuario; se aplica sin recargar la ventana.'); }
	if (block === 'engine-no-protocol') { return t('El Harness de este proyecto no implementa el protocolo del IDE (no declara capacidades). Actualizalo para que el IDE pueda coordinar la escritura.'); }
	if (block === 'engine-no-lease') { return t('El Harness de este proyecto implementa el protocolo del IDE pero no declara la capacidad \u00abwriter-lease\u00bb. Actualizalo para que el IDE pueda escribir.'); }
	return t('Este proyecto tiene su propio Harness. El IDE no aplica cambios sin coordinaci\u00f3n verificable con ese motor.');
}

const providerLabel = (provider: NativeProvider): string => provider === 'claude' ? 'Claude Code' : 'Codex';

const cancelledBeforeStart = (error: unknown): boolean => harnessErrorCode(error) === 'HARNESS_CANCELLED_BEFORE_START';

/** User-facing failure: a safe error code plus what to do next. Shared by the session and its host. */
export function describeFailure(t: Translate, error: unknown): string {
	const code = harnessErrorCode(error);
	return t('No se pudo completar la operaci\u00f3n ({0}). {1}', code, recoveryHint(t, code));
}

/** Runs of one project shown in the feed; older ones stay in the conversation. */
const FEED_RUNS = 5;

/**
 * Feed items for one project's conversation (block AC): what is running, a plan waiting for approval and the latest runs.
 * Ids are stable per project and per run message, so publishing twice never duplicates an item.
 */
export function chatActivityItems(snapshot: ChatSnapshot, project: { key: string; name: string }, t: Translate): ActivityItem[] {
	const base = { kind: 'chat-run' as const, project: project.name, origin: 'this-window' as const };
	const items: ActivityItem[] = [];
	const activity = snapshot.activity;
	const plans = new Map(snapshot.messages.filter(message => message.plan).map(message => [message.plan!.version, message.plan!.title]));
	if (activity) {
		const started = Date.parse(activity.startedAt);
		items.push({
			...base, id: 'chat:' + project.key + ':now', state: 'running', provider: activity.provider, startedAt: started, updatedAt: Date.now(),
			title: activity.kind === 'thinking' ? t('Respondiendo en el chat') : t('Plan v{0}: {1}', String(activity.planVersion), plans.get(activity.planVersion ?? -1) ?? ''),
			...(activity.stage ? { step: { index: ['preparing', 'agent', 'verifying'].indexOf(activity.stage) + 1, total: 3, label: activity.stage } } : {}),
			// The last line the agent wrote is the live "what it is doing now".
			...(activity.partial?.trim() ? { detail: activity.partial.trim().split('\n').at(-1)!.slice(0, 200) } : {}),
			actions: activity.cancelling ? ['open'] : ['open', 'stop']
		});
	} else if (snapshot.plan?.approvable && snapshot.run?.messageId === undefined) {
		const message = snapshot.messages.find(item => item.id === snapshot.plan!.messageId);
		items.push({
			...base, id: 'chat:' + project.key + ':now', state: 'queued', needs: 'approval', startedAt: Date.parse(message?.at ?? new Date().toISOString()), updatedAt: Date.parse(message?.at ?? new Date().toISOString()),
			title: t('Plan v{0}: {1}', String(snapshot.plan.version), message?.plan?.title ?? ''), detail: t('Listo para aprobar'), actions: ['approve', 'open']
		});
	}
	const runs = snapshot.messages.filter(message => message.run).slice(-FEED_RUNS);
	for (const message of runs) {
		const run = message.run!;
		const kind = run.outcome?.kind ?? (run.status === 'passed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'failed');
		const latest = snapshot.run?.messageId === message.id;
		const actions: ActivityActionId[] = ['open'];
		if (latest && snapshot.run?.continuable) { actions.unshift('continue'); }
		if (latest && snapshot.run?.retryable && kind !== 'completed') { actions.push('retry'); }
		const at = Date.parse(message.at);
		items.push({
			...base, id: 'chat:' + project.key + ':' + message.id, state: kind, provider: run.provider, startedAt: at - run.durationMs, updatedAt: at,
			title: t('Plan v{0}: {1}', String(run.planVersion), plans.get(run.planVersion) ?? ''),
			...(kind === 'blocked' && run.outcome?.needs ? { needs: run.outcome.needs } : {}),
			...(run.outcome?.diff.available ? { detail: t('{0} archivos cambiados', String(run.outcome.diff.count)) } : {}),
			actions
		});
	}
	return items;
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
		const approvable = !!current && !this.activity && !blockedReason;
		const run = current && this.latestRun(current.plan);
		return {
			provider: this.conversation.provider,
			revision: this.revision,
			messages: this.conversation.messages,
			activity: this.activity ? { ...this.activity } : undefined,
			plan: current ? { messageId: current.id, version: current.plan.version, digest: current.plan.digest, approvable, blockedReason } : undefined,
			// Continue reuses the approval of a partial run; Retry runs the same approved plan again.
			run: run ? {
				messageId: run.id, continuable: approvable && run.run.outcome?.kind === 'partial', retryable: approvable,
				discardable: !this.activity && writer && !!this.runtime.discard && !!run.run.outcome?.diff.available && (run.run.outcome?.diff.count ?? 0) > 0 && !run.run.discarded
			} : undefined,
			writer,
			isolation: this.context?.isolation?.[this.conversation.provider],
			verification: this.context?.verification?.gates ?? []
		};
	}

	/** Why the latest plan cannot be approved right now, if anything blocks it. */
	private blockedReason(current: ChatMessage & { plan: ChatPlan }, writer: boolean): string | undefined {
		if (!this.context) { return this.t('No se pudo leer el estado del proyecto. Reintent\u00e1 en unos segundos.'); }
		if (!writer) { return writerBlockReason(this.t, this.context.writerBlock); }
		const isolation = this.context.isolation?.[this.conversation.provider];
		if (isolation && !isolation.allowed) { return this.t('Tu configuraci\u00f3n exige un aislamiento de escritura que {0} no ofrece. Eleg\u00ed el otro proveedor o ajust\u00e1 \u00abatsHarness.writerIsolation\u00bb.', providerLabel(this.conversation.provider)); }
		const position = this.conversation.messages.indexOf(current);
		// New requirements suspend the plan until the assistant confirms or revises it.
		if (this.conversation.messages.slice(position + 1).some(message => message.role === 'user')) { return this.t('Escribiste despu\u00e9s de este plan. Esper\u00e1 a que la IA lo confirme o lo actualice antes de aprobarlo.'); }
		// Only a completed run applies a plan; partial, blocked, unchanged and failed runs leave it approvable.
		// Runs stored before outcomes existed keep the earlier rule: a writer that finished may have changed files.
		const applied = this.conversation.messages.some(message => message.run?.planVersion === current.plan.version &&
			(message.run.outcome ? message.run.outcome.kind === 'completed' : message.run.status === 'passed' || message.run.agentStatus === 'passed'));
		return applied ? this.t('Este plan ya se aplic\u00f3. Ped\u00ed a la IA los ajustes necesarios para generar una nueva versi\u00f3n.') : undefined;
	}

	/** The newest run message of a plan version, if it ran. */
	private latestRun(plan: ChatPlan): (ChatMessage & { run: ChatRunSummary }) | undefined {
		for (let index = this.conversation.messages.length - 1; index >= 0; index--) {
			const message = this.conversation.messages[index];
			if (message.run?.planVersion === plan.version) { return message as ChatMessage & { run: ChatRunSummary }; }
		}
		return undefined;
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
		if (!body || body.length > MAX_USER_MESSAGE_CHARS) { throw Error('HARNESS_CHAT_MESSAGE_INVALID'); }
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
			if (outcome.scopeUnscanned?.length) { this.conversation.messages.push(chatMessage('notice', unscannedNotice(this.t, outcome.scopeUnscanned), { tone: 'info', provider })); }
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
		this.conversation.messages.push(chatMessage('notice', this.t('Plan v{0} aprobado. Ejecutando con {1}.', String(plan.version), providerLabel(provider)), { tone: 'info', provider }));
		await this.execute(plan, provider, buildImplementationInstruction(plan, this.conversation.messages, this.context));
	}

	/**
	 * Continue = finish a partial run of the latest plan with the approval the user already gave. Claude resumes its own
	 * session when the same provider is selected; otherwise a fresh run gets the plan and the files already changed.
	 */
	async continueRun(messageId: string): Promise<void> {
		if (this.activity) { throw Error('HARNESS_ALREADY_RUNNING'); }
		await this.refreshContext();
		const state = this.snapshot();
		const plan = latestPlanMessage(this.conversation.messages)?.plan;
		const previous = this.conversation.messages.find(message => message.id === messageId)?.run;
		if (!plan || !previous || state.run?.messageId !== messageId || !state.run.continuable || !this.context) { throw Error('HARNESS_CHAT_RUN_NOT_CONTINUABLE'); }
		const provider = this.conversation.provider;
		const resumeSession = provider === 'claude' && previous.provider === 'claude' ? previous.outcome?.sessionId : undefined;
		this.conversation.messages.push(chatMessage('notice', this.t('Continuando el plan v{0} con {1}.', String(plan.version), providerLabel(provider)), { tone: 'info', provider }));
		await this.execute(plan, provider, buildContinuationInstruction(plan, previous, this.conversation.messages, !!resumeSession, this.context), { resumeSession, continued: true });
	}

	/** "Descartar cambios de esta corrida": only the files the run changed and nobody touched since; reported file by file. */
	async discardRun(messageId: string): Promise<void> {
		if (this.activity) { throw Error('HARNESS_ALREADY_RUNNING'); }
		await this.refreshContext();
		const state = this.snapshot();
		const message = this.conversation.messages.find(item => item.id === messageId);
		const diff = message?.run?.outcome?.diff;
		if (!message?.run || !diff || state.run?.messageId !== messageId || !state.run.discardable || !this.runtime.discard) { throw Error('HARNESS_CHAT_RUN_NOT_CONTINUABLE'); }
		const result = await this.runtime.discard(diff);
		message.run.discarded = true;
		this.conversation.messages.push(chatMessage('notice', this.t('Se descartaron {0} archivos de esta ejecuci\u00f3n.', String(result.discarded.length)) +
			(result.skipped.length ? ' ' + this.t('No se tocaron (ten\u00edan cambios tuyos): {0}', result.skipped.slice(0, 10).join(', ')) : ''), { tone: 'info' }));
		await this.persist();
	}

	/** Run an approved plan (fresh or continued) and record its classified outcome. Callers checked approvability. */
	private async execute(plan: ChatPlan, provider: NativeProvider, instruction: string, options: { resumeSession?: string; continued?: boolean } = {}): Promise<void> {
		const context = this.context!;
		const controller = new AbortController();
		this.activity = { kind: 'executing', provider, startedAt: new Date().toISOString(), observedBytes: 0, stage: 'preparing', planVersion: plan.version, gates: context.verification?.gates.map(gate => ({ id: gate.id, status: 'pending' as const })) ?? [] };
		this.conversation.pending = [{ kind: 'executing', startedAt: this.activity.startedAt, planVersion: plan.version, pid: process.pid }];
		const started = Date.now();
		const runHooks = this.hooks(() => controller.abort());
		try {
			await this.persist();
			const hooks: ChatImplementHooks = {
				...runHooks,
				stage: stage => { if (this.activity) { this.activity.stage = stage; this.emit(); } },
				gates: gates => { if (this.activity) { this.activity.gates = gates; this.emit(); } }
			};
			const result = await this.runtime.implement({ provider, instruction, plan, verificationRevision: context.verification?.revision, ...(options.resumeSession ? { resumeSession: options.resumeSession } : {}) }, hooks, controller.signal);
			// The agent result decides first; a passing agent is only as good as its verification.
			let status: RunStatus = result.agent.status;
			if (status === 'passed' && result.verification.status !== 'skipped') { status = result.verification.status; }
			const outcome = classifyRun({ agent: result.agent, verification: result.verification.status, diff: result.diff });
			this.conversation.messages.push(chatMessage('run', result.agent.output.trim() || this.t('El agente no devolvi\u00f3 un informe.'), {
				provider, tone: outcome.kind === 'failed' || outcome.kind === 'blocked' ? 'error' : 'info',
				run: { planVersion: plan.version, provider, status, agentStatus: result.agent.status, durationMs: Date.now() - started, verification: result.verification, outcome, ...(options.continued ? { continued: true } : {}), ...(result.agent.searches?.length ? { searches: result.agent.searches } : {}) }
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
