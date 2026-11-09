/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* One conversation per project. Sending only converses; code changes require approving the latest plan. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentOutcome } from './native-agent-execution.ts';
import { APPROVAL_ANSWERS, APPROVAL_TIMEOUT_MS, REMEMBERING_ANSWERS, type ApprovalDraft } from './native-approval.ts';
import type { ApprovalAnswer, ApprovalRequest, ApprovalRisk } from './native-permissions-types.ts';
import { ApprovalBroker, type Grant } from './runtime/approval-broker.ts';
import type { AgentQuestion, QuestionAnswers } from './runtime/contracts.ts';
import type { RecoveryNotice } from './runtime/session-manager.ts';
import type { DoctorCheck } from './native-machine-doctor.ts';
import type { NativeProvider } from './native-providers.ts';
import type { ProviderUsage } from './native-provider-output.ts';
import { liveQuota, mergeQuota, type ProviderQuota } from './native-quota.ts';
import { redactSecrets } from './native-redact.ts';
import { absorbMessages, compactionSplit } from './native-chat-memory.ts';
import { classifyRun } from './native-run-outcome.ts';
import { recoveryHint } from './native-error-catalog.ts';
import type { ActivityActionId, ActivityItem } from './native-activity-feed.ts';
import type { RunDiffSummary, RunFileChange } from './native-run-diff.ts';
import { summarizeSteps, upsertStep, type ChatStep } from './native-run-steps.ts';
import {
	buildContinuationInstruction, buildConversationDelta, buildConversationInstruction, buildDirectInstruction, buildImplementationInstruction, chatMessage, DIRECT_PLAN_VERSION, directPlan, extractChatPlan, harnessErrorCode, latestPlanMessage, MAX_USER_MESSAGE_CHARS, pendingAlive, samePlanContent,
	type ChatConversation, type ChatMessage, type ChatMode, type ChatPlan, type ChatProjectContext, type ChatRunSummary, type ChatStore, type GateSummary, type RunStatus
} from './native-chat.ts';

