/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { acquireSharedExecutionFence, inspectSharedExecutionFence } from '../src/native-shared-fence.ts';

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
