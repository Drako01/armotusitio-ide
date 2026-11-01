/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Deterministic goal orchestrator (blocks L and P). Code, not a model, decides what comes next from measured results:
 * the run outcome, the real diff against the charter, the integrity guards, the gates and the IDE's own metric.
 * Every effect is journaled first, so a resumed goal never repeats work it already recorded.
 */
import type { AgentOutcome } from './native-agent-execution.ts';
import type { NativeProvider } from './native-providers.ts';
import type { RunDiffSummary } from './native-run-diff.ts';
import { classifyRun, type RunOutcome } from './native-run-outcome.ts';
import { remainingBudget, validateCharter, validateStepDiff, type GoalCharter } from './native-goal.ts';
import { checkStepIntegrity, parseUnifiedDiff } from './native-goal-guards.ts';
import { oscillating, plateaued, serviceUnavailable } from './native-goal-metric.ts';
import { evaluateDefinitionOfDone, type DoneEvidence, type DoneItem, type DoneResult } from './native-dod.ts';
import { parseDesign, parseReview, parseSpec, parseVerification, roleInstruction, taskWaves, type DesignTask, type GoalRole, type Spec } from './native-roles.ts';
import type { GoalJournal, GoalState, GoalStatus } from './native-goal-journal.ts';
import type { GitBlocker, RefSnapshot } from './native-user-activity.ts';

/** Everything with an effect goes through these ports; the integration provides the guarded implementations. */
export interface GoalPorts {
	runAgent(request: { role: GoalRole; provider: NativeProvider; instruction: string; readOnly: boolean; resumeSession?: string }): Promise<{ agent: AgentOutcome; diff: RunDiffSummary; patch: string }>;
	verify(): Promise<{ status: 'passed' | 'failed' | 'cancelled' | 'skipped'; gates: Array<{ id: string; status: string }> }>;
	measure?(): Promise<number | undefined>;
	refs(): Promise<RefSnapshot>;
	blockers(): Promise<GitBlocker[]>;
	/** One grouped round of questions; resolves with the answers, or undefined when the user stopped the goal. */
	ask(questions: string[]): Promise<string[] | undefined>;
	/** Published after every journal entry: the feed, the chat and notifications read it. */
	publish(state: GoalState): void;
	now(): number;
	/** The user pressed Pause or Stop. */
	stopRequested(): 'pause' | 'stop' | undefined;
	/** Files the user saved while the step ran that the agent also changed (block O): the step goes to conflict, both changes kept. */
	userConflicts?(agentFiles: readonly string[]): string[];
	definitionOfDone: DoneItem[];
}

const MAX_AUTO_CONTINUES = 2;
const MAX_CORRECTIONS = 2;
const REVIEW_EVERY = 3;
const MIN_REVIEW_SCORE = 6;

export interface GoalReport { status: GoalStatus; reason?: string; baseline?: number; final?: number; done?: DoneResult[]; spec?: Spec; steps: number; /** Provider calls the goal used, for the quota estimate of the next ones (AB). */ runs: number }

export class GoalOrchestrator {
	private state!: GoalState;
	private readonly started: number;
	private runs = 0;
	private readonly journal: GoalJournal;
	private readonly ports: GoalPorts;
	private readonly goalId: string;
	constructor(journal: GoalJournal, ports: GoalPorts, goalId: string) { this.journal = journal; this.ports = ports; this.goalId = goalId; this.started = ports.now(); }

	private at(): string { return new Date(this.ports.now()).toISOString(); }
	private async record(entry: Parameters<GoalJournal['append']>[0]): Promise<void> {
		await this.journal.append(entry);
		this.state = await this.journal.load(this.goalId);
		this.ports.publish(this.state);
	}
	private async end(status: GoalStatus, reason?: string): Promise<GoalReport> {
		await this.record({ type: 'state', at: this.at(), status, ...(reason ? { reason } : {}) });
		const metrics = this.state.steps.map(step => step.metric).filter((value): value is number => value !== undefined);
		return { status, reason, baseline: this.state.baseline, final: metrics.at(-1) ?? this.state.baseline, steps: this.state.steps.length, runs: this.runs };
	}
	private budgetLeft(): boolean {
		const left = remainingBudget(this.state.charter, this.runs, this.ports.now() - this.started);
		return left.runs > 0 && left.minutes > 0;
	}