export type ImplementStage = 'preparing' | 'agent' | 'verifying';
export interface ChatRunHooks {
	/** Called once the provider process exists, so the session can cancel it. */
	started(cancel: () => void): void;
	progress(observedBytes: number): void;
	/** Intermediate assistant message, already redacted, when the provider streams them. */
	message?(text: string): void;
	/** What the agent is doing now: a step starts, or an earlier one (same id) changes status. */
	step?(step: ChatStep): void;
	/** A tool needs the user's approval: resolves with the answer, or `deny` when the turn ends, is cancelled or nobody answers. */
	approval?(request: ApprovalDraft): Promise<ApprovalAnswer>;
	/** The agent asks the user (native transport): resolves with the answers, or `undefined` when nobody answers. */
	question?(questions: AgentQuestion[]): Promise<QuestionAnswers | undefined>;
	/** The native runtime recovered from something the user should know (a provider session that no longer exists). */
	notice?(notice: RecoveryNotice): void;
}
/** What a turn tells the runtime about this conversation's native session. */
export interface TurnTransport {
	conversationId: string;
	/** Chat message id this turn delivers; a completed turn makes it the session's `lastInputRef`. */
	inputRef?: string;
	/** Full instruction, used instead of a follow-up when the provider had to start a new session. */
	fresh?: string;
}
/** Native transport state of one provider for this conversation (r8). */
export interface TransportState {
	native: boolean;
	/** Chat message id of the last input the native session received in a completed turn. */
	lastInputRef?: string;
	/** Why the native transport is not used (incompatible CLI); shown once. */
	reason?: string;
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
	converse(provider: NativeProvider, instruction: string, hooks: ChatRunHooks, signal: AbortSignal, transport?: TurnTransport): Promise<AgentOutcome>;
	/** `resumeSession` continues the provider session of an earlier partial run (Claude only, structured transport). */
	implement(request: { provider: NativeProvider; instruction: string; plan: ChatPlan; verificationRevision?: string; resumeSession?: string; transport?: TurnTransport }, hooks: ChatImplementHooks, signal: AbortSignal): Promise<ChatImplementOutcome>;
	/** Native transport state of `provider` for this conversation; absent or `native: false` means the structured transport. */
	transport?(provider: NativeProvider, conversationId: string): Promise<TransportState>;
	/** Fork the native session of `conversationId` into `newConversationId` (the original stays untouched). */
	fork?(provider: NativeProvider, conversationId: string, newConversationId: string): Promise<void>;
	/** Undo the files a run changed, under the same fence and lease as a writer; files the user touched are skipped. */
	discard?(diff: RunDiffSummary): Promise<{ discarded: string[]; skipped: string[] }>;
	/** Persists the rule of an "always allow" answer in the USER permissions file. */
	/** Persists an allow rule in the user's permissions file: for this project only, or for every project. */
	rememberApproval?(rule: string, scope: 'project' | 'global'): Promise<void>;
	/** Limits a provider keeps outside its run output (Codex rollouts); bounded and silent on failure. */
	readQuota?(provider: NativeProvider): Promise<ProviderQuota | undefined>;
	/** Local machine checks (Node, package manager, shell, git, gh), run before the first act turn of a session. */
	preflight?(): Promise<DoctorCheck[]>;
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
	/** Live timeline of this turn (at most 200 steps); only a short summary is kept once the run ends. */
	steps?: ChatStep[];
	stage?: ImplementStage;
	planVersion?: number;
	gates?: GateSummary[];
}
export interface ChatSnapshot {
	provider: NativeProvider;
	/** Increments whenever `messages` changes, so hosts can skip resending an unchanged history. */
	revision: number;
	/** Session and weekly usage the providers reported; absent for a provider that reported none (never a guessed zero). */
	quota?: Partial<Record<NativeProvider, ProviderQuota>>;
	messages: ChatMessage[];
	activity?: ChatActivity;
	/** Messages sent while a turn was running; each starts when the previous turn ends cleanly. */
	queue?: Array<{ id: string; text: string }>;
	plan?: { messageId: string; version: number; digest: string; approvable: boolean; blockedReason?: string };
	/** Latest run of the latest plan and what can be done with it right now. */
	run?: { messageId: string; continuable: boolean; retryable: boolean; discardable: boolean };
	/** Tool calls waiting for the user's answer; dropped (denied) when the turn ends or is cancelled. */
	approvals?: ApprovalRequest[];
	/** Questions the agent asked and the user has not answered yet; dropped (unanswered) when the turn ends. */
	questions?: Array<{ id: string; questions: AgentQuestion[] }>;
	/** Temporary grants of this project's chat (task and session), revocable from /permisos. */
	grants?: Grant[];
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

/** Messages that can wait behind the running turn. */
export const MAX_QUEUED_MESSAGES = 5;

const providerLabel = (provider: NativeProvider): string => provider === 'claude' ? 'Claude Code' : 'Codex';

interface PendingApproval { request: ApprovalRequest; resolving?: boolean; settle(answer: ApprovalAnswer): void }
interface PendingQuestion { questions: AgentQuestion[]; settle(answers: QuestionAnswers | undefined): void }

/** What a wrong yes can do, by kind; a compound shell line or a sandbox escalation is always high. */
function riskOf(draft: ApprovalDraft): ApprovalRisk {
	if (draft.kind === 'sandbox' || draft.kind === 'mcp' || draft.kind === 'git_push' || draft.kind === 'git_pr_upsert' || draft.detail.includes('shell: provider sandbox')) { return 'high'; }
	return draft.kind === 'edit' || draft.kind === 'git_fetch' || draft.kind === 'git_branch_create' ? 'low' : 'medium';
}
/** Turn-only extras of a message (mentioned file content and its notice); a queued message keeps them until it runs. */
interface SendAttachments { context?: string; notice?: string }


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
			title: activity.kind === 'thinking' ? t('Respondiendo en el chat') : activity.planVersion === DIRECT_PLAN_VERSION ? t('Ejecuci\u00f3n directa') : t('Plan v{0}: {1}', String(activity.planVersion), plans.get(activity.planVersion ?? -1) ?? ''),
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
			title: run.planVersion === DIRECT_PLAN_VERSION ? t('Ejecuci\u00f3n directa') : t('Plan v{0}: {1}', String(run.planVersion), plans.get(run.planVersion) ?? ''),
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
	private readonly approvals = new Map<string, PendingApproval>();
	private readonly questionCards = new Map<string, PendingQuestion>();
	/** Task and session grants of this project's conversation only ("esta tarea", "esta sesi\u00f3n"). */
	readonly broker: ApprovalBroker;
	private readonly queue: Array<{ id: string; text: string; mode: ChatMode; attachments: SendAttachments }> = [];
	/** The turn that just ended finished cleanly, so the queue may continue. */
	private turnOk = false;
	/** The environment preflight runs once per session, before its first act turn. */
	private preflighted = false;

	private readonly store: ChatStore;
	private readonly runtime: ChatRuntime;
	private readonly listener: (snapshot: ChatSnapshot) => void;
	private readonly t: Translate;
	private readonly defaultProvider: NativeProvider;

