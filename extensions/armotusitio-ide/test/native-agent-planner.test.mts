/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdaptiveWorkflow, chooseProvider, type ProviderAvailability } from '../src/native-agent-planner.ts';

const both = (overrides: Partial<Record<'codex' | 'claude', Partial<ProviderAvailability>>> = {}): ProviderAvailability[] => [
	{ provider: 'codex', usable: true, writerAllowed: true, ...overrides.codex },
	{ provider: 'claude', usable: true, writerAllowed: true, ...overrides.claude }
];

test('provider choice follows availability, capacity, writer isolation and review independence, with a reason', () => {
	assert.deepEqual({
		bothFree: chooseProvider('planner', both(), { preferred: 'claude' }),
		unusableCodex: chooseProvider('planner', both({ codex: { usable: false } })),
		cooling: chooseProvider('planner', both({ claude: { coolingDown: true } })),
		quota: chooseProvider('planner', both({ codex: { remainingCalls: 1 }, claude: { remainingCalls: 4 } })),
		equalCapacity: chooseProvider('planner', both({ codex: { remainingCalls: 5 }, claude: { remainingCalls: 5 } }), { preferred: 'claude' }),
		writerNeedsIsolation: chooseProvider('implementer', both({ claude: { writerAllowed: false } })),
		independentReviewer: chooseProvider('reviewer', both(), { avoid: 'codex' })
	}, {
		bothFree: { provider: 'claude', reason: 'preferred' },
		unusableCodex: { provider: 'claude', reason: 'only-option' },
		cooling: { provider: 'codex', reason: 'only-option' },
		quota: { provider: 'claude', reason: 'most-capacity' },
		equalCapacity: { provider: 'claude', reason: 'preferred' },
		writerNeedsIsolation: { provider: 'codex', reason: 'only-option' },
		independentReviewer: { provider: 'claude', reason: 'independent-review' }
	});
	// Nothing can take the work: fail closed rather than pick a provider that cannot run.
	assert.throws(() => chooseProvider('planner', both({ codex: { usable: false }, claude: { remainingCalls: 0 } })), /HARNESS_NO_PROVIDER_AVAILABLE/);
	assert.throws(() => chooseProvider('implementer', both({ codex: { writerAllowed: false }, claude: { writerAllowed: false } })), /HARNESS_NO_PROVIDER_AVAILABLE/);
});

test('the adaptive workflow reviews independently when it can, says so when it cannot, and adds only catalogued readers', () => {
	const task = 'Agregar paginaci\u00f3n al listado de clientes';
	const two = buildAdaptiveWorkflow(task, both(), { preferred: 'codex', readers: ['architecture', 'security'] });
	const solo = buildAdaptiveWorkflow(task, both({ claude: { usable: false } }));
	const providers = (workflow: typeof two) => Object.fromEntries(workflow.plan.handoffs.map(handoff => [handoff.id, handoff.provider]));
	assert.deepEqual({
		ids: two.plan.handoffs.map(handoff => handoff.id), planDepends: two.plan.handoffs.find(handoff => handoff.id === 'plan')!.dependsOn,
		providers: providers(two), reviewer: two.assignments.find(item => item.id === 'review'),
		soloProviders: providers(solo), soloReviewer: solo.assignments.find(item => item.id === 'review')?.reason,
		readerReadOnly: two.plan.handoffs.filter(handoff => handoff.id.startsWith('read-')).every(handoff => handoff.role === 'planner' && /do not modify files/.test(handoff.instruction)),
		fitsApproval: two.plan.handoffs.length <= 5
	}, {
		ids: ['read-architecture', 'read-security', 'plan', 'implement', 'review'], planDepends: ['read-architecture', 'read-security'],
		providers: { 'read-architecture': 'codex', 'read-security': 'claude', plan: 'codex', implement: 'codex', review: 'claude' },
		reviewer: { id: 'review', role: 'reviewer', provider: 'claude', reason: 'independent-review' },
		soloProviders: { plan: 'codex', implement: 'codex', review: 'codex' }, soloReviewer: 'no-independent-provider',
		readerReadOnly: true, fitsApproval: true
	});
	// Free text can never create an agent: only catalogued ids, at most two, no duplicates.
	for (const readers of [['deploy'], ['architecture', 'tests', 'security'], ['tests', 'tests'], ['__proto__']]) {
		assert.throws(() => buildAdaptiveWorkflow(task, both(), { readers }), /HARNESS_ADAPTIVE_READER_INVALID/);
	}
});
