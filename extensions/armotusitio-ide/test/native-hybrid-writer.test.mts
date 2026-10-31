/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireWriterLease } from '../src/native-hybrid-writer.ts';
import { acquireSharedExecutionFence, type SharedExecutionFence } from '../src/native-shared-fence.ts';
import { referenceEngine, REFERENCE_CAPABILITIES, type EngineMode } from './native-reference-engine.mts';

async function withFence<T>(root: string, work: (fence: SharedExecutionFence) => Promise<T>): Promise<T> {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-writer-lease-state-'));
	const fence = await acquireSharedExecutionFence(root, storage, 'native-agent');
	try { return await work(fence); }
	finally { await fence.release(); await fs.rm(storage, { recursive: true, force: true }); }
}

test('an honest engine grants an exclusive lease, refuses its own work during it and resumes afterwards', async () => {
	const engine = await referenceEngine();
	try {
		await withFence(engine.root, async fence => {
			const lease = await acquireWriterLease(engine.root, true, () => true, fence);
			await lease.verify();
			// While the IDE agent writes, the engine's own scheduler cannot start a task.
			await assert.rejects(engine.command('start-task'));
			const evidence = await lease.release();
			assert.deepEqual({ epoch: evidence.fenceEpoch === fence.epoch, before: evidence.tasksBefore, after: evidence.tasksAfter, id: /^[a-f0-9]{32}$/.test(evidence.leaseId) }, { epoch: true, before: [], after: [], id: true });
			// The release is idempotent and the engine works again once the lease ended.
			assert.equal((await lease.release()).leaseId, evidence.leaseId);
			assert.match(await engine.command('start-task'), /started/);
		});
	} finally { await engine.cleanup(); }
});

test('a lease is refused without consent, trust, a declared capability or an idle engine', async () => {
	const missing = await referenceEngine({ capabilities: ['durable-tasks'] });
	const busy = await referenceEngine({ tasks: [{ id: 'task_1', status: 'running' }] });
	const ok = await referenceEngine();
	try {
		await withFence(ok.root, async fence => {
			await assert.rejects(acquireWriterLease(ok.root, false, () => true, fence), /HARNESS_HYBRID_WRITER_CONSENT_REQUIRED/);
			await assert.rejects(acquireWriterLease(ok.root, true, () => false, fence), /HARNESS_UNTRUSTED_WORKSPACE/);
		});
		await withFence(missing.root, fence => assert.rejects(acquireWriterLease(missing.root, true, () => true, fence), /HARNESS_HYBRID_WRITER_UNSUPPORTED/));
		await withFence(busy.root, fence => assert.rejects(acquireWriterLease(busy.root, true, () => true, fence), /HARNESS_HYBRID_WRITER_PROJECT_BUSY/));
		// A project with only a `.codex` or `.claude` folder is not an external engine at all.
		const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-writer-lease-bare-'));
		try {
			await fs.mkdir(path.join(bare, '.claude'));
			await withFence(await fs.realpath(bare), async fence => assert.rejects(acquireWriterLease(await fs.realpath(bare), true, () => true, fence), /HARNESS_HYBRID_WRITER_ENTRY_UNAVAILABLE/));
		} finally { await fs.rm(bare, { recursive: true, force: true }); }
	} finally { await Promise.all([missing.cleanup(), busy.cleanup(), ok.cleanup()]); }
});

test('hostile engines are rejected: ignored fence, false quiescence and a forged release', async () => {
	const outcomes: Record<string, string> = {};
	for (const [mode, expected] of [['ignore-fence', /HARNESS_HYBRID_WRITER_FENCE_IGNORED/], ['busy-ack', /HARNESS_HYBRID_WRITER_PROJECT_BUSY/]] as Array<[EngineMode, RegExp]>) {
		const engine = await referenceEngine({ mode });
		try { await withFence(engine.root, fence => assert.rejects(acquireWriterLease(engine.root, true, () => true, fence), expected)); outcomes[mode] = 'rejected'; }
		finally { await engine.cleanup(); }
	}
	const forged = await referenceEngine({ mode: 'wrong-lease-id' });
	try {
		await withFence(forged.root, async fence => {
			const lease = await acquireWriterLease(forged.root, true, () => true, fence);
			await assert.rejects(lease.release(), /HARNESS_HYBRID_WRITER_RESPONSE_INVALID/);
		});
		outcomes['wrong-lease-id'] = 'rejected';
	} finally { await forged.cleanup(); }
	assert.deepEqual(outcomes, { 'ignore-fence': 'rejected', 'busy-ack': 'rejected', 'wrong-lease-id': 'rejected' });
});

test('work the engine does during the lease is detected as a coordination violation', async () => {
	const rogue = await referenceEngine({ mode: 'ignore-lease' });
	const mutating = await referenceEngine({ mode: 'mutate-on-lease' });
	try {
		await withFence(rogue.root, async fence => {
			const lease = await acquireWriterLease(rogue.root, true, () => true, fence);
			// An engine that ignores the lease starts a task while the agent is writing.
			await rogue.command('start-task');
			await assert.rejects(lease.verify(), /HARNESS_HYBRID_WRITER_COORDINATION_VIOLATED/);
			await assert.rejects(lease.release(), /HARNESS_HYBRID_WRITER_COORDINATION_VIOLATED/);
		});
		await withFence(mutating.root, async fence => {
			const lease = await acquireWriterLease(mutating.root, true, () => true, fence);
			await assert.rejects(lease.release(), /HARNESS_HYBRID_WRITER_COORDINATION_VIOLATED/);
		});
		assert.deepEqual(REFERENCE_CAPABILITIES.includes('writer-lease'), true);
	} finally { await Promise.all([rogue.cleanup(), mutating.cleanup()]); }
});
