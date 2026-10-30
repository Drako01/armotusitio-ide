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
import { createAgentWorktree, removeCleanAgentWorktree, type ManagedWorktree } from '../src/native-agent-worktree.ts';
import { acquireSharedExecutionFence, type SharedExecutionFence } from '../src/native-shared-fence.ts';
import { createWorktreeCheckpoint } from '../src/native-worktree-checkpoint.ts';
import {
	integrateWorktreeChanges, pendingWorktreeIntegrations, reconcileWorktreeIntegration, rollbackWorktreeIntegration
} from '../src/native-worktree-integration.ts';

interface Fixture { primary: string; storage: string; managed: ManagedWorktree; fence: SharedExecutionFence; base: string }

async function withFixture(autocrlf: 'false' | 'true', work: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-integration-root-'));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-integration-state-'));
	try {
		execFileSync('git', ['init', '-q', root]);
		execFileSync('git', ['-C', root, 'config', 'core.autocrlf', autocrlf]);
		await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
		await fs.writeFile(path.join(root, 'gone.txt'), 'delete me\n');
		await fs.writeFile(path.join(root, 'other.txt'), 'user owned\n');
		execFileSync('git', ['-C', root, 'add', '.']);
		execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'seed']);
		const primary = await fs.realpath(root);
		const managed = await createAgentWorktree(primary, path.join(storage, 'worktrees'));
		const fence = await acquireSharedExecutionFence(primary, path.join(storage, 'fences'), 'native-workflow');
		try {
			const checkpoint = await createWorktreeCheckpoint(managed, path.join(storage, 'checkpoints'), fence);
			await work({ primary, storage: path.join(storage, 'integrations'), managed, fence, base: checkpoint.head });
		} finally {
			await fence.release();
			execFileSync('git', ['-C', managed.root, 'reset', '-q', '--hard']);
			execFileSync('git', ['-C', managed.root, 'clean', '-qfd']);
			await removeCleanAgentWorktree(managed);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(storage, { recursive: true, force: true });
	}
}

async function agentEdits(worktree: string): Promise<void> {
	await fs.writeFile(path.join(worktree, 'a.txt'), 'one\nTWO\nthree\n');
	await fs.rm(path.join(worktree, 'gone.txt'));
	await fs.mkdir(path.join(worktree, 'src'));
	await fs.writeFile(path.join(worktree, 'src', 'new.ts'), 'export const value = 1;\n');
	await fs.writeFile(path.join(worktree, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 10]));
}

async function snapshot(primary: string): Promise<Record<string, string | null>> {
	const read = async (file: string): Promise<string | null> =>
		fs.readFile(path.join(primary, file), 'latin1').then(text => text.replaceAll('\r\n', '\n'), () => null);
	return {
		'a.txt': await read('a.txt'), 'gone.txt': await read('gone.txt'), 'other.txt': await read('other.txt'),
		'src/new.ts': await read('src/new.ts'), 'blob.bin': await read('blob.bin')
	};
}

for (const autocrlf of ['false', 'true'] as const) {
	test(`integration applies all reviewed changes atomically and rolls back exactly (autocrlf=${autocrlf})`, () => withFixture(autocrlf, async ({ primary, storage, managed, fence, base }) => {
		await agentEdits(managed.root);
		await assert.rejects(integrateWorktreeChanges(managed, base, storage, fence, false), /HARNESS_INTEGRATION_APPROVAL_REQUIRED/);
		const before = await snapshot(primary);
		const applied = await integrateWorktreeChanges(managed, base, storage, fence, true);
		assert.deepStrictEqual({ status: applied.status, files: [...applied.files].sort(), state: await snapshot(primary), staged: execFileSync('git', ['-C', primary, 'diff', '--cached', '--name-only']).toString() }, {
			status: 'applied', files: ['a.txt', 'blob.bin', 'gone.txt', 'src/new.ts'],
			state: { 'a.txt': 'one\nTWO\nthree\n', 'gone.txt': null, 'other.txt': 'user owned\n', 'src/new.ts': 'export const value = 1;\n', 'blob.bin': Buffer.from([0, 1, 2, 255, 0, 10]).toString('latin1') },
			staged: ''
		});
		const rolledBack = await rollbackWorktreeIntegration(primary, storage, applied.id, fence, true);
		assert.deepStrictEqual({ status: rolledBack.status, state: await snapshot(primary), pending: await pendingWorktreeIntegrations(primary, storage) },
			{ status: 'rolled-back', state: before, pending: [] });
	}));
}

