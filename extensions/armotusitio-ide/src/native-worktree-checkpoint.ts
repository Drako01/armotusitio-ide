/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Conservative checkpoint and explicitly approved rollback for a managed,
 * detached worktree. Never resets the user's primary checkout or commits changes.
 * A crash during rollback leaves an intent marker and requires manual repair.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isCanonicalDirectory } from './native-path.ts';
import { resolveNativeCommand } from './native-runtime.ts';
import { listAgentWorktrees, type ManagedWorktree } from './native-agent-worktree.ts';
import type { SharedExecutionFence } from './native-shared-fence.ts';

const SHA = /^[a-f0-9]{40,64}$/i;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const MAX_BYTES = 2048;
interface CheckpointRecord {
	schemaVersion: 1;
	id: string;
	worktreeId: string;
	rootKey: string;
	parentKey: string;
	head: string;
	status: 'prepared' | 'rolled-back';
}
export interface WorktreeCheckpoint {
	id: string;
	head: string;
	status: 'prepared' | 'rolled-back';
}

/** Options for Git operations on managed checkouts; output is trimmed unless `raw` is set. */
export interface ManagedGitOptions {
	env?: Record<string, string>;
	maxBuffer?: number;
	raw?: boolean;
	failure?: string;
}

/** Run Git without a shell and with a minimal environment. */
export async function managedGit(root: string, args: string[], options: ManagedGitOptions = {}): Promise<string> {
	const command = await resolveNativeCommand('git', args);
	return await new Promise((resolve, reject) => {
		execFile(command.executable, command.args, {
			cwd: root, timeout: 60_000, windowsHide: true, maxBuffer: options.maxBuffer ?? 64 * 1024,
			env: {
				PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot,
				HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
				GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...options.env
			}
		}, (error, stdout) => error
			? reject(Error(options.failure ?? 'HARNESS_CHECKPOINT_GIT_FAILED'))
			: resolve(options.raw ? stdout : stdout.trim()));
	});
}
const git = (root: string, args: string[]): Promise<string> => managedGit(root, args);
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
/** Prove the descriptor is a registered managed worktree of its parent repository. */
export async function validateManagedWorktree(worktree: ManagedWorktree): Promise<void> {
	if (!UUID.test(worktree.id) || path.basename(worktree.root) !== 'wt-' + worktree.id) {
		throw Error('HARNESS_CHECKPOINT_WORKTREE_INVALID');
	}
	const root = await fs.realpath(worktree.root);
	const parent = await fs.realpath(worktree.parent);
	if (root !== worktree.root || parent !== worktree.parent || root === parent) {
		throw Error('HARNESS_CHECKPOINT_WORKTREE_INVALID');
	}
	const listed = await listAgentWorktrees(parent, path.dirname(root));
	if (!listed.some(item => item.id === worktree.id && item.root === root && item.parent === parent)) {
		throw Error('HARNESS_CHECKPOINT_WORKTREE_INVALID');
	}
	const expectedCommon = await fs.realpath(path.resolve(parent, await git(parent, ['rev-parse', '--git-common-dir'])));
	const currentCommon = await fs.realpath(path.resolve(root, await git(root, ['rev-parse', '--git-common-dir'])));
	if (expectedCommon !== currentCommon) { throw Error('HARNESS_CHECKPOINT_REPOSITORY_MISMATCH'); }
}
/** Create a private, canonical, non-linked state directory. */
export async function safeStorage(storage: string): Promise<void> {
	await fs.mkdir(storage, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(storage);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !await isCanonicalDirectory(storage)) {
		throw Error('HARNESS_CHECKPOINT_STORAGE_UNSAFE');
	}
}
async function readRecord(file: string): Promise<CheckpointRecord> {
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) {
		throw Error('HARNESS_CHECKPOINT_UNSAFE_RECORD');
	}
	let value: unknown;
	try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
	catch { throw Error('HARNESS_CHECKPOINT_UNSAFE_RECORD'); }
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('HARNESS_CHECKPOINT_UNSAFE_RECORD'); }
	const item = value as CheckpointRecord;
	if (Object.keys(item).sort().join(',') !== 'head,id,parentKey,rootKey,schemaVersion,status,worktreeId' ||
		item.schemaVersion !== 1 || !UUID.test(item.id) || !UUID.test(item.worktreeId) ||
		!SHA.test(item.head) || !/^[a-f0-9]{64}$/.test(item.rootKey) ||
		!/^[a-f0-9]{64}$/.test(item.parentKey) ||
		!['prepared', 'rolled-back'].includes(item.status)) {
		throw Error('HARNESS_CHECKPOINT_UNSAFE_RECORD');
	}
	return item;
}
/** fsync a bounded JSON record; non-exclusive writes replace atomically by rename. */
export async function writeDurable(file: string, value: unknown, exclusive: boolean, maxBytes = MAX_BYTES): Promise<void> {
	const bytes = JSON.stringify(value);
	if (Buffer.byteLength(bytes) > maxBytes) { throw Error('HARNESS_CHECKPOINT_UNSAFE_RECORD'); }
	const target = exclusive ? file : file + '.' + randomUUID() + '.tmp';
	const handle = await fs.open(target, 'wx', 0o600);
	try { await handle.writeFile(bytes); await handle.sync(); }
	finally { await handle.close(); }
	if (!exclusive) {
		try { await fs.rename(target, file); }
		finally { await fs.rm(target, { force: true }); }
	}
}

