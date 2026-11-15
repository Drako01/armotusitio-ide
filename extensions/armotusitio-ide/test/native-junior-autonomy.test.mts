/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Pure contracts of the one-prompt flow: intent routing, failure classification, evidence and honest delivery states. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../src/native-task-router.ts';
import { classifyGateFailure, failureSignature, gateKind, outputTail, REPAIRABLE, validEvidence, type EvidenceEntry } from '../src/native-task-evidence.ts';
import { classifyRun, validRunOutcome } from '../src/native-run-outcome.ts';
import { evaluateDefinitionOfDone, proposeDefinitionOfDone } from '../src/native-dod.ts';
import type { AgentOutcome } from '../src/native-agent-execution.ts';

const agent = (status: AgentOutcome['status']): AgentOutcome => ({ status, exitCode: status === 'passed' ? 0 : 1, durationMs: 1, output: 'Informe', truncated: false });
const diff = (count: number) => ({ available: true, files: Array.from({ length: count }, (_, index) => ({ path: 'f' + index, change: 'modified' as const, preexisting: false })), count });

test('J-20/J-04/J-01: the router keeps trivial edits direct and sends compound goals to the goal engine', () => {
	const route = (text: string, mode: 'ask' | 'act' = 'act') => routeTask(text, mode).route;
	assert.deepEqual({
		trivial: route('Renombr\u00e1 la variable total a subtotal en src/cart.ts'),
		fix: route('Correg\u00ed el foco del modal'),
		singleSignal: route('Agreg\u00e1 un bot\u00f3n de login al header'),
		crud: route('Creame una aplicaci\u00f3n para gestionar clientes, con login, roles, base de datos, dashboard moderno y pruebas. Instal\u00e1 lo necesario y dej\u00e1 todo funcionando.'),
		fullStack: route('Hac\u00e9 una API en Go con su frontend en Next.js para reservas'),
		list: route('Implement\u00e1:\n1. modelo de usuarios\n2. endpoint de alta\n3. pantalla de alta')
	}, { trivial: 'simple-edit', fix: 'simple-edit', singleSignal: 'simple-edit', crud: 'compound-goal', fullStack: 'compound-goal', list: 'compound-goal' });
});

test('the router never sends Ask to a writer, keeps questions read-only and gives risky work a reviewed plan', () => {
	const route = (text: string, mode: 'ask' | 'act' = 'act') => routeTask(text, mode);
	assert.equal(route('Creame una app con login y base de datos', 'ask').route, 'question');
	assert.equal(route('\u00bfQu\u00e9 hace la funci\u00f3n total?').route, 'question');
	assert.equal(route('Why does the build fail?').route, 'question');
	assert.equal(route('\u00bfPod\u00e9s agregar validaci\u00f3n al formulario?').route, 'simple-edit');
	assert.equal(route('Agreg\u00e1 validaci\u00f3n al formulario?').route, 'simple-edit');
	assert.deepEqual(route('Deploy\u00e1 la app a producci\u00f3n').reasons.sort(), ['deploy', 'production']);
	assert.equal(route('Borr\u00e1 los registros viejos de la base de datos').route, 'ambiguous-or-risky');
	assert.equal(route('hac\u00e9 un force-push de la rama').route, 'ambiguous-or-risky');
	// A Git push is not risky by itself: the permission broker already asks for it with its own card.
	assert.equal(route('sub\u00ed los cambios').route, 'simple-edit');
});

test('J-05/J-14/J-16: failures are classified from observed output; environment causes are never "repaired" as code', () => {
	const failure = (id: string, output: string, exitCode: number | null = 1) => classifyGateFailure({ id, exitCode, output }).failure;
	assert.deepEqual({
		ts: failure('typecheck', 'src/a.ts(3,1): error TS2322: Type string is not assignable to number'),
		test: failure('test', 'not ok 1 - suma\n# fail 1'),
		lintByKind: failure('lint', 'something odd'),
		service: failure('test', 'Error: connect ECONNREFUSED 127.0.0.1:5432'),
		dependency: failure('test', `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from src/a.ts`),
		relativeImport: failure('typecheck', `error TS2307: Cannot find module './missing' or its corresponding type declarations.`),
		toolchain: failure('test', `'pnpm' is not recognized as an internal or external command`),
		permission: failure('test', 'EACCES: permission denied, open /etc/x'),
		killed: failure('test', 'partial output', null),
		other: failure('custom', 'exit 2')
	}, { ts: 'syntax-typecheck', test: 'test-failure', lintByKind: 'syntax-typecheck', service: 'service-down', dependency: 'dependency-missing', relativeImport: 'syntax-typecheck', toolchain: 'toolchain', permission: 'permission-denied', killed: 'environment', other: 'unknown' });
	assert.equal(classifyGateFailure({ id: 'test', exitCode: 1, output: 'FAIL src/a.test.ts' }, true).failure, 'regression');
	assert.deepEqual([...REPAIRABLE].sort(), ['regression', 'syntax-typecheck', 'test-failure']);
	assert.deepEqual(['test-api', 'typecheck', 'lint-web-2', 'e2e', 'unit'].map(gateKind), ['test', 'typecheck', 'lint', 'e2e', 'other']);
});

