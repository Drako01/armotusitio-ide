/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireWriterLease, clearWriterLease, readWriterLease } from '../src/native-hybrid-writer.ts';
import { describeFailure } from '../src/native-chat-session.ts';
import { harnessErrorDetail } from '../src/native-chat.ts';
import { acquireSharedExecutionFence, type SharedExecutionFence } from '../src/native-shared-fence.ts';
import { referenceEngine, REFERENCE_CAPABILITIES, type EngineMode } from './native-reference-engine.mts';

async function withFence<T>(root: string, work: (fence: SharedExecutionFence) => Promise<T>): Promise<T> {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-writer-lease-state-'));
	const fence = await acquireSharedExecutionFence(root, storage, 'native-agent');
	try { return await work(fence); }
	finally { await fence.release(); await fs.rm(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
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
		} finally { await fs.rm(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
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

const format = (text: string, ...args: string[]): string => text.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)]);

test('what the engine said when it refused reaches the chat, bounded and without secrets', async () => {
	const engine = await referenceEngine({ mode: 'refuse-lease' });
	try {
		await withFence(engine.root, async fence => {
			const failure = await acquireWriterLease(engine.root, true, () => true, fence).then(() => undefined, (error: unknown) => error);
			const shown = describeFailure(format, failure);
			assert.deepEqual({ code: (failure as Error).message, detail: harnessErrorDetail(failure), mentionsCode: shown.includes('HARNESS_HYBRID_WRITER_FAILED'), mentionsEngine: shown.includes('Protocolo IDE no soportado: 3'), leaked: shown.includes('sk-secret') },
				{ code: 'HARNESS_HYBRID_WRITER_FAILED', detail: 'Protocolo IDE no soportado: 3 token=[redacted]', mentionsCode: true, mentionsEngine: true, leaked: false });
		});
	} finally { await engine.cleanup(); }
});

test('a lease the engine no longer has does not discard the run: it is reported as lost and the checks still apply', async () => {
	const engine = await referenceEngine();
	try {
		await withFence(engine.root, async fence => {
			const lease = await acquireWriterLease(engine.root, true, () => true, fence);
			// A long agent run: the lease outlives its time-to-live and the engine removes it when a command runs.
			await engine.command('expire-lease');
			const evidence = await lease.release();
			assert.deepEqual({ lost: evidence.leaseLost, before: evidence.tasksBefore, after: evidence.tasksAfter }, { lost: true, before: [], after: [] });
		});
		// Work the engine did meanwhile is still a violation, lease or not.
		const rogue = await referenceEngine({ mode: 'ignore-lease' });
		try {
			await withFence(rogue.root, async fence => {
				const lease = await acquireWriterLease(rogue.root, true, () => true, fence);
				await rogue.command('start-task');
				await rogue.command('expire-lease');
				await assert.rejects(lease.release(), /HARNESS_HYBRID_WRITER_COORDINATION_VIOLATED|HARNESS_HYBRID_WRITER_PROJECT_BUSY/);
			});
		} finally { await rogue.cleanup(); }
	} finally { await engine.cleanup(); }
});

test('the lease state comes from the engine, and clearing one left by a dead IDE needs the shared fence', async () => {
	const engine = await referenceEngine();
	try {
		await withFence(engine.root, async fence => {
			const before = (await readWriterLease(engine.root, () => true)).state;
			await acquireWriterLease(engine.root, true, () => true, fence);
			const held = await readWriterLease(engine.root, () => true);
			const previous = await clearWriterLease(engine.root, () => true, fence);
			const after = (await readWriterLease(engine.root, () => true)).state;
			assert.deepEqual({ before, held, previous, after, untrusted: await readWriterLease(engine.root, () => false).then(() => 'read', (error: Error) => error.message) },
				{ before: 'none', held: { state: 'valid', expiresAt: '2099-01-01T00:00:00' }, previous: 'valid', after: 'none', untrusted: 'HARNESS_UNTRUSTED_WORKSPACE' });
		});
	} finally { await engine.cleanup(); }
});
