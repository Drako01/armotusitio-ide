/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Autonomous goals in the editor (blocks L, N, O, R, T, U, Y, Z, AA, AB): the goal command and its charter, the run of
 * one goal with its environment and delivery, interrupted goals, inline review, decisions and long processes.
 * The guarded agent launch, caches and system commands come from the native integration.
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { currentToolchainEnvironment, pathExists } from './native-toolchain-env.ts';
import { detectEcosystems, type Subproject } from './native-ecosystems.ts';
import type { ActivityFeed } from './native-activity-feed.ts';
import type { AgentOutcome } from './native-agent-execution.ts';
import type { NativeProvider } from './native-providers.ts';
import { inCharterScope, type GoalCharter } from './native-goal.ts';
import { FileGoalJournal, interruptedOnLoad, type GoalState } from './native-goal-journal.ts';
import { GoalOrchestrator, defaultCharter, type GoalReport } from './native-orchestrator.ts';
import { createGoalPorts, goalActivityItems, inferGoalOptions } from './native-goal-runtime.ts';
import { proposeDefinitionOfDone } from './native-dod.ts';
import type { ResultCache } from './native-result-cache.ts';
import { runCommand } from './native-command-runner.ts';
import { parseExcludedPorts, type DoctorCheck, type Exec } from './native-machine-doctor.ts';
import { createEnvironment, type EnvironmentTemplate } from './native-ephemeral-env.ts';
import { offlineEnvironment, syncCommands } from './native-dependency-sync.ts';
import { DecisionLog, decisionsPrompt } from './native-decisions.ts';
import { GoalUsageHistory, estimateCalls, quotaCheck, type GoalEstimate } from './native-goal-budget.ts';
import { notifyWebhook, publishProcesses, readProcesses, type ProcessView } from './native-process-monitor.ts';
import { integrationOrder, linkedPullRequestsSection, repoPartInstruction, type RepoDelivery } from './native-multi-repo.ts';
import { cardKeyOf, cardObjective, commentMilestone, readCard, type CardClient, type CardContext } from './native-card-goal.ts';
import { reviewObjective, reviewTasks, threadStates, type ReviewComment } from './native-review-comments.ts';
import { acceptDelivery, commitMessage, commitStep, createDelivery, deliveryFiles, deliveryPackage, discardDelivery, pullRequestDescription, type Delivery } from './native-delivery.ts';
import { harnessErrorCode } from './native-chat.ts';
import { inspectHarnessAuthority } from './native-authority.ts';
import { loadProjectConfig } from './native-project.ts';
import { readProjectCapabilities } from './native-engine-contract.ts';
import { readProviderInvocationQuota } from './native-provider-quota.ts';

type Host = any; // vscode host is injected by the existing extension (avoid duplicating the UI layer).

/** One agent run of a goal: read-only roles plan and review; the implementer gets the tool server limited to the charter. */
export interface GoalAgentRequest { provider: NativeProvider; readOnly: boolean; instruction: string; resumeSession?: string; maxTurns: number }

export interface GoalIntegrationDeps {
	context: Host;
	vscode: Host;
	controller: Host;
	metricsDirectory(root: string): string;
	ensureTrust(): boolean;
	showError(error: unknown): void;
	commandExtras(): string[];
	providerCallsPer24h(folder: Host): number;
	resultCache(root: string): Promise<ResultCache>;
	environmentTemplates(root: string): Promise<EnvironmentTemplate[]>;
	systemExec: Exec;
	doctorFor(root: string): Promise<DoctorCheck[]>;
	servicePreflight(root: string): Promise<boolean>;
	/** The integration's guarded launch; `extraEnv` reaches the implementer's commands (offline modes, environment). */
	launchAgent(folder: Host, workRoot: string, request: GoalAgentRequest, scope: { inScope(file: string): boolean; extraEnv: Record<string, string> }): Promise<AgentOutcome>;
}

/** A goal running in this window: how to stop it, its pending question round, and the files the user saved meanwhile. */
interface LiveGoal {
	folder: Host;
	control?: 'pause' | 'stop';
	answer?: (answers: string[] | undefined) => void;
	questions?: string[];
	root?: string;
	saved?: Set<string>;
	files?: Set<string>;
}
interface GoalRunOptions { delivery?: Delivery; card?: CardContext; linked?: string }
interface GoalResult { status: string; delivery?: Delivery }

const firstLine = (text: string, length: number): string => text.split('\n')[0].slice(0, length);
const relativeTo = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');