	/** Run one step: the agent, its continuations, then the charter, the guards and the gates on what it really did. */
	private async step(title: string, role: GoalRole, instruction: string): Promise<{ outcome: RunOutcome; accepted: boolean; rejection: string[] }> {
		const index = this.state.steps.length + 1;
		await this.record({ type: 'step-start', at: this.at(), index, title, role });
		const charter = this.state.charter;
		let result = await this.ports.runAgent({ role, provider: charter.providers.preferred, instruction: instruction + '\n\n' + roleInstruction(role), readOnly: false });
		this.runs++;
		let outcome = classifyRun({ agent: result.agent, verification: 'skipped', diff: result.diff });
		let patch = result.patch;
		// A step cut by its budget continues on its own: the charter already authorized it.
		for (let attempt = 0; outcome.kind === 'partial' && attempt < MAX_AUTO_CONTINUES && this.budgetLeft(); attempt++) {
			result = await this.ports.runAgent({ role, provider: charter.providers.preferred, instruction: 'Continue the current task from where you stopped. Do not redo completed work.', readOnly: false, ...(outcome.sessionId ? { resumeSession: outcome.sessionId } : {}) });
			this.runs++;
			patch += '\n' + result.patch;
			outcome = classifyRun({ agent: result.agent, verification: 'skipped', diff: { ...result.diff, files: [...outcome.diff.files, ...result.diff.files], count: outcome.diff.count + result.diff.count } });
		}
		const rejection = [...validateStepDiff(charter, outcome.diff), ...checkStepIntegrity(parseUnifiedDiff(patch), { allowProduction: charter.allowProduction }),
		...(this.ports.userConflicts?.(outcome.diff.files.map(file => file.path)) ?? []).map(file => 'user-edit-conflict:' + file)];
		const verification = rejection.length ? undefined : await this.ports.verify();
		if (verification?.status === 'failed' && serviceUnavailable(result.agent.output)) { rejection.push('service-unavailable'); }
		else if (verification?.status === 'failed') { rejection.push('gates-failed:' + verification.gates.filter(gate => gate.status === 'failed').map(gate => gate.id).join(',')); }
		const metric = !rejection.length && this.ports.measure ? await this.ports.measure() : undefined;
		const accepted = !rejection.length && (outcome.kind === 'completed' || outcome.kind === 'unchanged');
		await this.record({ type: 'step-end', at: this.at(), index, status: accepted ? 'done' : outcome.kind === 'failed' ? 'failed' : 'rejected', outcome, ...(metric === undefined ? {} : { metric }), ...(rejection.length ? { rejection } : {}) });
		return { outcome, accepted, rejection };
	}

	/** Stop reasons checked between steps: the user, git, budget, plateau and oscillation. */
	private async interruption(refs: RefSnapshot): Promise<GoalReport | undefined> {
		const requested = this.ports.stopRequested();
		if (requested) { return this.end(requested === 'pause' ? 'paused' : 'cancelled', 'user'); }
		const now = await this.ports.refs();
		if (now.head !== refs.head || now.branch !== refs.branch) { return this.end('paused', 'user-git-action'); }
		if (!this.budgetLeft()) { return this.end('blocked', 'budget-exhausted'); }
		const metrics = this.state.steps.map(step => step.metric).filter((value): value is number => value !== undefined);
		if (this.state.charter.metric && plateaued([this.state.baseline ?? metrics[0] ?? 0, ...metrics])) { return this.end('blocked', 'plateau'); }
		if (oscillating(this.state.steps.map(step => step.outcome?.diff.files.map(file => file.path) ?? []))) { return this.end('blocked', 'oscillation'); }
		return undefined;
	}