test('integration refuses dirty or conflicting primary checkouts without writing anything', () => withFixture('false', async ({ primary, storage, managed, fence, base }) => {
	await agentEdits(managed.root);
	await fs.writeFile(path.join(primary, 'a.txt'), 'local edit\n');
	await assert.rejects(integrateWorktreeChanges(managed, base, storage, fence, true), /HARNESS_INTEGRATION_PRIMARY_DIRTY/);
	// A committed divergent change keeps the checkout clean but cannot accept the patch.
	await fs.writeFile(path.join(primary, 'a.txt'), 'one\nDIFFERENT\nthree\n');
	execFileSync('git', ['-C', primary, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'diverge']);
	await assert.rejects(integrateWorktreeChanges(managed, base, storage, fence, true), /HARNESS_INTEGRATION_CONFLICT/);
	assert.deepStrictEqual({ files: await fs.readdir(storage), state: await snapshot(primary) }, {
		files: [],
		state: { 'a.txt': 'one\nDIFFERENT\nthree\n', 'gone.txt': 'delete me\n', 'other.txt': 'user owned\n', 'src/new.ts': null, 'blob.bin': null }
	});
}));

test('rollback refuses to overwrite edits made after integration and rejects tampered patches', () => withFixture('false', async ({ primary, storage, managed, fence, base }) => {
	await agentEdits(managed.root);
	const applied = await integrateWorktreeChanges(managed, base, storage, fence, true);
	await fs.writeFile(path.join(primary, 'src', 'new.ts'), 'export const value = 2;\n');
	await assert.rejects(rollbackWorktreeIntegration(primary, storage, applied.id, fence, true), /HARNESS_INTEGRATION_ROLLBACK_CONFLICT/);
	assert.equal(await fs.readFile(path.join(primary, 'src', 'new.ts'), 'utf8'), 'export const value = 2;\n');
	await fs.appendFile(path.join(storage, applied.id + '.patch'), '\n');
	await assert.rejects(rollbackWorktreeIntegration(primary, storage, applied.id, fence, true), /HARNESS_INTEGRATION_PATCH_CHANGED/);
}));

test('interrupted journals are classified from file state and ambiguous ones are kept', () => withFixture('false', async ({ primary, storage, managed, fence, base }) => {
	await agentEdits(managed.root);
	const applied = await integrateWorktreeChanges(managed, base, storage, fence, true);
	const recordFile = path.join(storage, applied.id + '.json');
	const setStatus = async (status: string): Promise<void> => {
		const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
		await fs.writeFile(recordFile, JSON.stringify({ ...record, status }));
	};
	// Crash after `git apply` but before the `applied` record.
	await setStatus('applying');
	assert.deepStrictEqual(await pendingWorktreeIntegrations(primary, storage), [applied.id]);
	assert.equal((await reconcileWorktreeIntegration(primary, storage, applied.id, fence)).status, 'applied');
	// Crash after the `rolling-back` record but before `git apply --reverse`.
	await setStatus('rolling-back');
	assert.equal((await reconcileWorktreeIntegration(primary, storage, applied.id, fence)).status, 'applied');
	await rollbackWorktreeIntegration(primary, storage, applied.id, fence, true);
	// Crash after the `applying` record but before `git apply` ran.
	await setStatus('applying');
	assert.equal((await reconcileWorktreeIntegration(primary, storage, applied.id, fence)).status, 'aborted');
	// Partially edited files match neither direction: recovery stays manual.
	await setStatus('applying');
	await fs.writeFile(path.join(primary, 'a.txt'), 'unrelated\n');
	await fs.writeFile(path.join(primary, 'src-conflict.txt'), 'x');
	await fs.mkdir(path.join(primary, 'src'), { recursive: true });
	await fs.writeFile(path.join(primary, 'src', 'new.ts'), 'export const value = 1;\n');
	await assert.rejects(reconcileWorktreeIntegration(primary, storage, applied.id, fence), /HARNESS_INTEGRATION_RECOVERY_AMBIGUOUS/);
	assert.deepStrictEqual(await pendingWorktreeIntegrations(primary, storage), [applied.id]);
}));

test('integration requires a non-empty change set from the checkpoint HEAD', () => withFixture('false', async ({ storage, managed, fence, base }) => {
	await assert.rejects(integrateWorktreeChanges(managed, base, storage, fence, true), /HARNESS_INTEGRATION_EMPTY/);
	await assert.rejects(integrateWorktreeChanges(managed, '0'.repeat(40), storage, fence, true), /HARNESS_INTEGRATION_HEAD_CHANGED/);
}));