/** Registers the goal commands and returns how many goals are running, for the IDE's activity count. */
export function registerGoalIntegration(deps: GoalIntegrationDeps): { running(): number } {
	const { context, vscode, controller, metricsDirectory, showError } = deps;
	const t = (message: string, ...args: string[]): string => vscode.l10n.t(message, ...args);
	const log = vscode.window.createOutputChannel?.('ArmotuSitio Harness: objetivos', { log: true });
	if (log) { context.subscriptions.push(log); }
	/** Side work of a goal (decisions, card comments, history, commits): a failure never stops the goal, and it is logged. */
	const bestEffort = async <T>(work: Promise<T>, what: string): Promise<T | undefined> => {
		try { return await work; } catch (error) { log?.warn(what + ': ' + harnessErrorCode(error)); return undefined; }
	};
	const feed = (): ActivityFeed | undefined => controller.activityFeed;

	/** Phone notification through the user's webhook (block Y): title and state only, https only, never code or output. */
	const notifyWebhookSetting = async (title: string, state: string): Promise<void> => {
		const url: unknown = vscode.workspace.getConfiguration('atsHarness').get('notifyWebhook', '');
		if (typeof url === 'string' && url) { await bestEffort(notifyWebhook(url, title, state), 'webhook'); }
	};
	/** A notification with one action; it also reaches the webhook. */
	const notify = (title: string, state: string, detail: string, action?: () => unknown): void => {
		void notifyWebhookSetting(title, state);
		const label = t('Responder');
		void vscode.window.showInformationMessage(title + ': ' + detail, ...(action ? [label] : [])).then((choice: string | undefined) => { if (choice && action) { void action(); } });
	};
	/** Work Management client for card goals (block U); the extension wires it when MCP is enabled. */
	const cardClient = (): CardClient => {
		const client = controller.mcpClient;
		if (!client) { throw Error('HARNESS_UNSUPPORTED'); }
		return { tools: () => client.tools(), call: (name, args) => client.call(name, args) };
	};

	// --- Inline review of a delivery (block Z) ---
	/** Deliveries waiting for the user's decision, by worktree: Accept, Discard or an inline review cycle. */
	const deliveries = new Map<string, { delivery: Delivery; folder: Host; charter: GoalCharter }>();
	const deliveryOf = (file: string): string | undefined => [...deliveries.keys()].find(worktree => file.startsWith(worktree + path.sep));
	const reviewController = vscode.comments?.createCommentController?.('atsHarness.review', t('Revisi\u00f3n del Harness'));
	if (reviewController) {
		context.subscriptions.push(reviewController);
		// Comments are allowed on any line of a delivery's files, and nowhere else.
		reviewController.commentingRangeProvider = { provideCommentingRanges: (document: Host) => deliveryOf(document.uri.fsPath) ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)] : [] };
	}
	const reviewThreads = new Map<string, Host[]>();
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.reviewComment', (reply: Host) => {
		const thread = reply.thread;
		thread.comments = [...thread.comments, { body: new vscode.MarkdownString(reply.text), mode: vscode.CommentMode.Preview, author: { name: t('Vos') } }];
		const worktree = deliveryOf(thread.uri.fsPath);
		if (worktree) { reviewThreads.set(worktree, [...(reviewThreads.get(worktree) ?? []).filter(item => item !== thread), thread]); }
	}));
	/** Open the files of a delivery for review; comments are added with the editor's comment UI. */
	const openInlineReview = async (delivery: Delivery, files: readonly string[]): Promise<void> => {
		for (const file of files.slice(0, 20)) { await bestEffort(Promise.resolve(vscode.window.showTextDocument(vscode.Uri.file(path.join(delivery.worktree, file)), { preview: false, preserveFocus: true })), 'open ' + file); }
		void vscode.window.showInformationMessage(t('Coment\u00e1 las l\u00edneas que quieras cambiar y us\u00e1 \u00abArmoTuSitio: Enviar revisi\u00f3n de la entrega\u00bb.'));
	};
	/** Send the review: one correction task per comment, run as a new cycle on the same branch; threads resolve when verified. */
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.submitReview', async () => {
		try {
			const [worktree, threads] = [...reviewThreads.entries()].find(([, items]) => items.length) ?? [];
			const pending = worktree && deliveries.get(worktree);
			if (!pending || !threads) { void vscode.window.showInformationMessage(t('No hay comentarios de revisi\u00f3n pendientes.')); return; }
			const comments: ReviewComment[] = threads.map((thread, index) => ({
				id: String(index), file: relativeTo(worktree, thread.uri.fsPath), line: thread.range.start.line + 1,
				text: thread.comments.map((comment: Host) => typeof comment.body === 'string' ? comment.body : comment.body.value).join('\n')
			}));
			const result = await runGoal(pending.folder, { ...pending.charter, objective: reviewObjective(pending.charter.objective, reviewTasks(comments)), size: 'small' }, { delivery: pending.delivery });
			const changed = new Set(await bestEffort(deliveryFiles(pending.delivery), 'list delivery files') ?? []);
			const states = threadStates(comments, changed, result?.status === 'completed', () => undefined);
			threads.forEach((thread, index) => { if (states[String(index)] === 'resolved') { thread.state = vscode.CommentThreadState?.Resolved; } });
			reviewThreads.set(worktree, threads.filter((_, index) => states[String(index)] !== 'resolved'));
		} catch (error) { showError(error); }
	}));

	// --- Long processes reported through progress files (block Y) ---
	const processDirectory = path.join(context.globalStorageUri?.fsPath ?? os.tmpdir(), 'processes');
	context.environmentVariableCollection?.replace?.('ATS_PROGRESS_DIR', processDirectory);
	const processStates = new Map<string, ProcessView['state']>();
	const PROCESS_END: Partial<Record<ProcessView['state'], string>> = { stalled: t('parece trabado'), completed: t('termin\u00f3') };
	const processTimer = setInterval(() => {
		const current = feed();
		if (!current?.publish) { return; }
		const stallMinutes = Number(vscode.workspace.getConfiguration('atsHarness').get('stallMinutes', 15)) || 15;
		void bestEffort(readProcesses(processDirectory, stallMinutes), 'read progress files').then(views => {
			for (const view of publishProcesses(current, views ?? [], 'IDE', processStates)) { notify(view.title, view.state, PROCESS_END[view.state] ?? t('se detuvo')); }
		});
	}, 5000);
	processTimer.unref?.();
	context.subscriptions.push({ dispose: () => clearInterval(processTimer) });

	// --- Live goals, user saves and explorer marks (block O) ---
	const goals = new Map<string, LiveGoal>();
	// User saves inside a goal's tree are recorded so a step that also changed the file stops in conflict.
	if (vscode.workspace.onDidSaveTextDocument) {
		context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document: Host) => {
			for (const goal of goals.values()) {
				if (goal.root && goal.saved && document.uri.fsPath.startsWith(goal.root + path.sep)) { goal.saved.add(relativeTo(goal.root, document.uri.fsPath)); }
			}
		}));
	}
	// The explorer marks the files a goal is changing, so the user sees where the Harness works.
	const decorationsChanged = vscode.EventEmitter ? new vscode.EventEmitter() : undefined;
	if (decorationsChanged && vscode.window.registerFileDecorationProvider) {
		const working = (file: string): boolean => [...goals.values()].some(goal => !!goal.root && !!goal.files?.has(relativeTo(goal.root, file)));
		context.subscriptions.push(decorationsChanged, vscode.window.registerFileDecorationProvider({
			onDidChangeFileDecorations: decorationsChanged.event,
			provideFileDecoration: (uri: Host) => working(uri.fsPath) ? { badge: '●', tooltip: t('El Harness est\u00e1 trabajando en este archivo') } : undefined
		}));
	}
	const askGoal = async (goalId: string): Promise<void> => {
		const goal = goals.get(goalId);
		if (!goal?.answer || !goal.questions) { return; }
		const answers: string[] = [];
		for (const question of goal.questions) {
			const answer = await vscode.window.showInputBox({ title: t('El objetivo necesita tu respuesta'), prompt: question, ignoreFocusOut: true });
			if (answer === undefined) { return; }
			answers.push(answer);
		}
		const resolve = goal.answer; goal.answer = undefined; goal.questions = undefined;
		resolve(answers);
	};

	// --- One goal, from charter to delivery ---
	/** The ephemeral environment the charter names (block W), on ports Windows has not reserved. */
	const createGoalEnvironment = async (root: string, charter: GoalCharter, goalId: string) => {
		const template = charter.environment ? (await deps.environmentTemplates(root)).find(item => item.name === charter.environment) : undefined;
		if (!template) { return undefined; }
		const reserved = process.platform === 'win32' ? await bestEffort(deps.systemExec('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp']), 'read reserved ports') : undefined;
		return createEnvironment({ template, goalId, exec: deps.systemExec, excludedPorts: parseExcludedPorts(reserved?.output ?? '') });
	};
	/**
	 * D5: the IDE installs from the lockfiles first (only cache-filling steps in the user's own checkout); once every
	 * step passed, commands go offline. A failed step leaves the network modes as they are and is logged.
	 */
	const syncDependencies = async (workRoot: string, subprojects: Subproject[], inWorktree: boolean, env: NodeJS.ProcessEnv, logDirectory: string): Promise<Record<string, string>> => {
		let synced = true;
		for (const sync of (await syncCommands(workRoot, subprojects)).filter(item => inWorktree || item.cacheOnly)) {
			const result = await bestEffort(runCommand({ root: workRoot, cwd: sync.cwd, command: sync.command, args: sync.args, env, logDirectory, timeoutSec: 900 }), 'dependency sync ' + sync.command);
			if (result?.exitCode !== 0) { synced = false; log?.warn('dependency sync ' + sync.command + ' in ' + sync.cwd + ' did not pass; commands keep network modes'); }
		}
		return synced ? offlineEnvironment() : {};
	};
	const definitionOfDone = async (workRoot: string, subprojects: Subproject[]) => {
		const migrations = await Promise.all(['.', ...subprojects.map(project => project.path)].map(folder => pathExists(path.join(workRoot, folder, 'migrations'))));
		return proposeDefinitionOfDone({ subprojects, hasMigrations: migrations.some(Boolean), hasApiContract: await pathExists(path.join(workRoot, 'openapi.yaml')), hasUi: subprojects.some(project => project.ecosystem === 'node') });
	};
	/** After a goal: the delivery package, the card milestone, and the user's choice (open, review inline, accept, discard). */
	const deliverGoal = async (input: { folder: Host; charter: GoalCharter; options: GoalRunOptions; report: GoalReport; state: GoalState; delivery?: Delivery; packageFile: string }): Promise<void> => {
		const { folder, charter, options, report, state, delivery, packageFile } = input;
		const files = delivery ? await bestEffort(deliveryFiles(delivery), 'list delivery files') ?? [] : [];
		const content = { state, spec: report.spec, done: report.done, files, ...(options.card ? { card: options.card.key } : {}) };
		await fs.writeFile(packageFile, deliveryPackage(content) + (options.linked ? '\n' + options.linked : '') + '\n## Descripci\u00f3n de PR\n\n' + pullRequestDescription(content) + (options.linked ?? ''));
		if (options.card && report.status === 'completed') { await bestEffort(commentMilestone(cardClient(), options.card, t('Entrega lista en la rama {0}.', delivery?.branch ?? '')), 'card milestone'); }
		if (delivery) { deliveries.set(delivery.worktree, { delivery, folder, charter }); }
		const title = firstLine(charter.objective, 80);
		const message = report.status === 'completed' ? t('Objetivo terminado: {0}', title) : t('El objetivo se detuvo ({0}): {1}', report.reason ?? report.status, title);
		void notifyWebhookSetting(message, report.status);
		// A part of a multi-repo goal reports to its coordinator instead of asking.
		if (options.linked) { return; }
		const open = t('Abrir entrega'), accept = t('Aceptar'), discard = t('Descartar'), review = t('Revisar inline');
		const choice = await vscode.window.showInformationMessage(message, open, ...(delivery ? [review, accept, discard] : []));
		if (choice === open) { await vscode.window.showTextDocument(vscode.Uri.file(packageFile)); }
		if (!delivery) { return; }
		if (choice === review) { await openInlineReview(delivery, files); }
		if (choice === accept) {
			const result = await acceptDelivery(delivery);
			if (result.integrated) { deliveries.delete(delivery.worktree); }
			else { void vscode.window.showWarningMessage(t('No se integr\u00f3: ten\u00e9s cambios sin guardar en {0}. La rama {1} queda lista para abrir un PR.', result.conflicts.slice(0, 3).join(', '), delivery.branch)); }
		}
		if (choice === discard) { await discardDelivery(delivery); deliveries.delete(delivery.worktree); }
	};
	/** Run one approved charter to the end in the background; the feed and notifications report it. */
	const runGoal = async (folder: Host, charter: GoalCharter, options: GoalRunOptions = {}): Promise<GoalResult | undefined> => {
		const root = await fs.realpath(folder.uri.fsPath);
		const goalId = Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
		const live: LiveGoal = { folder };
		goals.set(goalId, live);
		const storage = path.join(metricsDirectory(root), 'goals');
		let environment: Awaited<ReturnType<typeof createGoalEnvironment>>;
		try {
			const delivery = options.delivery ?? (charter.delivery === 'working-tree' ? undefined : await createDelivery(root, path.join(metricsDirectory(root), 'deliveries'), charter.objective));
			const decisions = new DecisionLog(metricsDirectory(root));
			// Decisions in force reach every agent; the analyst asks when the request contradicts one (AA).
			charter = { ...charter, objective: charter.objective + decisionsPrompt(await bestEffort(decisions.relevant(), 'read decisions') ?? []) };
			const workRoot = delivery?.worktree ?? root;
			live.root = workRoot; live.saved = new Set(); live.files = new Set();
			const authority = await inspectHarnessAuthority(workRoot);
			const delegate = authority.engine === 'project' && (await bestEffort(readProjectCapabilities(workRoot), 'read project capabilities') ?? []).includes('command-runner');
			const subprojects = await detectEcosystems(workRoot);
			const config = authority.engine === 'ide-native' ? await bestEffort(loadProjectConfig(workRoot), 'read project configuration') : undefined;
			environment = await createGoalEnvironment(root, charter, goalId);
			const baseEnv = (await currentToolchainEnvironment()).env;
			const offline = await syncDependencies(workRoot, subprojects, !!delivery, baseEnv, path.join(storage, goalId + '-sync'));
			const extraEnv = { ...offline, ...environment?.exports };
			const ports = createGoalPorts({
				root: workRoot, projectName: folder.name, charter, goalId, feed: feed(),
				policy: { subprojects, delegate, extras: deps.commandExtras() }, env: { ...baseEnv, ...extraEnv },
				logDirectory: path.join(storage, goalId + '-logs'),
				gates: (config?.plan.gates ?? []).map(gate => ({ id: gate.id, command: gate.executable, args: gate.args, cwd: gate.cwd || '.' })),
				definitionOfDone: await definitionOfDone(workRoot, subprojects),
				stopRequested: () => goals.get(goalId)?.control,
				cache: await deps.resultCache(workRoot),
				userSaved: live.saved,
				ask: questions => new Promise(resolve => {
					live.questions = questions;
					// Each answer becomes a project decision, so the next goal does not ask it again (AA).
					live.answer = answers => {
						for (const [index, question] of answers ? questions.entries() : []) {
							void bestEffort(decisions.record({ title: question.slice(0, 120), context: firstLine(charter.objective, 300), decision: answers![index] ?? '', alternatives: [], scope: [], source: 'answer' }), 'record decision');
						}
						resolve(answers);
					};
					notify(t('El objetivo necesita tu respuesta'), 'answer', questions[0].slice(0, 120), () => askGoal(goalId));
				}),
				launch: request => deps.launchAgent(folder, workRoot, request, { inScope: file => inCharterScope(charter, file), extraEnv }),
				// A branch delivery gets one commit per accepted step, made by the orchestrator (D7).
				afterStep: async state => {
					const step = state.steps.at(-1)!;
					for (const file of step.outcome?.diff.files ?? []) { live.files!.add(file.path); }
					decorationsChanged?.fire(undefined);
					if (delivery) { await bestEffort(commitStep(delivery, commitMessage('test', step.title)), 'commit step'); }
				}
			});
			void bestEffort(decisions.record({ title: 'Carta: ' + firstLine(charter.objective, 100), context: 'Carta aprobada', decision: firstLine(charter.objective, 300) + (charter.allowProduction ? '' : ' (sin tocar producci\u00f3n)'), alternatives: [], scope: charter.scope.flatMap(rule => rule.allow ?? []), source: 'charter' }), 'record charter');
			if (options.card) { await bestEffort(commentMilestone(cardClient(), options.card, t('Plan aprobado: el Harness empez\u00f3 a trabajar en esta card.')), 'card milestone'); }
			const report = await new GoalOrchestrator(new FileGoalJournal(storage, goalId), ports, goalId).run(charter, delivery?.base);
			await bestEffort(new GoalUsageHistory(metricsDirectory(root)).record({ size: charter.size, tasks: Math.max(1, report.steps), calls: report.runs, at: new Date().toISOString() }), 'record usage');
			const state = await new FileGoalJournal(storage, goalId).load(goalId);
			await deliverGoal({ folder, charter, options, report, state, delivery, packageFile: path.join(storage, goalId + '-entrega.md') });
			return { status: report.status, delivery };
		} catch (error) { showError(error); return undefined; }
		finally { goals.delete(goalId); decorationsChanged?.fire(undefined); await environment?.destroy(); }
	};

	// --- Goals interrupted by a closed IDE (block N) and feed actions (block AC) ---
	const interrupted = new Map<string, { folder: Host; state: GoalState }>();
	const scanInterrupted = async (): Promise<void> => {
		if (!deps.ensureTrust()) { return; }
		for (const folder of vscode.workspace.workspaceFolders || []) {
			const root = await bestEffort(fs.realpath(folder.uri.fsPath), 'resolve ' + folder.name);
			if (!root) { continue; }
			const storage = path.join(metricsDirectory(root), 'goals');
			for (const goalId of (await FileGoalJournal.list(storage)).slice(0, 20)) {
				if (goals.has(goalId)) { continue; }
				const loaded = await bestEffort(new FileGoalJournal(storage, goalId).load(goalId), 'read goal journal ' + goalId);
				const state = loaded && interruptedOnLoad(loaded);
				if (state?.status !== 'interrupted') { continue; }
				interrupted.set(goalId, { folder, state });
				for (const item of goalActivityItems(state, folder.name)) { feed()?.publish?.(item); }
			}
		}
	};
	void bestEffort(scanInterrupted(), 'scan interrupted goals');
	/** Resuming starts from the state the journal recorded: the applied diff stays and done steps are not repeated. */
	const resumeGoal = async (goalId: string, previous: { folder: Host; state: GoalState }): Promise<void> => {
		interrupted.delete(goalId);
		// The old journal is closed so the next start does not offer it again.
		const oldStorage = path.join(metricsDirectory(await fs.realpath(previous.folder.uri.fsPath)), 'goals');
		await bestEffort(new FileGoalJournal(oldStorage, goalId).append({ type: 'state', at: new Date().toISOString(), status: 'cancelled', reason: 'resumed' }), 'close resumed journal');
		const done = previous.state.steps.filter(step => step.status === 'done').map(step => '- ' + step.title);
		const note = '\n\nThis goal was interrupted (the IDE closed). Steps already done, do not repeat them:\n' + (done.join('\n') || '- none') + '\nInspect the current state of the files before continuing.';
		void runGoal(previous.folder, { ...previous.state.charter, objective: previous.state.charter.objective + note });
	};
	/** Feed actions on a goal item (Inicio): answer, stop, and continue an interrupted goal. */
	controller.goalAct = async (itemId: string, action: string): Promise<boolean> => {
		const goalId = /^goal:(?<id>[a-z0-9-]{1,64})$/.exec(itemId)?.groups?.id;
		const goal = goalId ? goals.get(goalId) : undefined;
		const previous = goalId ? interrupted.get(goalId) : undefined;
		if (!goalId || (!goal && !previous)) { return false; }
		if (goal && action === 'answer') { await askGoal(goalId); }
		if (goal && action === 'stop') { goal.control = 'stop'; goal.answer?.(undefined); }
		if (!goal && previous && action === 'continue') { await resumeGoal(goalId, previous); }
		return true;
	};

	/** Project decisions (block AA): review, archive, or export them to `docs/adr/` as an explicit action. */
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.decisions', async () => {
		try {
			const folder = (vscode.workspace.workspaceFolders || [])[0];
			if (!folder || !deps.ensureTrust()) { return; }
			const root = await fs.realpath(folder.uri.fsPath);
			const decisionLog = new DecisionLog(metricsDirectory(root));
			const active = await decisionLog.relevant();
			const exportLabel = t('Exportar al repositorio (docs/adr)');
			const picked = await vscode.window.showQuickPick([{ label: exportLabel, id: '' }, ...active.map(item => ({ label: item.title, description: item.source + ' · ' + item.at.slice(0, 10), detail: item.decision, id: item.id }))], { title: t('Decisiones vigentes de {0}', folder.name) });
			if (!picked) { return; }
			if (picked.label === exportLabel) { const written = await decisionLog.exportAdrs(path.join(root, 'docs', 'adr')); void vscode.window.showInformationMessage(t('{0} decisiones exportadas a docs/adr.', String(written.length))); return; }
			const archive = t('Archivar');
			if (await vscode.window.showInformationMessage(picked.detail ?? '', archive) === archive) { await decisionLog.archive(picked.id); }
		} catch (error) { showError(error); }
	}));

	// --- The goal command: charter, estimate and approval ---
	/** What the user approves: objective, done criteria, limits, budget, delivery, estimate and known problems. */
	const charterDetail = (input: { objective: string; charter: GoalCharter; inferred: ReturnType<typeof inferGoalOptions>; estimate: GoalEstimate; quota: ReturnType<typeof quotaCheck>; reserve: number; card?: CardContext; repositories: string[]; problems: DoctorCheck[] }): string => {
		const { objective, charter, inferred, estimate, quota, reserve, card, repositories, problems } = input;
		return [
			t('Objetivo: {0}', objective),
			inferred.target !== undefined ? t('Terminado cuando la m\u00e9trica llegue a {0}% (la mide el IDE).', String(inferred.target)) : t('Terminado cuando se cumpla la Definici\u00f3n de Terminado.'),
			inferred.allowProduction ? t('Puede tocar c\u00f3digo de producci\u00f3n y tests.') : t('S\u00f3lo tests: el c\u00f3digo de producci\u00f3n queda prohibido.'),
			t('Prohibido: git, dependencias nuevas, publicar.'),
			t('Presupuesto: {0} corridas, {1} minutos, {2} turnos por corrida.', String(charter.budget.maxRuns), String(charter.budget.maxMinutes), String(charter.budget.maxTurnsPerRun)),
			charter.delivery === 'local-branch' ? t('Entrega: rama local con commits del orquestador; push y PR quedan para vos.') : t('Entrega: cambios en tu \u00e1rbol de trabajo.'),
			...(charter.environment ? [t('Entorno ef\u00edmero: {0}, creado y destruido por el IDE.', charter.environment)] : []),
			t('Estimaci\u00f3n: {0}\u2013{1} llamadas al proveedor ({2}).', String(estimate.low), String(estimate.high), estimate.basis === 'history' ? t('seg\u00fan tu historial') : t('valor inicial')),
			...(quota.fits ? [] : [t('⚠ La estimaci\u00f3n supera el cupo disponible ({0} llamadas, reservando {1}% para tu trabajo manual). Divid\u00ed el objetivo o us\u00e1 el otro proveedor.', String(quota.available ?? 0), String(reserve))]),
			...(card ? [t('Card {0}: {1} criterios; {2}.', card.key, String(card.criteria.length), card.canComment ? t('se comentan los hitos') : t('modo lectura'))] : []),
			...(repositories.length > 1 ? [t('Repositorios en orden: {0}.', repositories.join(' → '))] : []),
			...problems.map(check => '⚠ ' + check.title + ': ' + check.detail + (check.action ? ' ' + check.action : ''))
		].join('\n');
	};
	/** Several repositories (T): integrated in order, each with its own branch; a stop in one part stops the rest. */
	const runMultiRepo = async (folders: Host[], charter: GoalCharter, objective: string, goalObjective: string, card?: CardContext): Promise<void> => {
		const parts = integrationOrder(folders.map((item: Host, index: number) => ({ name: item.name, root: item.uri.fsPath, dependsOn: index ? [folders[index - 1].name] : [] })));
		const delivered: RepoDelivery[] = [];
		for (const part of parts) {
			const partFolder = folders.find((item: Host) => item.name === part.name)!;
			const result = await runGoal(partFolder, { ...charter, objective: repoPartInstruction(goalObjective, part, parts, delivered) }, { linked: '(multi-repo)', ...(card ? { card } : {}) });
			if (result?.delivery) { delivered.push({ name: part.name, branch: result.delivery.branch }); }
			if (result?.status !== 'completed') { notify(t('El objetivo multi-repositorio se detuvo en {0}', part.name), 'blocked', result?.status ?? 'failed'); return; }
		}
		const summary = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# ' + firstLine(objective, 200) + '\n\n' + linkedPullRequestsSection(delivered, '') });
		await vscode.window.showTextDocument(summary);
		notify(t('Objetivo multi-repositorio terminado'), 'completed', delivered.map(item => item.branch).join(', '));
	};
	/** Calls the charter needs, calibrated with local history, against the quota minus the manual reserve (AB). */
	const estimateGoal = async (folder: Host, root: string, provider: NativeProvider, charter: GoalCharter, repositories: number) => {
		const estimate = estimateCalls(charter.size, 3 * repositories, await bestEffort(new GoalUsageHistory(metricsDirectory(root)).list(), 'read usage history') ?? []);
		const cap = deps.providerCallsPer24h(folder);
		const remaining = cap > 0 ? (await readProviderInvocationQuota(metricsDirectory(root), cap)).providers[provider].remaining ?? undefined : undefined;
		const reserve = Number(vscode.workspace.getConfiguration('atsHarness').get('goalReservePercent', 20)) || 0;
		controller.quotaDescription = remaining === undefined ? t('Cupo: sin l\u00edmite local configurado') : t('Cupo de {0}: {1} llamadas restantes de {2}', provider, String(remaining), String(cap));
		return { estimate, reserve, quota: quotaCheck(estimate, remaining, cap > 0 ? cap : undefined, reserve) };
	};
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.goal', async (requested?: string, objectiveArgument?: string) => {
		try {
			if (!deps.ensureTrust()) { void vscode.window.showWarningMessage(t('Marc\u00e1 el workspace como confiable para iniciar un objetivo.')); return; }
			const folders = vscode.workspace.workspaceFolders || [];
			const folder = folders.find((item: Host) => item.uri.fsPath === requested) ?? (folders.length === 1 ? folders[0] : (await vscode.window.showWorkspaceFolderPick()));
			if (!folder) { return; }
			const objective = typeof objectiveArgument === 'string' && objectiveArgument.trim() ? objectiveArgument : await vscode.window.showInputBox({ title: t('Nuevo objetivo'), prompt: t('Una instrucci\u00f3n; el Harness trabaja solo hasta terminarla y s\u00f3lo pregunta lo indispensable.'), ignoreFocusOut: true });
			if (!objective?.trim()) { return; }
			const root = await fs.realpath(folder.uri.fsPath);
			// A card key in the instruction brings the card's description and criteria (U); without MCP it runs as plain text.
			const key = cardKeyOf(objective);
			const card = key && controller.mcp?.enabled?.() ? await bestEffort(readCard(cardClient(), key), 'read card ' + key) : undefined;
			const goalObjective = card ? cardObjective(objective, card) : objective;
			const others = folders.filter((item: Host) => item.uri.toString() !== folder.uri.toString());
			const extra = others.length ? await vscode.window.showQuickPick(others.map((item: Host) => ({ label: item.name, folder: item })), { canPickMany: true, title: t('\u00bfEl objetivo cruza otros repositorios? Eleg\u00ed en orden de integraci\u00f3n (vac\u00edo: s\u00f3lo {0})', folder.name) }) : [];
			if (extra === undefined) { return; }
			const inferred = inferGoalOptions(objective, await detectEcosystems(root));
			const branch = t('Rama local harness/… (recomendado)'), tree = t('Cambios en mi \u00e1rbol de trabajo');
			const deliveryChoice = await pathExists(path.join(root, '.git')) ? await vscode.window.showQuickPick([branch, tree], { title: t('\u00bfC\u00f3mo quer\u00e9s recibir el trabajo?') }) : tree;
			if (!deliveryChoice) { return; }
			const provider: NativeProvider = vscode.workspace.getConfiguration('atsHarness').get('goalProvider', 'claude') === 'codex' ? 'codex' : 'claude';
			const templates = await bestEffort(deps.environmentTemplates(root), 'read environment templates') ?? [];
			const none = t('Sin entorno ef\u00edmero');
			const environmentChoice = templates.length ? await vscode.window.showQuickPick([none, ...templates.map(item => item.name)], { title: t('\u00bfEl objetivo necesita un entorno ef\u00edmero?') }) : none;
			if (!environmentChoice) { return; }
			const delivery = deliveryChoice === branch || extra.length ? 'local-branch' as const : 'working-tree' as const;
			const charter: GoalCharter = { ...defaultCharter(goalObjective, provider, provider === 'claude' ? 'codex' : 'claude', { ...inferred, delivery }), ...(environmentChoice !== none ? { environment: environmentChoice } : {}) };
			const { estimate, reserve, quota } = await estimateGoal(folder, root, provider, charter, 1 + extra.length);
			// The full doctor runs before approval, so an environment problem shows now and not halfway through (X).
			const problems = (await bestEffort(deps.doctorFor(root), 'machine doctor') ?? []).filter(check => check.status === 'problem' || (charter.environment && check.id === 'docker' && check.status !== 'ok'));
			const repositories = [folder.name, ...extra.map((item: Host) => item.label)];
			const approve = t('Aprobar carta');
			const detail = charterDetail({ objective, charter, inferred, estimate, quota, reserve, card, repositories, problems });
			if (await vscode.window.showWarningMessage(t('\u00bfAprob\u00e1s esta carta?'), { modal: true, detail }, approve) !== approve) { return; }
			if (!await deps.servicePreflight(root)) { return; }
			if (extra.length) { void runMultiRepo([folder, ...extra.map((item: Host) => item.folder)], charter, objective, goalObjective, card); }
			else { void runGoal(folder, charter, card ? { card } : {}); }
		} catch (error) { showError(error); }
	}));
	return { running: () => goals.size };
}