	private targetMet(): boolean {
		const target = this.state.charter.done.map(item => item.check?.metric?.atLeast).find(value => value !== undefined);
		const last = this.state.steps.map(step => step.metric).filter((value): value is number => value !== undefined).at(-1);
		return target !== undefined && last !== undefined && last >= target;
	}

	async run(charter: GoalCharter, baseCommit?: string): Promise<GoalReport> {
		validateCharter(charter);
		const blockers = await this.ports.blockers();
		const baseline = this.ports.measure ? await this.ports.measure() : undefined;
		await this.record({ type: 'charter', at: this.at(), charter, ...(baseline === undefined ? {} : { baseline }), ...(baseCommit ? { baseCommit } : {}) });
		if (blockers.length) { return this.end('blocked', 'git:' + blockers.join(',')); }
		await this.record({ type: 'state', at: this.at(), status: 'running' });
		const refs = await this.ports.refs();
		const read = async (role: GoalRole, instruction: string) => {
			const result = await this.ports.runAgent({ role, provider: role === 'reviewer' ? charter.providers.fallback ?? charter.providers.preferred : charter.providers.preferred, instruction: instruction + '\n\n' + roleInstruction(role), readOnly: true });
			this.runs++;
			return result.agent.output;
		};
		// 1. Understand, with one grouped round of questions at most.
		let spec = charter.size === 'small' ? undefined : parseSpec(await read('analyst', charter.objective));
		if (spec?.questions.length) {
			const id = 'q' + (this.state.questions.length + 1);
			await this.record({ type: 'question', at: this.at(), id, text: spec.questions.join('\n') });
			await this.record({ type: 'state', at: this.at(), status: 'waiting', reason: 'questions' });
			const answers = await this.ports.ask(spec.questions);
			if (!answers) { return this.end('cancelled', 'user'); }
			await this.record({ type: 'answer', at: this.at(), id, text: answers.join('\n') });
			await this.record({ type: 'state', at: this.at(), status: 'running' });
			spec = { ...spec, assumptions: [...spec.assumptions, ...spec.questions.map((question, index) => question + ' → ' + (answers[index] ?? ''))] };
		}
		const context = [charter.objective, spec ? 'Acceptance criteria:\n' + spec.criteria.map(criterion => criterion.id + ': ' + [criterion.given, criterion.when, criterion.then].filter(Boolean).join(' / ')).join('\n') : '', spec?.assumptions.length ? 'Assumptions:\n' + spec.assumptions.join('\n') : ''].filter(Boolean).join('\n\n');
		// 2. Design: tasks with dependencies; a small request or a metric goal without a design runs as repeated batches.
		const design = charter.size === 'goal' ? parseDesign(await read('architect', context)) : undefined;
		const waves = design ? taskWaves(design.tasks)! : undefined;
		let corrections = 0;
		const runTask = async (task: DesignTask | undefined, batch: number): Promise<GoalReport | undefined> => {
			const title = task ? task.id + ': ' + task.title : charter.size === 'small' ? charter.objective.slice(0, 120) : 'Tanda ' + batch;
			const instruction = context + (task ? '\n\nYour task ' + task.id + ': ' + task.title + '\nFiles you own: ' + task.files.join(', ') : '\n\nDo the next batch of work towards the objective.');
			let result = await this.step(title, task?.tests ? 'test-engineer' : 'implementer', instruction);
			while (!result.accepted && corrections < MAX_CORRECTIONS && this.budgetLeft()) {
				if (result.outcome.kind === 'blocked' || result.rejection.includes('service-unavailable')) { return this.end('blocked', result.outcome.reason ?? 'service-unavailable'); }
				// The user's edit is never overwritten: the goal stops in conflict and both changes stay.
				if (result.rejection.some(reason => reason.startsWith('user-edit-conflict'))) { return this.end('paused', 'conflict:' + result.rejection.filter(reason => reason.startsWith('user-edit-conflict')).join(',')); }
				corrections++;
				result = await this.step('Correcci\u00f3n de ' + title, 'implementer', instruction + '\n\nThe previous attempt was rejected by the IDE for: ' + result.rejection.join('; ') + '. Fix exactly that, keeping the scope.');
			}
			if (!result.accepted) { return this.end('blocked', 'step-rejected:' + result.rejection.join(';')); }
			return this.interruption(refs);
		};
		if (waves) {
			for (const wave of waves) { for (const task of wave) { const stop = await runTask(task, 0); if (stop) { return stop; } } }
		} else {
			for (let batch = 1; ; batch++) {
				const stop = await runTask(undefined, batch);
				if (stop) { return stop; }
				if (charter.size === 'small' || !charter.metric || this.targetMet()) { break; }
			}
		}
		// 3. Independent review, preferably by the other provider; blocking findings become corrections.
		let review = parseReview(await read('reviewer', context + '\n\nReview the changes made for this goal.'));
		for (let round = 0; review && (review.findings.some(finding => finding.severity === 'blocking') || review.score < MIN_REVIEW_SCORE) && round < MAX_CORRECTIONS && this.budgetLeft(); round++) {
			const fixes = review.findings.filter(finding => finding.severity === 'blocking').map(finding => (finding.file ? finding.file + ': ' : '') + finding.text);
			const corrected = await this.step('Correcciones de la revisi\u00f3n', 'implementer', context + '\n\nFix these review findings:\n' + (fixes.join('\n') || 'Improve the quality of the new tests (meaningful assertions, negative cases, determinism).'));
			if (!corrected.accepted) { return this.end('blocked', 'review-corrections-rejected'); }
			review = parseReview(await read('reviewer', context + '\n\nReview again after the corrections.'));
		}
		// 4. Verification and Definition of Done.
		const verification = spec?.criteria.length ? parseVerification(await read('verifier', context)) : undefined;
		const gates = await this.ports.verify();
		const metrics = this.state.steps.map(step => step.metric).filter((value): value is number => value !== undefined);
		const evidence: DoneEvidence = {
			criteria: verification?.criteria ?? (spec?.criteria.length ? spec.criteria.map(criterion => ({ id: criterion.id })) : undefined),
			gates: gates.gates, blockingFindings: review ? review.findings.filter(finding => finding.severity === 'blocking').length : undefined,
			secretsInDiff: this.state.steps.some(step => step.rejection?.some(reason => reason.startsWith('secret-in-diff'))),
			...(this.state.baseline !== undefined ? { coverageBefore: this.state.baseline, coverageAfter: metrics.at(-1) ?? this.state.baseline } : {})
		};
		const dod = evaluateDefinitionOfDone(this.ports.definitionOfDone, evidence);
		const report = await this.end(dod.done && gates.status !== 'failed' ? 'completed' : 'blocked', dod.done ? undefined : 'definition-of-done');
		return { ...report, done: dod.results, spec };
	}
}

/** Charter with safe defaults for a plain instruction; the user reviews it before anything runs. */
export function defaultCharter(objective: string, provider: NativeProvider, other: NativeProvider | undefined, options: { metric?: GoalCharter['metric']; target?: number; allowProduction?: boolean; delivery?: GoalCharter['delivery'] } = {}): GoalCharter {
	return {
		objective, size: 'goal', scope: [], forbidden: ['git', 'new-dependencies', 'publish'], allowProduction: options.allowProduction ?? true,
		done: options.target !== undefined ? [{ id: 'metric', description: 'M\u00e9trica \u2265 ' + options.target, check: { metric: { atLeast: options.target } } }] : [],
		budget: { maxRuns: 12, maxMinutes: 240, maxTurnsPerRun: 50 }, assumptions: [], delivery: options.delivery ?? 'working-tree',
		providers: { preferred: provider, ...(other ? { fallback: other } : {}) }, ...(options.metric ? { metric: options.metric } : {})
	};
}
