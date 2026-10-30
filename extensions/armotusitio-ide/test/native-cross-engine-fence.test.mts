/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeHarness } from '../src/native-harness.ts';
import { NativeAgentWorkflow, proposedWorkflow, workflowDigest } from '../src/native-agent-workflow.ts';
import { acquireSharedExecutionFence, inspectSharedExecutionFence } from '../src/native-shared-fence.ts';

test('native gate and workflow refuse a competing per-project process fence', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-cross-fence-'));
	const state = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-cross-fence-state-'));
	try {
		const canonical = await fs.realpath(root);
		const native = new NativeHarness(canonical, state);
		const gate = await native.create('Check', {
			schemaVersion: 1, gates: [{ id: 'ok', executable: 'node', args: ['--version'] }]
		});
		const approval = await native.reviewDigest(gate.plan);
		const workflow = new NativeAgentWorkflow(canonical, path.join(state, 'workflows'));
		const plan = proposedWorkflow('codex', 'Check test fixture');
		const workflowApproval = workflowDigest(canonical, plan);
		const writer = await acquireSharedExecutionFence(canonical, state, 'native-workflow');
		try {
			await assert.rejects(native.execute(gate.id, approval, () => true),
				/HARNESS_FENCE_HELD_RECONCILIATION_REQUIRED/);
		} finally { await writer.release(); }
		const task = await native.execute(gate.id, approval, () => true);
		assert.equal(task.attempts.at(-1)?.status, 'passed');
		const nativeLease = await acquireSharedExecutionFence(canonical, state, 'native-task');
		try {
			await assert.rejects(workflow.start(plan, workflowApproval, () => true),
				/HARNESS_FENCE_HELD_RECONCILIATION_REQUIRED/);
			assert.equal((await inspectSharedExecutionFence(canonical, state)).owner, 'native-task');
		} finally { await nativeLease.release(); }
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(state, { recursive: true, force: true });
	}
});
