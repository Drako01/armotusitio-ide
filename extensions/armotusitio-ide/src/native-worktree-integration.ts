/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Transactional integration of reviewed changes from a managed worktree into the
 * primary checkout. The record status is a write-ahead journal: `applying` and
 * `rolling-back` are persisted before Git touches files, and `git apply` is
 * all-or-nothing, so recovery can always classify the outcome from file state.
 * Never commits, stages in the primary index, merges or force-resolves conflicts.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ManagedWorktree } from './native-agent-worktree.ts';
import type { SharedExecutionFence } from './native-shared-fence.ts';
import { digest, managedGit, safeStorage, validateManagedWorktree, writeDurable } from './native-worktree-checkpoint.ts';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40,64}$/i;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_RECORD_BYTES = 512 * 1024;
const STATES = ['applying', 'applied', 'aborted', 'rolling-back', 'rolled-back'] as const;
type IntegrationState = typeof STATES[number];
interface IntegrationRecord {
	schemaVersion: 1;
	id: string;
	worktreeId: string;
	parentKey: string;
	base: string;
	patchDigest: string;
	files: string[];
	status: IntegrationState;
}
/** Metadata-only view of an integration; never contains file contents. */
export interface WorktreeIntegration {
	id: string;
	status: IntegrationState;
	files: string[];
	patchDigest: string;
}
const fail = (code: string) => Error('HARNESS_INTEGRATION_' + code);
const view = (record: IntegrationRecord): WorktreeIntegration =>
	({ id: record.id, status: record.status, files: [...record.files], patchDigest: record.patchDigest });
const git = (root: string, args: string[], env?: Record<string, string>, raw = false): Promise<string> =>
	managedGit(root, args, { env, raw, maxBuffer: MAX_PATCH_BYTES + 1024, failure: 'HARNESS_INTEGRATION_GIT_FAILED' });

/** Run a Git probe whose non-zero exit is an expected answer, not an error. */
async function succeeds(root: string, args: string[]): Promise<boolean> {
	try { await git(root, args); return true; }
	catch { return false; }
}

function validRelative(file: string): boolean {
	return file.length > 0 && file.length <= 4096 && !file.includes('\0') && !path.isAbsolute(file) &&
		!file.split(/[\\/]/).some(part => part === '..' || part === '') && !/^[a-z]:/i.test(file);
}

async function readRecord(file: string): Promise<IntegrationRecord> {
	const stat = await fs.lstat(file).catch(() => undefined);
	if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) { throw fail('RECORD_UNSAFE'); }
	let value: unknown;
	try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
	catch { throw fail('RECORD_UNSAFE'); }
	const item = value as IntegrationRecord;
	if (!item || typeof item !== 'object' || Array.isArray(item) ||
		Object.keys(item).sort().join(',') !== 'base,files,id,parentKey,patchDigest,schemaVersion,status,worktreeId' ||
		item.schemaVersion !== 1 || !UUID.test(item.id) || !UUID.test(item.worktreeId) || !SHA.test(item.base) ||
		!/^[a-f0-9]{64}$/.test(item.parentKey) || !/^[a-f0-9]{64}$/.test(item.patchDigest) ||
		!Array.isArray(item.files) || !item.files.length || item.files.length > MAX_FILES ||
		!item.files.every(entry => typeof entry === 'string' && validRelative(entry)) ||
		!STATES.includes(item.status)) {
		throw fail('RECORD_UNSAFE');
	}
	return item;
}

/** Load the record, its patch, and prove both belong to this primary checkout. */
async function load(primary: string, storage: string, id: string): Promise<{ record: IntegrationRecord; file: string; patch: string }> {
	if (!UUID.test(id)) { throw fail('ID_INVALID'); }
	const canonical = await fs.realpath(primary);
	if (canonical !== primary) { throw fail('PRIMARY_INVALID'); }
	await safeStorage(storage);
	const file = path.join(storage, id + '.json');
	const record = await readRecord(file);
	if (record.id !== id || record.parentKey !== digest(primary)) { throw fail('IDENTITY_MISMATCH'); }
	const patch = path.join(storage, id + '.patch');
	const stat = await fs.lstat(patch).catch(() => undefined);
	if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_PATCH_BYTES ||
		digest(await fs.readFile(patch)) !== record.patchDigest) {
		throw fail('PATCH_CHANGED');
	}
	return { record, file, patch };
}

/**
 * Apply every change of an owned worktree (relative to its checkpoint HEAD) to the
 * primary checkout working tree, or nothing. Refuses when the primary checkout has
 * local edits on any affected path or the patch does not apply cleanly.
 */
