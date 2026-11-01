/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Definition of Done (block Q): verifiable conditions proposed per project, evaluated point by point with evidence. */
import type { Subproject } from './native-ecosystems.ts';

export type DoneItemId = 'acceptance-tests' | 'build-lint' | 'suite-green' | 'changed-coverage' | 'review' | 'security' | 'migrations' | 'contracts' | 'no-duplication' | 'ui-e2e';
export interface DoneItem { id: DoneItemId; title: string; mandatory: boolean; applies: boolean; reason?: string }
export interface DoneEvidence {
	/** Acceptance criteria and the test that proves each one. */
	criteria?: Array<{ id: string; test?: string; passed?: boolean }>;
	gates?: Array<{ id: string; status: string }>;
	flakyTests?: string[];
	changedCoverage?: number;
	coverageBefore?: number;
	coverageAfter?: number;
	blockingFindings?: number;
	secretsInDiff?: boolean;
	migrationsForwardOnly?: boolean;
	contractsRegenerated?: boolean;
	newDuplicates?: number;
	untrackedTodos?: number;
	uiE2e?: boolean;
}
export type DoneStatus = 'passed' | 'failed' | 'not-applicable' | 'pending';
export interface DoneResult { id: DoneItemId; title: string; status: DoneStatus; evidence?: string; reason?: string; mandatory: boolean }

const COVERAGE_TOOLS: Record<Subproject['ecosystem'], string | undefined> = { go: 'go test -coverprofile', node: 'c8 / istanbul', python: 'coverage.py', dotnet: 'coverlet', java: 'jacoco', rust: 'cargo llvm-cov', php: 'phpunit --coverage', ruby: 'simplecov' };

/** The default proposal for a project; conditions that do not apply carry their reason (never dropped silently). */
export function proposeDefinitionOfDone(input: { subprojects: readonly Subproject[]; hasMigrations: boolean; hasApiContract: boolean; hasUi: boolean; minChangedCoverage?: number }): DoneItem[] {
	const tool = input.subprojects.map(project => COVERAGE_TOOLS[project.ecosystem]).find(Boolean);
	const item = (id: DoneItemId, title: string, mandatory: boolean, applies = true, reason?: string): DoneItem => ({ id, title, mandatory, applies, ...(reason ? { reason } : {}) });
	return [
		item('acceptance-tests', 'Cada criterio de aceptaci\u00f3n tiene un test que lo verifica y pasa', true),
		item('build-lint', 'Build, typecheck, lint y formato sin errores nuevos', true, input.subprojects.length > 0, input.subprojects.length ? undefined : 'No se detect\u00f3 ning\u00fan ecosistema con build'),
		item('suite-green', 'Suite completa verde y tests nuevos estables en 3 corridas', true),
		item('changed-coverage', 'Cobertura del c\u00f3digo cambiado \u2265 ' + (input.minChangedCoverage ?? 80) + '% y la global no baja', true, !!tool, tool ? undefined : 'No hay herramienta de cobertura para este ecosistema (EC-93)'),
		item('review', 'Revisi\u00f3n sin hallazgos bloqueantes abiertos', true),
		item('security', 'Sin secretos en el diff y tests de autorizaci\u00f3n con casos negativos', true),
		item('migrations', 'Migraciones s\u00f3lo hacia adelante, aplicadas y probadas', true, input.hasMigrations, input.hasMigrations ? undefined : 'El proyecto no tiene migraciones'),
		item('contracts', 'Contratos regenerados si cambi\u00f3 la API', false, input.hasApiContract, input.hasApiContract ? undefined : 'El proyecto no publica un contrato de API'),
		item('no-duplication', 'Sin c\u00f3digo duplicado nuevo ni TODO sin referencia', false),
		item('ui-e2e', 'E2E de los flujos de UI afectados con capturas', false, input.hasUi, input.hasUi ? undefined : 'El proyecto no tiene interfaz de usuario')
	];
}

/** Evaluate each condition; missing evidence is "pending", never "passed". */
export function evaluateDefinitionOfDone(items: readonly DoneItem[], evidence: DoneEvidence, minChangedCoverage = 80): { results: DoneResult[]; done: boolean } {
	const results = items.map((item): DoneResult => {
		const base = { id: item.id, title: item.title, mandatory: item.mandatory };
		if (!item.applies) { return { ...base, status: 'not-applicable', reason: item.reason }; }
		const decide = (ok: boolean | undefined, detail: string): DoneResult => ok === undefined ? { ...base, status: 'pending' } : { ...base, status: ok ? 'passed' : 'failed', evidence: detail };
		switch (item.id) {
			case 'acceptance-tests': {
				const criteria = evidence.criteria;
				return decide(criteria && criteria.length ? criteria.every(criterion => criterion.test && criterion.passed) : undefined, (criteria ?? []).map(criterion => criterion.id + ' → ' + (criterion.test ?? 'sin test') + ' ' + (criterion.passed ? '✓' : '\u2717')).join('; '));
			}
			case 'build-lint': return decide(evidence.gates?.length ? evidence.gates.every(gate => gate.status === 'passed') : undefined, (evidence.gates ?? []).map(gate => gate.id + ': ' + gate.status).join(', '));
			case 'suite-green': return decide(evidence.gates?.length ? evidence.gates.every(gate => gate.status === 'passed') && !evidence.flakyTests?.length : undefined, evidence.flakyTests?.length ? 'Inestables: ' + evidence.flakyTests.join(', ') : 'Sin tests inestables');
			case 'changed-coverage': return decide(evidence.changedCoverage === undefined ? undefined : evidence.changedCoverage >= minChangedCoverage && (evidence.coverageAfter ?? 0) >= (evidence.coverageBefore ?? 0),
				evidence.changedCoverage + '% del c\u00f3digo cambiado; global ' + (evidence.coverageBefore ?? '?') + '% → ' + (evidence.coverageAfter ?? '?') + '%');
			case 'review': return decide(evidence.blockingFindings === undefined ? undefined : evidence.blockingFindings === 0, evidence.blockingFindings + ' hallazgos bloqueantes');
			case 'security': return decide(evidence.secretsInDiff === undefined ? undefined : !evidence.secretsInDiff, evidence.secretsInDiff ? 'Hay secretos en el diff' : 'Sin secretos en el diff');
			case 'migrations': return decide(evidence.migrationsForwardOnly, 'Migraciones hacia adelante');
			case 'contracts': return decide(evidence.contractsRegenerated, 'Contratos regenerados');
			case 'no-duplication': return decide(evidence.newDuplicates === undefined ? undefined : evidence.newDuplicates === 0 && !evidence.untrackedTodos, (evidence.newDuplicates ?? 0) + ' duplicados nuevos, ' + (evidence.untrackedTodos ?? 0) + ' TODO sin referencia');
			case 'ui-e2e': return decide(evidence.uiE2e, 'E2E de UI');
		}
	});
	return { results, done: results.every(result => !result.mandatory || result.status === 'passed' || result.status === 'not-applicable') };
}
