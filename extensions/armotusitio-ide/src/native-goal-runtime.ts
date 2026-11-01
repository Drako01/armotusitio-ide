/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Real ports of the goal orchestrator (blocks L, M, O): guarded agent runs with the command tool server, the project's
 * gates and metric run through the same command policy, git state, and feed items. No `vscode` here: the integration
 * injects the guarded launcher and the user prompts.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentOutcome } from './native-agent-execution.ts';
import type { NativeProvider } from './native-providers.ts';
import type { ActivityFeed, ActivityItem } from './native-activity-feed.ts';
import { captureWorkingTree, diffWorkingTree, type RunDiffSummary } from './native-run-diff.ts';
import { createCommandPolicy, type CommandPolicyConfig } from './native-command-policy.ts';
import { runCommand } from './native-command-runner.ts';
import { parseMetric } from './native-goal-metric.ts';
import { captureRefs, editConflicts, gitBlockers } from './native-user-activity.ts';
import { gitOutput } from './native-git.ts';
import type { GoalPorts } from './native-orchestrator.ts';
import type { GoalCharter } from './native-goal.ts';
import type { GoalState } from './native-goal-journal.ts';
import type { DoneItem } from './native-dod.ts';
import type { GoalRole } from './native-roles.ts';
import { cacheKey, treeDigest, CACHE_TTL_SECONDS, type ResultCache } from './native-result-cache.ts';

export interface GoalRuntimeDeps {
	/** Project root the goal works in (the user's checkout, or the delivery worktree). */
	root: string;
	projectName: string;
	charter: GoalCharter;
	/** The guarded launcher of the integration: trust, fence, lease, quota and the `ats-runner` tool server. */
	launch(request: { provider: NativeProvider; readOnly: boolean; instruction: string; resumeSession?: string; maxTurns: number }): Promise<AgentOutcome>;
	/** Verification gates of the project as commands; empty when the project's own Harness verifies. */
	gates: Array<{ id: string; command: string; args: string[]; cwd: string }>;
	policy: CommandPolicyConfig;
	env: NodeJS.ProcessEnv;
	logDirectory: string;
	ask(questions: string[]): Promise<string[] | undefined>;
	feed?: ActivityFeed;
	goalId: string;
	definitionOfDone: DoneItem[];
	stopRequested(): 'pause' | 'stop' | undefined;
	/** Reuses gate results whose exact inputs repeat (block I). */
	cache?: ResultCache;
	/** Project-relative files the user saved in the editor; cleared when a step starts (block O). */
	userSaved?: Set<string>;
	/** After each accepted step of a branch delivery, the orchestrator commits it. */
	afterStep?(state: GoalState): Promise<void>;
}

/** Unified diff of a step: `git diff` for tracked files and the content of new files, for the integrity guards. */
async function stepPatch(root: string, diff: RunDiffSummary): Promise<string> {
	const parts: string[] = [];
	for (const file of diff.files) {
		if (file.change === 'added') {
			const content = await fs.readFile(path.join(root, file.path), 'utf8').catch(() => '');
			parts.push('diff --git a/' + file.path + ' b/' + file.path + '\nnew file mode 100644\n--- /dev/null\n+++ b/' + file.path + '\n' + content.split('\n').slice(0, 5000).map(line => '+' + line).join('\n'));
		} else {
			parts.push((await gitOutput(root, ['diff', '--no-ext-diff', 'HEAD', '--', file.path]).catch(() => Buffer.alloc(0))).toString('utf8'));
		}
	}
	return parts.join('\n');
}

