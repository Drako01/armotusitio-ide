/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHybridGateReadiness } from '../src/native-hybrid-readiness.ts';

const catalog = {
	schemaVersion: 1 as const,
	gates: [{ id: 'lint', dependsOn: [], resources: ['cpu'] }],
	digest: 'a'.repeat(64),
	executionEnabled: false as const
};

test('external gate readiness never promotes discovered metadata to execution authority', () => {
	const assessment = assessHybridGateReadiness(['verification-gates', 'parallel-gates'], catalog);
	assert.equal(assessment.declarativeReady, true);
	assert.equal(assessment.executionEnabled, false);
	assert.equal(assessment.gateCount, 1);
	assert.deepEqual(assessment.blockers, [
		'shared-writer-fencing-unverified',
		'external-execution-protocol-unverified',
		'os-sandbox-unverified'
	]);
});

test('missing catalog or unreported gate capability produces actionable blockers', () => {
	const empty = assessHybridGateReadiness([], undefined);
	assert.equal(empty.declarativeReady, false);
	assert.ok(empty.blockers.includes('project-verification-unreported'));
	assert.ok(empty.blockers.includes('gate-catalog-unavailable'));
	assert.equal(empty.executionEnabled, false);
});
