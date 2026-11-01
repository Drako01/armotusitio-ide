/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileGoalJournal, interruptedOnLoad } from '../src/native-goal-journal.ts';
import { checkStepIntegrity, parseUnifiedDiff } from '../src/native-goal-guards.ts';
import { classifyRetry, oscillating, parseMetric, plateaued, serviceUnavailable } from '../src/native-goal-metric.ts';
import { globPattern, isTestFile, validateStepDiff } from '../src/native-goal.ts';
import { evaluateDefinitionOfDone, proposeDefinitionOfDone } from '../src/native-dod.ts';
import { parseDesign, parseSpec, taskWaves } from '../src/native-roles.ts';
import { defaultCharter, GoalOrchestrator, type GoalPorts } from '../src/native-orchestrator.ts';
import type { AgentOutcome } from '../src/native-agent-execution.ts';

const patch = (file: string, added: string[], removed: string[] = [], created = true) =>
	'diff --git a/' + file + ' b/' + file + '\n' + (created ? 'new file mode 100644\n' : '') + '--- a/' + file + '\n+++ b/' + file + '\n' + [...removed.map(line => '-' + line), ...added.map(line => '+' + line)].join('\n');

test('adversarial agent: every metric-gaming trick in the diff is rejected with its reason', () => {
	const cases: Record<string, string> = {
		noAssertions: patch('internal/app/app_test.go', ['func TestRun(t *testing.T) {', '\tRun()', '}']),
		massSkips: patch('internal/app/app_test.go', ['func TestA(t *testing.T) { t.Skip() ; t.Error("x") }', 'func TestB(t *testing.T) { t.Skip() ; t.Error("x") }']),
		coverageExclusion: patch('src/index.ts', ['/* istanbul ignore next */']),
		coverageConfig: patch('vitest.config.ts', ['coverage: { exclude: ["src/**"] }'], [], false),
		weakened: patch('src/app.test.ts', [], ['  expect(sum(1, 2)).toBe(3);'], false),
		production: patch('internal/app/app.go', ['func X() {}']),
		secret: patch('internal/app/fixtures_test.go', ['const key = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"', 'func TestK(t *testing.T) { t.Fatal(key) }'])
	};
	const reasons = Object.fromEntries(Object.entries(cases).map(([name, diff]) => [name, checkStepIntegrity(parseUnifiedDiff(diff), { allowProduction: false }).map(reason => reason.split(':')[0])]));
	assert.deepEqual(reasons, {
		noAssertions: ['tests-without-assertions'], massSkips: ['new-skips'], coverageExclusion: ['coverage-exclusion', 'production-change'],
		coverageConfig: ['coverage-config-changed', 'production-change'], weakened: ['weakened-tests'], production: ['production-change'], secret: ['secret-in-diff']
	});
	// A real test with assertions and a documented skip passes.
	assert.deepEqual(checkStepIntegrity(parseUnifiedDiff(patch('a_test.go', ['func TestA(t *testing.T) {', '\tif got := A(); got != 1 { t.Errorf("got %d", got) }', '\tt.Skip("bug RED-12: flaky clock")', '}'])), { allowProduction: false }), []);
});

test('metric, plateau, oscillation, flaky tests and service outages are measured, not believed', () => {
	assert.deepEqual([
		parseMetric('go-coverage', 'ok x\ttotal:\t\t\t(statements)\t\t46.0%'.replace('\t', '\n')),
		parseMetric('go-coverage', 'ok a 0.1s coverage: 50.0% of statements\nok b 0.2s coverage: 61.0% of statements'),
		parseMetric('percent', 'Name  Stmts  Miss  Cover\nTOTAL  100  18  82%'),
		parseMetric('percent', 'no numbers here')
	], [46, 55.5, 82, undefined]);
	assert.deepEqual([plateaued([46, 46.2, 46.4]), plateaued([46, 50, 50.2]), oscillating([['a'], ['b'], ['a']]), oscillating([['a'], ['a'], ['a']]),
		classifyRetry('failed', 'passed'), classifyRetry('failed', 'failed'), serviceUnavailable('dial tcp 127.0.0.1:5432: connect: connection refused'), serviceUnavailable('expected 2, got 3')],
	[true, false, true, false, 'flaky', 'failed', true, false]);
});