	constructor(store: ChatStore, runtime: ChatRuntime, listener: (snapshot: ChatSnapshot) => void, t: Translate, defaultProvider: NativeProvider = 'claude', broker = new ApprovalBroker()) {
		this.store = store; this.runtime = runtime; this.listener = listener; this.t = t; this.defaultProvider = defaultProvider; this.broker = broker;
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
			// r7 histories get their native-session identity on first load (r8).
			const identified = !this.conversation.conversationId;
			this.conversation.conversationId ??= randomUUID();
			if (recovered || interrupted.length || identified) { await this.persist(); }
			await this.refreshContext();
			// Claude reports its limits only inside a run; Codex keeps them in its rollout files, readable right away.
			await this.noteQuota('codex', undefined);
		})();
		return this.loaded;
	}

	get busy(): boolean { return !!this.activity; }

	/** Usage the provider reported for the latest turn of this window; memory only and never estimated. */
	private reportedUsage?: { provider: NativeProvider; at: string; usage: ProviderUsage };

	lastUsage(): { provider: NativeProvider; at: string; usage: ProviderUsage } | undefined { return this.reportedUsage; }

	private noteUsage(provider: NativeProvider, usage: ProviderUsage | undefined): void {
		this.reportedUsage = usage ? { provider, at: new Date().toISOString(), usage } : undefined;
	}

	/** Latest limits known per provider, from the streams of this window or the provider's own files. */
	private readonly quotas: Partial<Record<NativeProvider, ProviderQuota>> = {};

	/** Known limits of every provider whose window has not reset yet. */
	quotaStatus(): Partial<Record<NativeProvider, ProviderQuota>> {
		const known: Partial<Record<NativeProvider, ProviderQuota>> = {};
		for (const provider of ['claude', 'codex'] as const) {
			const quota = liveQuota(this.quotas[provider]);
			if (quota) { known[provider] = quota; }
		}
		return known;
	}

	/** `reported` came from the run's stream; without it the runtime may know better (a finished Codex turn updates its rollout). */
	private async noteQuota(provider: NativeProvider, reported: ProviderQuota | undefined): Promise<void> {
		let found = reported;
		if (!found && this.runtime.readQuota) {
			try { found = await this.runtime.readQuota(provider); }
			catch { /* The indicator is optional: an unreadable file just leaves it as it was. */ }
		}
		this.quotas[provider] = mergeQuota(this.quotas[provider], found);
	}

	/**
	 * Whether the newest run of the conversation (planned or direct) can be discarded, and the user-facing reason when it
	 * cannot. `discardRun` enforces the same rule, so "/deshacer" and the discard button never disagree.
	 */
	undoStatus(): { messageId?: string; discardable: boolean; reason?: string } {
		const message = [...this.conversation.messages].reverse().find(item => item.run);
		const diff = message?.run?.outcome?.diff;
		if (!message?.run) { return { discardable: false, reason: this.t('Todav\u00eda no hay ninguna ejecuci\u00f3n para deshacer.') }; }
		const messageId = message.id;
		if (this.activity) { return { messageId, discardable: false, reason: this.t('Hay una tarea en curso: esper\u00e1 a que termine o detenela.') }; }
		if (message.run.discarded) { return { messageId, discardable: false, reason: this.t('Los cambios de la \u00faltima ejecuci\u00f3n ya se descartaron.') }; }
		if (!diff?.available || diff.count === 0) { return { messageId, discardable: false, reason: this.t('La \u00faltima ejecuci\u00f3n no dej\u00f3 cambios medibles para deshacer.') }; }
		if (!this.context?.writer || !this.runtime.discard) { return { messageId, discardable: false, reason: this.t('Este proyecto no puede escribir ahora, as\u00ed que tampoco deshacer desde el chat.') }; }
		return { messageId, discardable: true };
	}

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
		const quota = this.quotaStatus();
		return {
			provider: this.conversation.provider,
			revision: this.revision,
			messages: this.conversation.messages,
			...(Object.keys(quota).length ? { quota } : {}),
			activity: this.activity ? { ...this.activity } : undefined,
			plan: current ? { messageId: current.id, version: current.plan.version, digest: current.plan.digest, approvable, blockedReason } : undefined,
			// Continue reuses the approval of a partial run; Retry runs the same approved plan again.
			run: run ? {
				messageId: run.id, continuable: approvable && run.run.outcome?.kind === 'partial', retryable: approvable,
				discardable: !this.activity && writer && !!this.runtime.discard && !!run.run.outcome?.diff.available && (run.run.outcome?.diff.count ?? 0) > 0 && !run.run.discarded
			} : undefined,
			...(this.queue.length ? { queue: this.queue.map(({ id, text }) => ({ id, text: text.slice(0, 200) })) } : {}),
			...(this.approvals.size ? { approvals: [...this.approvals.values()].map(pending => pending.request) } : {}),
			...(this.questionCards.size ? { questions: [...this.questionCards.entries()].map(([id, pending]) => ({ id, questions: pending.questions })) } : {}),
			...(this.broker.list().length ? { grants: this.broker.list() } : {}),
			writer,
			isolation: this.context?.isolation?.[this.conversation.provider],
			verification: this.context?.verification?.gates ?? []
		};
	}

	/** Why this project cannot host a writer right now (state unreadable, no writer authority, isolation not offered), if anything does. */
	private writerBlockedReason(writer: boolean): string | undefined {
		if (!this.context) { return this.t('No se pudo leer el estado del proyecto. Reintent\u00e1 en unos segundos.'); }
		if (!writer) { return writerBlockReason(this.t, this.context.writerBlock); }
		const isolation = this.context.isolation?.[this.conversation.provider];
		if (isolation && !isolation.allowed) { return this.t('Tu configuraci\u00f3n exige un aislamiento de escritura que {0} no ofrece. Eleg\u00ed el otro proveedor o ajust\u00e1 \u00abatsHarness.writerIsolation\u00bb.', providerLabel(this.conversation.provider)); }
		return undefined;
	}

	/** Why the latest plan cannot be approved right now, if anything blocks it. */
	private blockedReason(current: ChatMessage & { plan: ChatPlan }, writer: boolean): string | undefined {
		const blocked = this.writerBlockedReason(writer);
		if (blocked) { return blocked; }
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
		const previous = this.conversation.provider;
		this.conversation.provider = provider;
		// A native session never moves between providers: the other one starts its own session with this conversation as
		// explicit context, and the previous session stays resumable if the user switches back.
		if (previous !== provider && this.conversation.messages.length && (await this.transportState(provider))?.native) {
			this.conversation.messages.push(chatMessage('notice', this.t('Cambiaste a {0}: empieza su propia sesi\u00f3n y recibe el historial de esta conversaci\u00f3n como contexto. La sesi\u00f3n de {1} queda guardada si volv\u00e9s.', providerLabel(provider), providerLabel(previous)), { tone: 'info', provider }));
		}
		await this.persist();
	}

	async reset(): Promise<void> {
		if (this.activity) { throw Error('HARNESS_ALREADY_RUNNING'); }
		this.queue.length = 0;
		this.conversation.messages = [];
		this.conversation.memory = undefined;
		// A new conversation gets new native sessions; the old ones are never continued by mistake.
		this.conversation.conversationId = randomUUID();
		await this.persist({ replace: true });
	}

	/** Native transport state, or `undefined` when the runtime has none or cannot tell (then the turn is structured). */
	private async transportState(provider: NativeProvider): Promise<TransportState | undefined> {
		if (!this.runtime.transport || !this.conversation.conversationId) { return undefined; }
		try { return await this.runtime.transport(provider, this.conversation.conversationId); }
		catch { return undefined; }
	}

	/** Branch the native session of this conversation (Bifurcar): the provider forks it, the chat keeps its history. */
	async fork(): Promise<void> {
		if (this.activity) { throw Error('HARNESS_ALREADY_RUNNING'); }
		if (!this.runtime.fork || !this.conversation.conversationId) { throw Error('HARNESS_FORK_UNAVAILABLE'); }
		const next = randomUUID();
		await this.runtime.fork(this.conversation.provider, this.conversation.conversationId, next);
		this.conversation.conversationId = next;
		this.conversation.messages.push(chatMessage('notice', this.t('Bifurcaste la sesi\u00f3n de {0}: los pr\u00f3ximos mensajes contin\u00faan una copia; la sesi\u00f3n original queda guardada sin cambios.', providerLabel(this.conversation.provider)), { tone: 'info', provider: this.conversation.provider }));
		await this.persist();
	}

	cancel(): void { this.denyApprovals(); this.cancelActive?.(); }

	/** Revoke one temporary grant (or all of them); the next matching action asks again. */
	revokeGrant(rule?: string): number {
		const removed = this.broker.revoke(rule);
		if (removed) { this.emit(); }
		return removed;
	}

	/** The user's answer to a pending approval card. A stale id (the turn already ended) is ignored. */
	async resolveApproval(id: string, answer: ApprovalAnswer): Promise<void> {
		const pending = this.approvals.get(id);
		if (!pending || pending.resolving || !APPROVAL_ANSWERS.includes(answer)) { return; }
		if (REMEMBERING_ANSWERS.includes(answer) && !pending.request.rule) { return; }
		const persistent = answer === 'always' || answer === 'global';
		// Only exact rules of inspection commands may leave the project: the card says so through `global`.
		if (answer === 'global' && !pending.request.global) { return; }
		if (persistent && !this.runtime.rememberApproval) { return; }
		// Claim this card before asynchronous persistence; cancellation and timeout can still deny it.
		pending.resolving = true;
		let final = answer;
		if (persistent) {
			try {
				await this.runtime.rememberApproval?.(pending.request.rule, answer === 'global' ? 'global' : 'project');
				this.conversation.messages.push(chatMessage('notice', answer === 'global'
					? this.t('Se guard\u00f3 la regla \u00ab{0}\u00bb para todos tus proyectos (~/.armotusitio/permissions.json). Revocala con /permisos quitar {0}', redactSecrets(pending.request.rule))
					: this.t('Se guard\u00f3 la regla \u00ab{0}\u00bb en tu archivo de permisos (~/.armotusitio/permissions.json). Revocala con /permisos quitar {0}', redactSecrets(pending.request.rule)), { tone: 'info' }));
			} catch {
				final = 'once';
				this.conversation.messages.push(chatMessage('notice', this.t('No se pudo guardar la regla \u00ab{0}\u00bb; se permiti\u00f3 solo esta vez.', redactSecrets(pending.request.rule)), { tone: 'error' }));
			}
		}
		this.broker.record(pending.request.rule, final, this.activity?.provider);
		if (final === 'task' || final === 'session') {
			this.conversation.messages.push(chatMessage('notice', final === 'task'
				? this.t('Permitido hasta que termine esta tarea: \u00ab{0}\u00bb.', redactSecrets(pending.request.rule))
				: this.t('Permitido hasta que cierres el IDE, en este proyecto: \u00ab{0}\u00bb.', redactSecrets(pending.request.rule)), { tone: 'info' }));
		}
		if (this.approvals.get(id) === pending) { pending.settle(final); }
		await this.persist();
	}

	private requestApproval(draft: ApprovalDraft): Promise<ApprovalAnswer> {
		if (!this.activity || this.activity.cancelling || this.approvals.size >= 8) { return Promise.resolve('deny'); }
		// Already allowed for this run or this session: no card, the same answer as before.
		if (draft.rule && this.broker.covers(draft.rule, this.activity.provider)) { return Promise.resolve('once'); }
		const id = 'ap-' + randomBytes(8).toString('hex');
		const titles: Record<ApprovalDraft['kind'], string> = {
			run: this.t('Ejecutar un comando'), edit: this.t('Borrar o mover archivos del proyecto'), git_commit: this.t('Hacer commit'), git_push: this.t('Hacer push'),
			git_branch_create: this.t('Crear una rama'), git_pr_upsert: this.t('Crear o actualizar un pull request'), git_fetch: this.t('Traer cambios del remoto (fetch)'),
			sandbox: this.t('Ampliar los permisos del sandbox'), mcp: this.t('Usar una herramienta de un servidor MCP')
		};
		const title = titles[draft.kind];
		return new Promise<ApprovalAnswer>(resolve => {
			const timer = setTimeout(() => this.settleApproval(id, 'deny'), APPROVAL_TIMEOUT_MS);
			timer.unref();
			this.approvals.set(id, { request: { ...draft, id, title, risk: riskOf(draft) }, settle: answer => { clearTimeout(timer); this.approvals.delete(id); resolve(answer); this.emit(); } });
			this.emit();
		});
	}

	private settleApproval(id: string, answer: ApprovalAnswer): void { this.approvals.get(id)?.settle(answer); }

	private denyApprovals(): void {
		for (const id of [...this.approvals.keys()]) { this.settleApproval(id, 'deny'); }
		for (const pending of [...this.questionCards.values()]) { pending.settle(undefined); }
	}

	/** The agent asks; the card stays until the user answers, the turn ends or the approval timeout passes. */
	private requestQuestion(questions: AgentQuestion[]): Promise<QuestionAnswers | undefined> {
		if (!this.activity || this.activity.cancelling || this.questionCards.size >= 4 || !questions.length) { return Promise.resolve(undefined); }
		const id = 'qu-' + randomBytes(8).toString('hex');
		return new Promise(resolve => {
			const timer = setTimeout(() => this.questionCards.get(id)?.settle(undefined), APPROVAL_TIMEOUT_MS);
			timer.unref();
			this.questionCards.set(id, { questions, settle: answers => { clearTimeout(timer); this.questionCards.delete(id); resolve(answers); this.emit(); } });
			this.emit();
		});
	}

	/** The user chose not to answer: the agent is told so and decides by itself. */
	skipQuestion(id: string): void { this.questionCards.get(id)?.settle(undefined); }

	/** The user's answers to a question card; a stale id, a missing answer or an unknown option is ignored. */
	resolveQuestion(id: string, answers: QuestionAnswers): void {
		const pending = this.questionCards.get(id);
		if (!pending || !answers || typeof answers !== 'object') { return; }
		const clean: QuestionAnswers = {};
		for (const question of pending.questions) {
			const given = answers[question.id];
			if (!Array.isArray(given) || !given.length || given.length > Math.max(1, question.options.length) || !given.every(value => typeof value === 'string' && value.trim() && value.length <= 2000)) { return; }
			if (!question.multiSelect && given.length > 1) { return; }
			if (!question.allowOther && !given.every(value => question.options.some(option => option.label === value))) { return; }
			clean[question.id] = given.map(value => value.trim());
		}
		pending.settle(clean);
	}

	/** Local, non-AI entries (slash command results, environment warnings) shown in the same timeline. */
	async note(body: string, tone: 'info' | 'error' = 'info'): Promise<void> {
		this.conversation.messages.push(chatMessage('notice', body, { tone }));
		await this.persist();
	}

	/**
	 * Send = converse, or act when `mode` is 'act' and the project can host a writer. A direct run has no plan card:
	 * it goes through the same guarded writer pipeline (fence, lease, diff, verification) as an approved plan.
	 */
	async send(input: string, mode: ChatMode = 'ask', attachments: SendAttachments = {}): Promise<void> {
		const body = typeof input === 'string' ? input.trim() : '';
		if (!body || body.length > MAX_USER_MESSAGE_CHARS) { throw Error('HARNESS_CHAT_MESSAGE_INVALID'); }
		if (this.activity) {
			if (this.queue.length >= MAX_QUEUED_MESSAGES) { throw Error('HARNESS_CHAT_QUEUE_FULL'); }
			this.queue.push({ id: randomBytes(6).toString('hex'), text: redactSecrets(body), mode, attachments });
			this.emit();
			return;
		}
		this.turnOk = false;
		const provider = this.conversation.provider;
		// Credentials pasted by mistake are neither stored nor sent to the provider.
		this.conversation.messages.push(chatMessage('user', redactSecrets(body)));
		// Mentioned file content is for this turn only: the history keeps the `@path` text, not the file. The notice is recorded
		// after the instruction exists because the instruction builders require the user message to be the last one.
		const withAttachments = (instruction: string): string => {
			if (attachments.notice) { this.conversation.messages.push(chatMessage('notice', attachments.notice, { tone: 'info' })); }
			return attachments.context ? instruction + '\n\n' + attachments.context : instruction;
		};
		this.activity = { kind: 'thinking', provider, startedAt: new Date().toISOString(), observedBytes: 0 };
		this.conversation.pending = [{ kind: 'thinking', startedAt: this.activity.startedAt, pid: process.pid }];
		const controller = new AbortController();
		const hooks = this.hooks(() => controller.abort());
		// Every failure after the activity starts, including storage, must end in `finally` and clear it.
		try {
			await this.persist();
			await this.refreshContext();
			if (!this.context) { throw Error('HARNESS_CHAT_CONTEXT_UNAVAILABLE'); }
			if (controller.signal.aborted) { throw Error('HARNESS_CANCELLED_BEFORE_START'); }
			if (mode === 'act' && !this.writerBlockedReason(this.context.writer)) {
				// The instruction is built first: it requires the user message to be the latest one, and the preflight adds a notice.
				const instruction = withAttachments(buildDirectInstruction(this.conversation.messages, this.context));
				await this.preflightOnce(provider);
				this.finish();
				await this.execute(directPlan(body), provider, instruction);
				return;
			}
			const current = latestPlanMessage(this.conversation.messages)?.plan;
			const userMessageId = this.conversation.messages.at(-1)!.id;
			const full = buildConversationInstruction(this.conversation.messages, this.context, current, this.conversation.memory);
			// A persistent native session already holds the rules and the history it received: send only what is newer.
			const native = await this.transportState(provider);
			const delta = native?.native && native.lastInputRef ? buildConversationDelta(this.conversation.messages, this.context, native.lastInputRef, current) : undefined;
			const instruction = withAttachments(delta ?? full);
			const transport: TurnTransport | undefined = native?.native
				? { conversationId: this.conversation.conversationId!, inputRef: userMessageId, ...(delta ? { fresh: attachments.context ? full + '\n\n' + attachments.context : full } : {}) }
				: undefined;
			if (controller.signal.aborted) { throw Error('HARNESS_CANCELLED_BEFORE_START'); }
			const outcome = await this.runtime.converse(provider, instruction, hooks, controller.signal, transport);
			this.noteUsage(provider, outcome.usage);
			await this.noteQuota(provider, outcome.quota);
			this.turnOk = outcome.status === 'passed' && !!outcome.output.trim();
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
			await this.drainQueue();
		}
	}

	/**
	 * Environment problems surface before the first act turn of the session, with their fix, instead of as raw errors
	 * mid-turn. Warnings stay in /doctor; the turn still runs, because the user may know the problem does not apply.
	 */
	private async preflightOnce(provider: NativeProvider): Promise<void> {
		if (this.preflighted || !this.runtime.preflight) { return; }
		this.preflighted = true;
		const problems = (await this.runtime.preflight()).filter(check => check.status === 'problem');
		if (!problems.length) { return; }
		const lines = problems.map(check => '- **' + check.title + '**: ' + check.detail + (check.action ? ' ' + check.action : ''));
		this.conversation.messages.push(chatMessage('notice', this.t('Antes de empezar revis\u00e9 tu entorno y hay problemas que pueden trabar esta tarea (/doctor muestra el detalle; \u00abRevisar mi entorno\u00bb ofrece el arreglo):') + '\n\n' + lines.join('\n'), { tone: 'error', provider }));
		await this.persist();
	}

	/** Take a queued message back before it starts. */
	unqueue(id: string): void {
		const index = this.queue.findIndex(item => item.id === id);
		if (index !== -1) { this.queue.splice(index, 1); this.emit(); }
	}

	/**
	 * Start the next queued message once the turn ended cleanly; after a cancellation or a failure the queue is dropped with
	 * a notice, because those messages were written for a different state of the project.
	 */
	private async drainQueue(): Promise<void> {
		if (this.activity || !this.queue.length) { return; }
		if (!this.turnOk) {
			const dropped = this.queue.splice(0);
			this.conversation.messages.push(chatMessage('notice', this.t('Se descartaron {0} mensajes en cola porque la tarea anterior no termin\u00f3 bien: {1}', String(dropped.length), dropped.map(item => '\u00ab' + item.text.slice(0, 80) + '\u00bb').join(' ')), { tone: 'info' }));
			await this.persist();
			return;
		}
		const next = this.queue.shift()!;
		await this.send(next.text, next.mode, next.attachments);
	}

	/** The listed file of a run, if that run changed it; hosts validate a webview request against it before touching the file. */
	runFile(messageId: string, file: string): RunFileChange | undefined {
		return this.conversation.messages.find(item => item.id === messageId)?.run?.outcome?.diff.files.find(item => item.path === file);
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
		// A native session of the same provider still holds the partial run; the structured transport resumes Claude by id.
		const native = (await this.transportState(provider))?.native && previous.provider === provider;
		const resumeSession = !native && provider === 'claude' && previous.provider === 'claude' ? previous.outcome?.sessionId : undefined;
		this.conversation.messages.push(chatMessage('notice', this.t('Continuando el plan v{0} con {1}.', String(plan.version), providerLabel(provider)), { tone: 'info', provider }));
		await this.execute(plan, provider, buildContinuationInstruction(plan, previous, this.conversation.messages, !!resumeSession || !!native, this.context), { resumeSession, continued: true });
	}

	/** "Descartar cambios de esta corrida": only the files the run changed and nobody touched since; reported file by file. */
	async discardRun(messageId: string, paths?: readonly string[]): Promise<void> {
		if (this.activity) { throw Error('HARNESS_ALREADY_RUNNING'); }
		await this.refreshContext();
		const status = this.undoStatus();
		const message = this.conversation.messages.find(item => item.id === messageId);
		const diff = message?.run?.outcome?.diff;
		if (!message?.run || !diff || status.messageId !== messageId || !status.discardable || !this.runtime.discard) { throw Error('HARNESS_CHAT_RUN_NOT_CONTINUABLE'); }
		// A subset ("Revertir" on one file) reuses the same guarded path; files already reverted are not offered again.
		const reverted = message.run.reverted ?? [];
		const chosen = diff.files.filter(file => !reverted.includes(file.path) && (!paths || paths.includes(file.path)));
		if (!chosen.length) { throw Error('HARNESS_CHAT_RUN_NOT_CONTINUABLE'); }
		const result = await this.runtime.discard({ ...diff, files: chosen });
		message.run.reverted = [...reverted, ...result.discarded];
		message.run.discarded = !paths || diff.files.every(file => message.run!.reverted!.includes(file.path));
		this.conversation.messages.push(chatMessage('notice', this.t('Se descartaron {0} archivos de esta ejecuci\u00f3n.', String(result.discarded.length)) +
			(result.discarded.length ? ' ' + this.t('Revertidos: {0}', result.discarded.slice(0, 10).join(', ')) : '') +
			(result.skipped.length ? ' ' + this.t('No se tocaron (ten\u00edan cambios tuyos): {0}', result.skipped.slice(0, 10).join(', ')) : ''), { tone: 'info' }));
		await this.persist();
	}

	/** Run an approved plan (fresh or continued) and record its classified outcome. Callers checked approvability. */
	private async execute(plan: ChatPlan, provider: NativeProvider, instruction: string, options: { resumeSession?: string; continued?: boolean } = {}): Promise<void> {
		const context = this.context!;
		const controller = new AbortController();
		this.activity = { kind: 'executing', provider, startedAt: new Date().toISOString(), observedBytes: 0, stage: 'preparing', planVersion: plan.version, gates: context.verification?.gates.map(gate => ({ id: gate.id, status: 'pending' as const })) ?? [] };
		this.conversation.pending = [{ kind: 'executing', startedAt: this.activity.startedAt, planVersion: plan.version, pid: process.pid }];
		this.turnOk = false;
		const started = Date.now();
		const runHooks = this.hooks(() => controller.abort());
		try {
			await this.persist();
			const hooks: ChatImplementHooks = {
				...runHooks,
				stage: stage => { if (this.activity) { this.activity.stage = stage; this.emit(); } },
				gates: gates => { if (this.activity) { this.activity.gates = gates; this.emit(); } }
			};
			// A native writer turn continues the conversation's session; everything up to the latest message is in its input.
			const native = !options.resumeSession && (await this.transportState(provider))?.native;
			const transport: TurnTransport | undefined = native ? { conversationId: this.conversation.conversationId!, inputRef: this.conversation.messages.at(-1)?.id } : undefined;
			const result = await this.runtime.implement({ provider, instruction, plan, verificationRevision: context.verification?.revision, ...(options.resumeSession ? { resumeSession: options.resumeSession } : {}), ...(transport ? { transport } : {}) }, hooks, controller.signal);
			this.noteUsage(provider, result.agent.usage);
			await this.noteQuota(provider, result.agent.quota);
			// The agent result decides first; a passing agent is only as good as its verification.
			let status: RunStatus = result.agent.status;
			if (status === 'passed' && result.verification.status !== 'skipped') { status = result.verification.status; }
			const outcome = classifyRun({ agent: result.agent, verification: result.verification.status, diff: result.diff });
			this.turnOk = status === 'passed' && !controller.signal.aborted;
			const steps = this.activity?.steps?.length ? summarizeSteps(this.activity.steps) : undefined;
			this.conversation.messages.push(chatMessage('run', result.agent.output.trim() || this.t('El agente no devolvi\u00f3 un informe.'), {
				provider, tone: outcome.kind === 'failed' || outcome.kind === 'blocked' ? 'error' : 'info',
				run: { planVersion: plan.version, provider, status, agentStatus: result.agent.status, durationMs: Date.now() - started, verification: result.verification, outcome, ...(options.continued ? { continued: true } : {}), ...(steps ? { steps } : {}), ...(result.agent.searches?.length ? { searches: result.agent.searches } : {}) }
			}));
		} catch (error) {
			this.conversation.messages.push(chatMessage('notice', this.errorNotice(error), { tone: cancelledBeforeStart(error) ? 'info' : 'error', provider }));
		} finally {
			this.finish();
			await this.persist();
			await this.drainQueue();
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
			message: text => { if (this.activity) { this.activity.partial = text.length > 8000 ? text.slice(-8000) : text; this.emit(); } },
			step: step => { if (this.activity) { this.activity.steps = upsertStep(this.activity.steps ?? [], step); this.emit(); } },
			approval: request => this.requestApproval(request),
			question: questions => this.requestQuestion(questions),
			notice: notice => {
				// Only what changes the user's picture is shown: a provider session that had to start over.
				if (notice.kind !== 'new-session') { return; }
				this.conversation.messages.push(chatMessage('notice', this.t('La sesi\u00f3n anterior ya no existe en el proveedor: empez\u00f3 una nueva con el historial de esta conversaci\u00f3n como contexto.'), { tone: 'info', provider: this.activity?.provider }));
				this.emit();
			}
		};
	}

	private finish(): void {
		this.denyApprovals();
		this.activity = undefined; this.cancelActive = undefined; this.conversation.pending = undefined; this.broker.endTask();
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