const STATE_LABEL: Record<GoalState['status'], ActivityItem['state']> = { queued: 'queued', running: 'running', paused: 'paused', waiting: 'paused', blocked: 'blocked', completed: 'completed', failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted' };

/** Feed items for a goal and its steps (block AC): one line each, actions on the goal. */
export function goalActivityItems(state: GoalState, projectName: string): ActivityItem[] {
	const id = 'goal:' + state.goalId;
	const at = Date.parse(state.updatedAt);
	const waiting = state.status === 'waiting';
	const current = state.steps.at(-1);
	const metrics = state.steps.map(step => step.metric).filter((value): value is number => value !== undefined);
	const active = ['running', 'waiting', 'queued'].includes(state.status);
	return [
		{
			id, kind: 'goal', project: projectName, title: state.charter.objective.split('\n')[0].slice(0, 120), state: STATE_LABEL[state.status], startedAt: Date.parse(state.steps[0]?.startedAt ?? state.updatedAt), updatedAt: at, origin: 'this-window',
			...(waiting ? { needs: 'answer' as const } : state.status === 'blocked' ? { needs: 'decision' as const } : {}),
			...(current ? { step: { index: state.steps.length, total: Math.max(state.steps.length, state.charter.budget.maxRuns), label: current.title, ...(current.role ? { agent: current.role } : {}) } } : {}),
			detail: [state.baseline !== undefined ? 'm\u00e9trica ' + state.baseline + ' → ' + (metrics.at(-1) ?? state.baseline) : '', state.reason ?? ''].filter(Boolean).join(' · '),
			actions: waiting ? ['answer', 'stop'] : active ? ['open', 'stop'] : state.status === 'paused' || state.status === 'interrupted' || state.status === 'blocked' ? ['continue', 'open'] : ['open']
		},
		...state.steps.slice(-5).map((step): ActivityItem => ({
			id: id + ':' + step.index, parentId: id, kind: 'step', project: projectName, title: step.title, startedAt: Date.parse(step.startedAt), updatedAt: Date.parse(step.endedAt ?? step.startedAt), origin: 'this-window',
			state: step.status === 'running' ? 'running' : step.status === 'done' ? 'completed' : step.status === 'rejected' ? 'blocked' : 'failed',
			...(step.rejection ? { detail: step.rejection.join(', ').slice(0, 200) } : step.metric !== undefined ? { detail: 'm\u00e9trica ' + step.metric } : {}), actions: []
		}))
	];
}

export function createGoalPorts(deps: GoalRuntimeDeps): GoalPorts {
	const policy = createCommandPolicy(deps.policy);
	let handedOver = 0;
	const runPolicy = async (command: string, args: string[], cwd: string) => {
		const decision = policy.decide(command, args, cwd);
		// A gate or metric command still goes through the floor: configuration never bypasses it.
		if (decision.allowed === false) { return { exitCode: 1, output: 'POLICY_DENIED: ' + decision.reason, timedOut: false }; }
		return runCommand({ root: deps.root, cwd: decision.cwd, command, args, env: deps.env, logDirectory: deps.logDirectory, timeoutSec: 1800 });
	};
	return {
		async runAgent(request: { role: GoalRole; provider: NativeProvider; instruction: string; readOnly: boolean; resumeSession?: string }) {
			const before = request.readOnly ? undefined : await captureWorkingTree(deps.root);
			if (!request.readOnly) { deps.userSaved?.clear(); }
			const agent = await deps.launch({ provider: request.provider, readOnly: request.readOnly, instruction: request.instruction, maxTurns: deps.charter.budget.maxTurnsPerRun, ...(request.resumeSession ? { resumeSession: request.resumeSession } : {}) });
			const diff = before ? diffWorkingTree(before, await captureWorkingTree(deps.root)) : { available: true, files: [], count: 0 };
			return { agent, diff, patch: before ? await stepPatch(deps.root, diff) : '' };
		},
		async verify() {
			if (!deps.gates.length) { return { status: 'skipped' as const, gates: [] }; }
			const gates = [];
			const tree = deps.cache ? await treeDigest(deps.root) : undefined;
			for (const gate of deps.gates) {
				const key = tree && cacheKey({ command: gate.command, args: gate.args, cwd: gate.cwd, tree });
				const cached = key ? await deps.cache!.get(key) : undefined;
				if (cached) { gates.push({ id: gate.id, status: cached.status }); continue; }
				const started = Date.now();
				const result = await runPolicy(gate.command, gate.args, gate.cwd);
				const status = result.exitCode === 0 ? 'passed' as const : 'failed' as const;
				if (key && !result.timedOut) { await deps.cache!.set(key, { status, durationMs: Date.now() - started, at: new Date().toISOString() }, CACHE_TTL_SECONDS); }
				gates.push({ id: gate.id, status });
			}
			return { status: gates.every(gate => gate.status === 'passed') ? 'passed' as const : 'failed' as const, gates };
		},
		...(deps.charter.metric ? {
			async measure() {
				const metric = deps.charter.metric!;
				const result = await runPolicy(metric.command, metric.args, metric.cwd);
				return parseMetric(metric.parse, result.output);
			}
		} : {}),
		refs: () => captureRefs(deps.root),
		blockers: () => gitBlockers(deps.root),
		ask: questions => deps.ask(questions),
		publish(state) {
			if (deps.feed) {
				const items = goalActivityItems(state, deps.projectName);
				const ids = new Set(items.map(item => item.id));
				deps.feed.retain(item => !item.id.startsWith('goal:' + state.goalId) || ids.has(item.id));
				items.forEach(item => deps.feed!.publish(item));
			}
			// Publish runs after every journal entry; each accepted step is handed over exactly once.
			const last = state.steps.at(-1);
			if (deps.afterStep && last?.status === 'done' && last.index !== handedOver) { handedOver = last.index; void deps.afterStep(state); }
		},
		now: () => Date.now(),
		stopRequested: () => deps.stopRequested(),
		userConflicts: files => deps.userSaved ? editConflicts(files, deps.userSaved) : [],
		definitionOfDone: deps.definitionOfDone
	};
}

/** Charter options inferred from a plain instruction: a coverage target, "without touching production", the metric command. */
export function inferGoalOptions(objective: string, ecosystems: ReadonlyArray<{ path: string; ecosystem: string }>): { target?: number; allowProduction: boolean; metric?: GoalCharter['metric'] } {
	const text = objective.toLowerCase();
	const coverage = /cobertura|coverage/.test(text);
	const target = coverage ? Number(/(\d{1,3}(?:[.,]\d+)?)\s*%/.exec(text)?.[1].replace(',', '.')) : NaN;
	const allowProduction = !/sin tocar (el )?(c\u00f3digo de )?producci\u00f3n|without touching production|no production/.test(text);
	const go = ecosystems.find(project => project.ecosystem === 'go' && (text.includes(project.path) || ecosystems.length === 1)) ?? ecosystems.find(project => project.ecosystem === 'go');
	const metric: GoalCharter['metric'] | undefined = coverage && go ? { command: 'go', args: ['test', './...', '-count=1', '-cover'], cwd: go.path, parse: 'go-coverage' } : undefined;
	return { ...(Number.isFinite(target) ? { target } : {}), allowProduction, ...(metric ? { metric } : {}) };
}