test('J-14: the stall signature ignores durations and counts but changes with the failing assertion', () => {
	const one = classifyGateFailure({ id: 'test', exitCode: 1, output: 'FAIL suma expected 3 received 4 (12 ms)' });
	const sameButSlower = classifyGateFailure({ id: 'test', exitCode: 1, output: 'FAIL suma expected 3 received 4 (97 ms)' });
	const different = classifyGateFailure({ id: 'test', exitCode: 1, output: 'FAIL resta expected 1 received 2' });
	assert.equal(failureSignature([one]), failureSignature([sameButSlower]));
	assert.notEqual(failureSignature([one]), failureSignature([different]));
	assert.ok(outputTail('x'.repeat(5000)).length <= 3001);
	assert.ok(!outputTail('token=ghp_' + 'a'.repeat(36)).includes('a'.repeat(36)));
});

test('J-16/JUN-003: a completed run is "verified" only when gates ran and passed; skipped never becomes passed', () => {
	assert.deepEqual([
		classifyRun({ agent: agent('passed'), verification: 'passed', diff: diff(1) }).assurance,
		classifyRun({ agent: agent('passed'), verification: 'skipped', diff: diff(1) }).assurance,
		classifyRun({ agent: agent('passed'), verification: 'skipped', diff: diff(0) }).assurance,
		classifyRun({ agent: agent('passed'), verification: 'failed', diff: diff(1) }).kind
	], ['verified', 'unverified', undefined, 'failed']);
	// Stored histories: an older outcome without assurance stays valid; an assurance on a non-completed kind is rejected.
	assert.ok(validRunOutcome({ kind: 'completed', diff: diff(1) }));
	assert.ok(!validRunOutcome({ kind: 'failed', diff: diff(1), assurance: 'verified' }));
	const evidence: EvidenceEntry[] = [{ gate: 'test', kind: 'test', status: 'passed', source: 'ide-gate', exitCode: 0 }];
	assert.ok(validEvidence(evidence));
	assert.ok(!validEvidence([{ gate: 'x', kind: 'test', status: 'green', source: 'ide-gate' }]));
	assert.ok(!validEvidence([{ gate: 'x', kind: 'test', status: 'passed', source: 'model' }]));
});

test('JUN-009: build-lint needs a static gate, and stability needs three independent runs instead of one PASS', () => {
	const items = proposeDefinitionOfDone({ subprojects: [{ path: '.', ecosystem: 'node' }], hasMigrations: false, hasApiContract: false, hasUi: false });
	const status = (evidence: Parameters<typeof evaluateDefinitionOfDone>[1], id: string) => evaluateDefinitionOfDone(items, evidence).results.find(item => item.id === id)?.status;
	assert.equal(status({ gates: [{ id: 'test', status: 'passed' }] }, 'build-lint'), 'pending');
	assert.equal(status({ gates: [{ id: 'test', status: 'passed' }, { id: 'typecheck', status: 'passed' }] }, 'build-lint'), 'passed');
	assert.equal(status({ gates: [{ id: 'lint', status: 'cancelled' }] }, 'build-lint'), 'failed');
	assert.equal(status({ gates: [{ id: 'test', status: 'passed' }] }, 'stability'), 'pending');
	assert.equal(status({ gates: [{ id: 'test', status: 'passed' }], stableRuns: 1 }, 'stability'), 'pending');
	assert.equal(status({ gates: [{ id: 'test', status: 'passed' }], stableRuns: 3 }, 'stability'), 'passed');
	assert.equal(status({ gates: [{ id: 'test', status: 'passed' }], stableRuns: 3, flakyTests: ['suma'] }, 'stability'), 'failed');
	assert.equal(items.find(item => item.id === 'stability')?.mandatory, false);
});

test('the gate classifier reuses the shared tool classifier only where it is unambiguous', () => {
	const failure = (output: string) => classifyGateFailure({ id: 'test', exitCode: 1, output }).failure;
	assert.deepEqual({
		lockfile: failure('ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile'),
		disk: failure('ENOSPC: no space left on device'),
		policy: failure('POLICY_DENIED: npm install left'),
		// An HTTP assertion is a code defect, not a network outage, and a missing fixture is not a missing tool.
		statusAssertion: failure('not ok 3 - expected 200, received 503'),
		fixture: failure(`FAIL: ENOENT: no such file or directory, open 'fixture.json'`)
	}, { lockfile: 'dependency-missing', disk: 'environment', policy: 'permission-denied', statusAssertion: 'test-failure', fixture: 'test-failure' });
});