test('the charter validator checks the real diff: scope globs, denied paths and production code', () => {
	const charter = { ...defaultCharter('cobertura', 'claude', 'codex', { allowProduction: false }), scope: [{ allow: ['apps/api/**'], deny: ['apps/api/internal/modules/catalog/catalogtest/**'] }] };
	const file = (name: string, preexisting = false) => ({ path: name, change: 'modified' as const, preexisting });
	assert.deepEqual(validateStepDiff(charter, { available: true, count: 5, files: [file('apps/api/internal/app/app_test.go'), file('apps/api/internal/app/app.go'), file('apps/web/x.test.ts'), file('apps/api/internal/modules/catalog/catalogtest/f_test.go'), file('README.md', true)] }),
		['production-change:apps/api/internal/app/app.go', 'outside-scope:apps/web/x.test.ts', 'denied-path:apps/api/internal/modules/catalog/catalogtest/f_test.go']);
	assert.deepEqual([globPattern('**/*.go').test('a/b/c.go'), globPattern('apps/*/x').test('apps/a/b/x'), isTestFile('src/__tests__/a.ts'), isTestFile('pkg/handler.go')], [true, false, true, false]);
});

test('Definition of Done shows every point with evidence or a justified not-applicable, and missing evidence is pending', () => {
	const items = proposeDefinitionOfDone({ subprojects: [{ path: '.', ecosystem: 'go' }], hasMigrations: false, hasApiContract: false, hasUi: false });
	const passing = evaluateDefinitionOfDone(items, { criteria: [{ id: 'C1', test: 'TestC1', passed: true }], gates: [{ id: 'unit', status: 'passed' }], changedCoverage: 90, coverageBefore: 46, coverageAfter: 60, blockingFindings: 0, secretsInDiff: false, newDuplicates: 0 });
	const missing = evaluateDefinitionOfDone(items, { gates: [{ id: 'unit', status: 'passed' }] });
	assert.deepEqual({ count: items.length, passing: passing.done, notApplicable: passing.results.filter(item => item.status === 'not-applicable').map(item => item.id), missing: missing.done, pending: missing.results.find(item => item.id === 'review')?.status },
		{ count: 10, passing: true, notApplicable: ['migrations', 'contracts', 'ui-e2e'], missing: false, pending: 'pending' });
});

test('role contracts: a design must be a DAG with one owner per file; parallel waves follow dependencies', () => {
	const design = (tasks: object[]) => '```harness-design\n' + JSON.stringify({ tasks, decisions: [] }) + '\n```';
	const valid = parseDesign(design([{ id: 'T1', title: 'API', files: ['a.go'], dependsOn: [] }, { id: 'T2', title: 'UI', files: ['b.ts'], dependsOn: [] }, { id: 'T3', title: 'E2E', files: ['c.ts'], dependsOn: ['T1', 'T2'] }]))!;
	assert.deepEqual({
		waves: taskWaves(valid.tasks)!.map(wave => wave.map(task => task.id)),
		sharedFile: parseDesign(design([{ id: 'T1', title: 'a', files: ['a.go'], dependsOn: [] }, { id: 'T2', title: 'b', files: ['a.go'], dependsOn: [] }])),
		cycle: parseDesign(design([{ id: 'T1', title: 'a', files: ['a'], dependsOn: ['T2'] }, { id: 'T2', title: 'b', files: ['b'], dependsOn: ['T1'] }])),
		spec: parseSpec('```harness-spec\n{"size":"small","criteria":[{"id":"C1","then":"ok"}],"assumptions":[],"risks":[],"questions":[],"impact":[]}\n```')?.size
	}, { waves: [['T1', 'T2'], ['T3']], sharedFile: undefined, cycle: undefined, spec: 'small' });
});

