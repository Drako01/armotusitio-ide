/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createAgentWorktree, removeCleanAgentWorktree } from '../src/native-agent-worktree.ts';
import { acquireSharedExecutionFence } from '../src/native-shared-fence.ts';
import { createWorktreeCheckpoint, rollbackWorktreeCheckpoint } from '../src/native-worktree-checkpoint.ts';

test('explicit rollback restores only the managed worktree, leaving primary checkout unchanged', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-checkpoint-root-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-checkpoint-state-'));
	try {
		execFileSync('git', ['init', '-q', root]);
		await fs.writeFile(path.join(root, 'tracked.txt'), 'baseline');
		execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
		execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'seed']);
		const canonical = await fs.realpath(root);
		const managed = await createAgentWorktree(canonical, path.join(storage, 'worktrees'));
		const fence = await acquireSharedExecutionFence(canonical, path.join(storage, 'fences'), 'native-workflow');
		try {
			const checkpoint = await createWorktreeCheckpoint(managed, path.join(storage, 'checkpoints'), fence);
			await fs.writeFile(path.join(managed.root, 'tracked.txt'), 'agent change');
			await fs.writeFile(path.join(managed.root, 'new.txt'), 'generated');
			await assert.rejects(rollbackWorktreeCheckpoint(managed, path.join(storage, 'checkpoints'),
				checkpoint.id, fence, false), /HARNESS_CHECKPOINT_APPROVAL_REQUIRED/);
			assert.equal(await fs.readFile(path.join(managed.root, 'tracked.txt'), 'utf8'), 'agent change');
			const result = await rollbackWorktreeCheckpoint(managed, path.join(storage, 'checkpoints'),
				checkpoint.id, fence, true);
			assert.equal(result.status, 'rolled-back');
			assert.equal(await fs.readFile(path.join(managed.root, 'tracked.txt'), 'utf8'), 'baseline');
			await assert.rejects(fs.stat(path.join(managed.root, 'new.txt')), { code: 'ENOENT' });
			assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'baseline');
			assert.equal((await fs.readdir(path.join(storage, 'checkpoints'))).length, 1);
		} finally {
			await fence.release();
			await removeCleanAgentWorktree(managed);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});

test('checkpoint refuses a stale or forged worktree descriptor before mutating', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-checkpoint-invalid-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-checkpoint-invalid-state-'));
	try {
		const fence = await acquireSharedExecutionFence(await fs.realpath(root), path.join(storage, 'fences'), 'native-workflow');
		try {
			await assert.rejects(createWorktreeCheckpoint({
				root: await fs.realpath(root), parent: await fs.realpath(root), id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
			}, path.join(storage, 'checkpoints'), fence), /HARNESS_CHECKPOINT_WORKTREE_INVALID/);
		} finally { await fence.release(); }
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
});