export async function integrateWorktreeChanges(
	worktree: ManagedWorktree, base: string, storage: string,
	fence: SharedExecutionFence, explicitlyApproved: boolean
): Promise<WorktreeIntegration> {
	if (!explicitlyApproved) { throw fail('APPROVAL_REQUIRED'); }
	if (!SHA.test(base)) { throw fail('BASE_INVALID'); }
	await fence.assertCurrent();
	await validateManagedWorktree(worktree);
	await safeStorage(storage);
	if (await git(worktree.root, ['rev-parse', '--verify', 'HEAD']) !== base) { throw fail('HEAD_CHANGED'); }
	const id = randomUUID();
	// A private index captures tracked, deleted and untracked (non-ignored) changes
	// without staging anything in the worktree or primary checkout.
	const index = path.join(storage, id + '.index');
	let patchText: string;
	let files: string[];
	try {
		const env = { GIT_INDEX_FILE: index };
		await git(worktree.root, ['read-tree', base], env);
		await git(worktree.root, ['add', '-A', '--', '.'], env);
		patchText = await git(worktree.root, ['diff', '--cached', '--binary', '--full-index', '--no-color', '--no-ext-diff', base], env, true);
		files = (await git(worktree.root, ['diff', '--cached', '--name-only', '-z', '--no-renames', base], env, true))
			.split('\0').filter(Boolean);
	} finally { await fs.rm(index, { force: true }); }
	if (!patchText.trim() || !files.length) { throw fail('EMPTY'); }
	if (Buffer.byteLength(patchText) > MAX_PATCH_BYTES || files.length > MAX_FILES || !files.every(validRelative)) {
		throw fail('TOO_LARGE');
	}
	const primary = worktree.parent;
	if (await git(primary, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...files])) {
		throw fail('PRIMARY_DIRTY');
	}
	const patch = path.join(storage, id + '.patch');
	const handle = await fs.open(patch, 'wx', 0o600);
	try { await handle.writeFile(patchText); await handle.sync(); }
	finally { await handle.close(); }
	if (!await succeeds(primary, ['apply', '--check', '--binary', patch])) {
		await fs.rm(patch, { force: true });
		throw fail('CONFLICT');
	}
	const record: IntegrationRecord = {
		schemaVersion: 1, id, worktreeId: worktree.id, parentKey: digest(primary), base,
		patchDigest: digest(Buffer.from(patchText)), files, status: 'applying'
	};
	const file = path.join(storage, id + '.json');
	await fence.assertCurrent();
	await writeDurable(file, record, true, MAX_RECORD_BYTES);
	// From here a crash leaves `applying`; reconcileWorktreeIntegration classifies it.
	await git(primary, ['apply', '--binary', patch]);
	if (!await succeeds(primary, ['apply', '--check', '--reverse', '--binary', patch])) { throw fail('VERIFY_FAILED'); }
	const applied: IntegrationRecord = { ...record, status: 'applied' };
	await writeDurable(file, applied, false, MAX_RECORD_BYTES);
	return view(applied);
}

/** Revert an applied integration only if the primary files still match it exactly. */
export async function rollbackWorktreeIntegration(
	primary: string, storage: string, id: string,
	fence: SharedExecutionFence, explicitlyApproved: boolean
): Promise<WorktreeIntegration> {
	if (!explicitlyApproved) { throw fail('APPROVAL_REQUIRED'); }
	await fence.assertCurrent();
	const { record, file, patch } = await load(primary, storage, id);
	if (record.status !== 'applied') { throw fail('STATE_INVALID'); }
	if (!await succeeds(primary, ['apply', '--check', '--reverse', '--binary', patch])) {
		throw fail('ROLLBACK_CONFLICT');
	}
	await fence.assertCurrent();
	await writeDurable(file, { ...record, status: 'rolling-back' }, false, MAX_RECORD_BYTES);
	await git(primary, ['apply', '--reverse', '--binary', patch]);
	const finished: IntegrationRecord = { ...record, status: 'rolled-back' };
	await writeDurable(file, finished, false, MAX_RECORD_BYTES);
	return view(finished);
}

/**
 * Resolve an interrupted `applying` / `rolling-back` journal from observed file
 * state. Exactly one direction must apply cleanly; anything else is ambiguous and
 * stays pending for manual repair. Never re-applies or re-runs providers.
 */
export async function reconcileWorktreeIntegration(
	primary: string, storage: string, id: string, fence: SharedExecutionFence
): Promise<WorktreeIntegration> {
	await fence.assertCurrent();
	const { record, file, patch } = await load(primary, storage, id);
	if (record.status !== 'applying' && record.status !== 'rolling-back') { return view(record); }
	const forward = await succeeds(primary, ['apply', '--check', '--binary', patch]);
	const reverse = await succeeds(primary, ['apply', '--check', '--reverse', '--binary', patch]);
	if (forward === reverse) { throw fail('RECOVERY_AMBIGUOUS'); }
	// The patch is in place (reverse applies) or absent; absence means the journaled step never ran or completed rollback.
	let status: IntegrationState = 'applied';
	if (!reverse) { status = record.status === 'applying' ? 'aborted' : 'rolled-back'; }
	const resolved: IntegrationRecord = { ...record, status };
	await fence.assertCurrent();
	await writeDurable(file, resolved, false, MAX_RECORD_BYTES);
	return view(resolved);
}

/** IDs whose journal is still in a transitional state. */
export async function pendingWorktreeIntegrations(primary: string, storage: string): Promise<string[]> {
	const entries = await fs.readdir(storage).catch(() => [] as string[]);
	const pending: string[] = [];
	for (const name of entries) {
		const match = /^(?<id>[a-f0-9-]{36})\.json$/i.exec(name);
		if (!match?.groups) { continue; }
		const { record } = await load(primary, storage, match.groups.id);
		if (record.status === 'applying' || record.status === 'rolling-back') { pending.push(record.id); }
	}
	return pending.sort();
}
