/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { acquireSharedExecutionFence, inspectSharedExecutionFence, reconcileSharedExecutionFence } from '../src/native-shared-fence.ts';

test('shared fence grants one owner, is monotonic and fails closed on contention', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-data-'));
	try {
		const canonical = await fs.realpath(root);
		const first = await acquireSharedExecutionFence(canonical, storage, 'native-agent');
		assert.equal(first.epoch, 1);
		assert.deepEqual(await inspectSharedExecutionFence(canonical, storage),
			{ held: true, epoch: 1, owner: 'native-agent' });
		await assert.rejects(acquireSharedExecutionFence(canonical, storage, 'native-task'),
			/HARNESS_FENCE_HELD_RECONCILIATION_REQUIRED/);
		await first.assertCurrent();
		await first.release();
		await assert.rejects(first.assertCurrent(), /HARNESS_FENCE_ALREADY_RELEASED/);
		const second = await acquireSharedExecutionFence(canonical, storage, 'native-workflow');
		assert.equal(second.epoch, 2);
		assert.notEqual(first.token, second.token);
		await second.release();
		assert.deepEqual(await inspectSharedExecutionFence(canonical, storage), { held: false, epoch: null });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});

test('shared fence does not erase a replaced or tampered lock', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-tamper-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-tamper-data-'));
	try {
		const fence = await acquireSharedExecutionFence(await fs.realpath(root), storage, 'native-agent');
		const lock = path.join(storage, 'shared-execution.lock');
		await fs.writeFile(lock, JSON.stringify({ owner: 'forged' }));
		await assert.rejects(fence.assertCurrent(), /HARNESS_FENCE_LOST/);
		await assert.rejects(fence.release(), /HARNESS_FENCE_LOST/);
		assert.equal((await fs.readFile(lock, 'utf8')).includes('forged'), true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});

test('corrupt epoch blocks new ownership instead of resetting the counter', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-corrupt-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-corrupt-data-'));
	try {
		await fs.writeFile(path.join(storage, 'shared-execution.epoch'), '{}');
		await assert.rejects(acquireSharedExecutionFence(await fs.realpath(root), storage, 'native-task'),
			/HARNESS_FENCE_EPOCH_INVALID/);
		assert.equal((await fs.lstat(path.join(storage, 'shared-execution.lock'))).isFile(), true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});

test('crashed local fence can be released only after explicit approval and safe-state inspection', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-recovery-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-recovery-data-'));
	try {
		const canonical = await fs.realpath(root);
		const fence = await acquireSharedExecutionFence(canonical, storage, 'native-workflow');
		await assert.rejects(reconcileSharedExecutionFence(canonical, storage, false),
			/HARNESS_FENCE_RECOVERY_CONSENT_REQUIRED/);
		await assert.rejects(reconcileSharedExecutionFence(canonical, storage, true),
			/HARNESS_FENCE_OWNER_ACTIVE/);
		// Model a prior process having exited: preserve the exact nonce and epoch,
		// but replace its PID with one which cannot be alive on the test host.
		const lock = path.join(storage, 'shared-execution.lock');
		const record = JSON.parse(await fs.readFile(lock, 'utf8'));
		record.pid = 2147483647;
		await fs.writeFile(lock, JSON.stringify(record));
		await fs.mkdir(path.join(storage, 'workflows'));
		await fs.writeFile(path.join(storage, 'workflows', 'execution.lock'), '{}');
		await assert.rejects(reconcileSharedExecutionFence(canonical, storage, true),
			/HARNESS_FENCE_RECOVERY_PENDING_WORKFLOW/);
		await fs.rm(path.join(storage, 'workflows', 'execution.lock'));
		await fs.mkdir(path.join(storage, 'tasks'));
		const taskId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
		const taskFile = path.join(storage, 'tasks', taskId + '.json');
		await fs.writeFile(taskFile, JSON.stringify({
			schemaVersion: 1, id: taskId, attempts: [{ status: 'running' }]
		}));
		await assert.rejects(reconcileSharedExecutionFence(canonical, storage, true),
			/HARNESS_FENCE_RECOVERY_PENDING_TASK/);
		await fs.writeFile(taskFile, JSON.stringify({
			schemaVersion: 1, id: taskId, attempts: [{ status: 'interrupted' }]
		}));
		const result = await reconcileSharedExecutionFence(canonical, storage, true);
		assert.deepEqual(result, { released: true, epoch: 1, owner: 'native-workflow' });
		assert.deepEqual(await inspectSharedExecutionFence(canonical, storage), { held: false, epoch: null });
		await assert.rejects(fence.release(), /HARNESS_FENCE_LOST/);
		const successor = await acquireSharedExecutionFence(canonical, storage, 'native-task');
		assert.equal(successor.epoch, 2);
		await successor.release();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});

test('shared recovery never clears pending rollback, unknown project owners or foreign locks', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-recovery-negative-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-recovery-negative-data-'));
	try {
		const canonical = await fs.realpath(root);
		await acquireSharedExecutionFence(canonical, storage, 'native-agent');
		const lock = path.join(storage, 'shared-execution.lock');
		const record = JSON.parse(await fs.readFile(lock, 'utf8'));
		record.pid = 2147483647;
		await fs.writeFile(lock, JSON.stringify(record));
		await fs.mkdir(path.join(storage, 'checkpoints'));
		await fs.writeFile(path.join(storage, 'checkpoints', 'abc.rollback.intent'), '{}');
		await assert.rejects(reconcileSharedExecutionFence(canonical, storage, true),
			/HARNESS_FENCE_RECOVERY_PENDING_ROLLBACK/);
		await fs.rm(path.join(storage, 'checkpoints', 'abc.rollback.intent'));
		record.owner = 'project';
		await fs.writeFile(lock, JSON.stringify(record));
		await assert.rejects(reconcileSharedExecutionFence(canonical, storage, true),
			/HARNESS_FENCE_PROJECT_OWNER_UNSUPPORTED/);
		record.owner = 'native-agent';
		record.projectKey = createHash('sha256').update('foreign root').digest('hex');
		await fs.writeFile(lock, JSON.stringify(record));
		await assert.rejects(reconcileSharedExecutionFence(canonical, storage, true),
			/HARNESS_FENCE_UNSAFE_FILE/);
		assert.equal((await fs.lstat(lock)).isFile(), true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});

test('recovery guard prevents new leases; only its owner may remove it', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-guard-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-fence-guard-data-'));
	try {
		const canonical = await fs.realpath(root);
		const guard = path.join(storage, 'shared-execution.reconcile.guard');
		await fs.writeFile(guard, '{}');
		await assert.rejects(acquireSharedExecutionFence(canonical, storage, 'native-task'),
			/HARNESS_FENCE_RECOVERY_ACTIVE/);
		await assert.rejects(reconcileSharedExecutionFence(canonical, storage, true),
			/HARNESS_FENCE_RECOVERY_ACTIVE/);
		await fs.rm(guard);
		const lease = await acquireSharedExecutionFence(canonical, storage, 'native-task');
		await lease.release();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});
