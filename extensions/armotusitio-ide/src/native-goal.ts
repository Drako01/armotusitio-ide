/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Autonomous goal charter (block L): what the user approves once, and the validator every step must pass on its real diff. */
import type { NativeProvider } from './native-providers.ts';
import type { RunDiffSummary } from './native-run-diff.ts';

/** A verifiable acceptance criterion; `check` is how the IDE measures it (a gate id or a metric threshold). */
export interface DoneCriterion { id: string; description: string; check?: { gate?: string; metric?: { atLeast: number } } }
/** Paths the goal may change (`allow`) or must never touch (`deny`), as project-relative globs. */
export interface ScopeRule { allow?: string[]; deny?: string[] }
export interface GoalBudget { maxRuns: number; maxMinutes: number; maxTurnsPerRun: number }
export interface ProviderPolicy { preferred: NativeProvider; fallback?: NativeProvider }
/** How the IDE measures the goal's metric itself (block M): a policy-checked command and how to read its output. */
export interface GoalMetric { command: string; args: string[]; cwd: string; parse: 'go-coverage' | 'percent' }
export interface GoalCharter {
	objective: string;
	done: DoneCriterion[];
	scope: ScopeRule[];
	forbidden: string[];
	/** Production (non-test) code may change; false for goals such as "raise coverage without touching production". */
	allowProduction: boolean;
	budget: GoalBudget;
	assumptions: string[];
	delivery: 'working-tree' | 'local-branch' | 'branch-and-pr';
	providers: ProviderPolicy;
	metric?: GoalMetric;
	/** Request size chosen by the analyst (block P); the user can force another. */
	size: 'question' | 'small' | 'goal';
	/** Ephemeral environment template the orchestrator creates for this goal and destroys at the end (block W). */
	environment?: string;
}

export const DEFAULT_BUDGET: GoalBudget = { maxRuns: 12, maxMinutes: 240, maxTurnsPerRun: 50 };

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|testdata)\/|_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|Tests?\.(cs|java|kt|php)$|_spec\.rb$|\.snap$/;
/** Test code by the conventions of each supported ecosystem. */
export function isTestFile(file: string): boolean { return TEST_FILE.test(file.replace(/\\/g, '/')); }

/** Project-relative glob (`*`, `**`, `?`) as a regular expression. */
export function globPattern(glob: string): RegExp {
	const source = glob.replace(/\\/g, '/').replace(/^\.\//, '');
	let pattern = '';
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === '*' && source[index + 1] === '*') {
			index++;
			if (source[index + 1] === '/') { index++; pattern += '(?:.*/)?'; } else { pattern += '.*'; }
		} else if (char === '*') { pattern += '[^/]*'; }
		else if (char === '?') { pattern += '[^/]'; }
		else { pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
	}
	return new RegExp('^' + pattern + '$');
}
const matches = (file: string, globs: readonly string[] | undefined): boolean => !!globs?.some(glob => globPattern(glob).test(file));

/** A charter the orchestrator can run: bounded, non-empty and internally consistent. */
export function validateCharter(charter: GoalCharter): GoalCharter {
	const budget = charter.budget;
	if (!charter.objective?.trim() || charter.objective.length > 10000 || !Array.isArray(charter.done) || !Array.isArray(charter.scope) ||
		!budget || !Number.isSafeInteger(budget.maxRuns) || budget.maxRuns < 1 || budget.maxRuns > 100 ||
		!Number.isSafeInteger(budget.maxMinutes) || budget.maxMinutes < 5 || budget.maxMinutes > 24 * 60 ||
		!Number.isSafeInteger(budget.maxTurnsPerRun) || budget.maxTurnsPerRun < 10 || budget.maxTurnsPerRun > 150 ||
		!['working-tree', 'local-branch', 'branch-and-pr'].includes(charter.delivery) || !['codex', 'claude'].includes(charter.providers?.preferred) ||
		!['question', 'small', 'goal'].includes(charter.size)) {
		throw Error('HARNESS_PLAN_SCHEMA');
	}
	return charter;
}

/**
 * Check a step's real diff against the charter (EC-10): files outside the scope, denied paths and production
 * changes the charter does not allow. The plan's declared files are never trusted instead of the diff.
 */
export function validateStepDiff(charter: GoalCharter, diff: RunDiffSummary): string[] {
	const violations: string[] = [];
	const allow = charter.scope.flatMap(rule => rule.allow ?? []);
	const deny = charter.scope.flatMap(rule => rule.deny ?? []);
	for (const file of diff.files) {
		if (file.preexisting) { continue; }
		if (matches(file.path, deny)) { violations.push('denied-path:' + file.path); continue; }
		if (allow.length && !matches(file.path, allow)) { violations.push('outside-scope:' + file.path); continue; }
		if (!charter.allowProduction && !isTestFile(file.path)) { violations.push('production-change:' + file.path); }
	}
	if (diff.count > diff.files.length && (allow.length || !charter.allowProduction)) { violations.push('unlisted-changes:' + (diff.count - diff.files.length)); }
	return violations;
}

/** Whether a file may change under the charter: inside `allow` (when set), outside `deny`, test code unless production is allowed. */
export function inCharterScope(charter: GoalCharter, file: string): boolean {
	return validateStepDiff(charter, { available: true, count: 1, files: [{ path: file, change: 'modified', preexisting: false }] }).length === 0;
}

/** Remaining budget after the runs and time already spent; the orchestrator stops at zero. */
export function remainingBudget(charter: GoalCharter, runs: number, elapsedMs: number): { runs: number; minutes: number } {
	return { runs: Math.max(0, charter.budget.maxRuns - runs), minutes: Math.max(0, Math.floor(charter.budget.maxMinutes - elapsedMs / 60000)) };
}