/** Begin only from a clean detached worktree under a currently owned fence. */
export async function createWorktreeCheckpoint(worktree: ManagedWorktree, storage: string, fence: SharedExecutionFence): Promise<WorktreeCheckpoint> {
	await fence.assertCurrent();
	await validateManagedWorktree(worktree);
	if (await git(worktree.root, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all'])) {
		throw Error('HARNESS_CHECKPOINT_DIRTY_START');
	}
	const head = await git(worktree.root, ['rev-parse', '--verify', 'HEAD']);
	if (!SHA.test(head)) { throw Error('HARNESS_CHECKPOINT_HEAD_INVALID'); }
	await safeStorage(storage);
	const record: CheckpointRecord = {
		schemaVersion: 1, id: randomUUID(), worktreeId: worktree.id,
		rootKey: digest(worktree.root), parentKey: digest(worktree.parent),
		head, status: 'prepared'
	};
	await fence.assertCurrent();
	await writeDurable(path.join(storage, record.id + '.json'), record, true);
	return { id: record.id, head: record.head, status: record.status };
}

async function preparedRecord(worktree: ManagedWorktree, storage: string, id: string): Promise<{ record: CheckpointRecord; file: string }> {
	if (!UUID.test(id)) { throw Error('HARNESS_CHECKPOINT_ID_INVALID'); }
	await validateManagedWorktree(worktree);
	await safeStorage(storage);
	const file = path.join(storage, id + '.json');
	const record = await readRecord(file);
	if (record.id !== id || record.worktreeId !== worktree.id ||
		record.rootKey !== digest(worktree.root) || record.parentKey !== digest(worktree.parent) ||
		record.status !== 'prepared') {
		throw Error('HARNESS_CHECKPOINT_IDENTITY_MISMATCH');
	}
	return { record, file };
}

/** Read a still-prepared checkpoint that belongs to this exact managed worktree. */
export async function readWorktreeCheckpoint(worktree: ManagedWorktree, storage: string, id: string): Promise<WorktreeCheckpoint> {
	const { record } = await preparedRecord(worktree, storage, id);
	return { id: record.id, head: record.head, status: record.status };
}

/**
 * Destructive only inside an owned detached worktree, with explicit confirmation.
 * Refuses changed HEAD, foreign descriptors, unknown records and pending journals.
 * Never auto-retries if Git reset/clean fails; preserves the rollback intent.
 */
export async function rollbackWorktreeCheckpoint(
	worktree: ManagedWorktree, storage: string, id: string,
	fence: SharedExecutionFence, explicitlyApproved: boolean
): Promise<WorktreeCheckpoint> {
	if (!explicitlyApproved) { throw Error('HARNESS_CHECKPOINT_APPROVAL_REQUIRED'); }
	await fence.assertCurrent();
	const { record, file } = await preparedRecord(worktree, storage, id);
	if (await git(worktree.root, ['rev-parse', '--verify', 'HEAD']) !== record.head) {
		throw Error('HARNESS_CHECKPOINT_HEAD_CHANGED');
	}
	const intent = file + '.rollback.intent';
	await fence.assertCurrent();
	await writeDurable(intent, { schemaVersion: 1, checkpointId: id, epoch: fence.epoch }, true);
	// A crash or failure below leaves the intent in place, never replays automatically.
	await git(worktree.root, ['reset', '--hard', record.head]);
	await fence.assertCurrent();
	await git(worktree.root, ['clean', '-fd']);
	if (await git(worktree.root, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all'])) {
		throw Error('HARNESS_CHECKPOINT_ROLLBACK_INCOMPLETE');
	}
	await fence.assertCurrent();
	const finished: CheckpointRecord = { ...record, status: 'rolled-back' };
	await writeDurable(file, finished, false);
	await fs.rm(intent);
	return { id, head: record.head, status: 'rolled-back' };
}
