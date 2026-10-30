/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { planAgentWaves, executeAgentDAG } from '../src/native-agent-dag.ts';
import type { HandoffPlan } from '../src/native-providers.ts';

const plan: HandoffPlan = {
	schemaVersion: 1,
	handoffs: [
		{ id: 'inspect_a', role: 'planner', provider: 'codex', dependsOn: [], instruction: 'Inspect A' },
		{ id: 'inspect_b', role: 'planner', provider: 'claude', dependsOn: [], instruction: 'Inspect B' },
		{ id: 'write', role: 'implementer', provider: 'codex', dependsOn: ['inspect_a', 'inspect_b'], instruction: 'Implement' },
		{ id: 'review', role: 'reviewer', provider: 'claude', dependsOn: ['write'], instruction: 'Review' }
	]
};

test('DAG permits concurrent readers but always isolates writers', () => {
	assert.deepEqual(planAgentWaves(plan), [
		{ ids: ['inspect_a', 'inspect_b'], readOnly: true },
		{ ids: ['write'], readOnly: false },
		{ ids: ['review'], readOnly: true }
	]);
	assert.throws(() => planAgentWaves(plan, 0), /HARNESS_DAG_CONCURRENCY_INVALID/);
	assert.throws(() => planAgentWaves(plan, 100), /HARNESS_DAG_CONCURRENCY_INVALID/);
});

test('DAG does not execute dependent work when one upstream reader fails', async () => {
	const started: string[] = [];
	const result = await executeAgentDAG(plan, async handoff => {
		started.push(handoff.id);
		return handoff.id === 'inspect_b' ? 'failed' : 'passed';
	});
	assert.deepEqual(started.sort(), ['inspect_a', 'inspect_b']);
	assert.equal(result.some(item => item.id === 'write'), false);
});

test('DAG preserves write exclusivity and permits subsequent review', async () => {
	let running = 0;
	let maxRunning = 0;
	let writing = false;
	const result = await executeAgentDAG(plan, async handoff => {
		running++;
		maxRunning = Math.max(maxRunning, running);
		assert.equal(handoff.role === 'implementer' ? running === 1 : !writing, true);
		if (handoff.role === 'implementer') { writing = true; }
		await new Promise(resolve => setTimeout(resolve, 4));
		if (handoff.role === 'implementer') { writing = false; }
		running--;
		return 'passed';
	});
	assert.equal(maxRunning, 2);
	assert.deepEqual(result.map(item => item.status), ['passed', 'passed', 'passed', 'passed']);
});