test('the journal is append-only, survives a torn last line and reports an unfinished goal as interrupted', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-journal-'));
	try {
		const journal = new FileGoalJournal(directory, 'g1');
		const at = new Date(0).toISOString();
		await journal.append({ type: 'charter', at, charter: defaultCharter('x', 'claude', undefined), baseline: 46 });
		await journal.append({ type: 'state', at, status: 'running' });
		await journal.append({ type: 'step-start', at, index: 1, title: 'Tanda 1' });
		await fs.appendFile(path.join(directory, 'g1.jsonl'), '{"v":1,"type":"step-en');
		const state = interruptedOnLoad(await journal.load('g1'));
		assert.deepEqual({ status: state.status, steps: state.steps.map(step => [step.title, step.status]), baseline: state.baseline, list: await FileGoalJournal.list(directory) },
			{ status: 'interrupted', steps: [['Tanda 1', 'running']], baseline: 46, list: ['g1'] });
		assert.throws(() => new FileGoalJournal(directory, '../escape'), /HARNESS_RESUME_ID_INVALID/);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

/** Simulated provider and project for the autonomous mode acceptance test (section 6). */
function simulated(script: { metrics: number[]; answers?: string[]; agent?: (role: string, call: number) => Partial<{ output: string; status: AgentOutcome['status']; stopReason: 'max-turns'; files: string[]; patch: string }> }) {
	let metric = 0, calls = 0, clock = 0;
	const asked: string[][] = [];
	const roles: string[] = [];
	const ports: GoalPorts = {
		async runAgent(request) {
			calls++; roles.push(request.role + (request.resumeSession ? ':resume' : ''));
			const custom = script.agent?.(request.role, calls) ?? {};
			const files = custom.files ?? (request.readOnly ? [] : ['apps/api/internal/x/x' + calls + '_test.go']);
			const output = custom.output ?? (request.role === 'analyst' ? '```harness-spec\n{"size":"goal","criteria":[],"assumptions":[],"risks":[],"questions":' + JSON.stringify(script.answers ? ['¿Puedo usar PostgreSQL descartable?'] : []) + ',"impact":[]}\n```'
				: request.role === 'reviewer' ? '```harness-review\n{"findings":[],"score":9}\n```' : 'listo');
			return {
				agent: { status: custom.status ?? 'passed', exitCode: 0, durationMs: 1, output, truncated: false, ...(custom.stopReason ? { stopReason: custom.stopReason, sessionId: '8b725e4b-cd27-430d-beca-a8a5e83257b3' } : {}) },
				diff: { available: true, count: files.length, files: files.map(file => ({ path: file, change: 'added' as const, preexisting: false })) },
				patch: custom.patch ?? files.map(file => patch(file, ['func TestX(t *testing.T) { if X() != 1 { t.Fatal("x") } }'])).join('\n')
			};
		},
		async verify() { return { status: 'passed', gates: [{ id: 'unit', status: 'passed' }] }; },
		async measure() { return script.metrics[Math.min(metric++, script.metrics.length - 1)]; },
		async refs() { return { head: 'h', branch: 'main', refs: 'r' }; },
		async blockers() { return []; },
		async ask(questions) { asked.push(questions); return script.answers; },
		publish() { }, now: () => (clock += 1000), stopRequested: () => undefined,
		definitionOfDone: proposeDefinitionOfDone({ subprojects: [], hasMigrations: false, hasApiContract: false, hasUi: false }).filter(item => ['suite-green', 'review'].includes(item.id))
	};
	return { ports, asked, roles };
}

test('autonomous goal: one approval, batches until the target, a cut by turns continues alone, one grouped question', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-goal-'));
	try {
		const sim = simulated({ metrics: [46, 52, 58, 63, 71], answers: ['sí'], agent: (role, call) => role === 'implementer' && call === 3 ? { stopReason: 'max-turns', status: 'failed' } : {} });
		const charter = { ...defaultCharter('Subí la cobertura de apps/api a 70% sin tocar producción', 'claude', 'codex', { allowProduction: false, target: 70, metric: { command: 'go', args: ['test'], cwd: 'apps/api', parse: 'go-coverage' } }), scope: [{ allow: ['apps/api/**'] }] };
		const report = await new GoalOrchestrator(new FileGoalJournal(directory, 'cov'), sim.ports, 'cov').run(charter);
		const state = await new FileGoalJournal(directory, 'cov').load('cov');
		assert.deepEqual({ status: report.status, baseline: report.baseline, final: report.final, questions: sim.asked.length, resumed: sim.roles.includes('implementer:resume'), steps: state.steps.map(step => step.metric) },
			{ status: 'completed', baseline: 46, final: 71, questions: 1, resumed: true, steps: [52, 58, 63, 71] });
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('autonomous goal stops on a rejected step after corrections and on a plateau, explaining why', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-goal-stop-'));
	try {
		const cheating = simulated({ metrics: [46, 90], agent: role => role === 'implementer' ? { files: ['apps/api/internal/app/app.go'], patch: patch('apps/api/internal/app/app.go', ['func X() {}']) } : {} });
		const rejected = await new GoalOrchestrator(new FileGoalJournal(directory, 'a'), cheating.ports, 'a').run(defaultCharter('cobertura', 'claude', undefined, { allowProduction: false, target: 70, metric: { command: 'go', args: [], cwd: '.', parse: 'go-coverage' } }));
		const flat = simulated({ metrics: [46, 46.1, 46.2, 46.3] });
		const plateau = await new GoalOrchestrator(new FileGoalJournal(directory, 'b'), flat.ports, 'b').run(defaultCharter('cobertura', 'claude', undefined, { allowProduction: false, target: 70, metric: { command: 'go', args: [], cwd: '.', parse: 'go-coverage' } }));
		assert.deepEqual({ rejected: [rejected.status, rejected.reason?.split(':')[0]], plateau: [plateau.status, plateau.reason] }, { rejected: ['blocked', 'step-rejected'], plateau: ['blocked', 'plateau'] });
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
