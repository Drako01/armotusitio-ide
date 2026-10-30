/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Local cross-process execution fence. All participating engines must use the SAME storage path. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export type FenceOwner = 'native-task' | 'native-agent' | 'native-workflow' | 'project';
export interface SharedExecutionFence {
	readonly epoch: number;
	readonly token: string;
	/** Check ownership immediately before an effect; this is not an OS-enforced lock. */
	assertCurrent(): Promise<void>;
	/** Remove only the exact lock created by this owner. Never steal an uncertain lock. */
	release(): Promise<void>;
}
const LOCK = 'shared-execution.lock';
const EPOCH = 'shared-execution.epoch';
const RECOVERY_GUARD = 'shared-execution.reconcile.guard';
const MAX_BYTES = 2048;
const OWNERS: readonly FenceOwner[] = ['native-task', 'native-agent', 'native-workflow', 'project'];
type FenceRecord = { schemaVersion: 1; projectKey: string; epoch: number; token: string; owner: FenceOwner; pid: number };
type EpochRecord = { schemaVersion: 1; projectKey: string; epoch: number };

function validEpoch(value: unknown, projectKey: string): value is EpochRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
	const record = value as EpochRecord;
	return Object.keys(record).sort().join(',') === 'epoch,projectKey,schemaVersion' &&
		record.schemaVersion === 1 && record.projectKey === projectKey &&
		Number.isSafeInteger(record.epoch) && record.epoch >= 1;
}
function validFence(value: unknown, projectKey: string): value is FenceRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
	const record = value as FenceRecord;
	return Object.keys(record).sort().join(',') === 'epoch,owner,pid,projectKey,schemaVersion,token' &&
		record.schemaVersion === 1 && record.projectKey === projectKey &&
		Number.isSafeInteger(record.epoch) && record.epoch > 0 &&
		typeof record.token === 'string' && /^[a-f0-9]{32}$/.test(record.token) &&
		OWNERS.includes(record.owner) && Number.isSafeInteger(record.pid) && record.pid > 0;
}
async function readJson(file: string): Promise<unknown> {
	const info = await fs.lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) { throw Error('HARNESS_FENCE_UNSAFE_FILE'); }
	const bytes = await fs.readFile(file);
	if (bytes.length > MAX_BYTES) { throw Error('HARNESS_FENCE_UNSAFE_FILE'); }
	try { return JSON.parse(bytes.toString('utf8')); }
	catch { throw Error('HARNESS_FENCE_UNSAFE_FILE'); }
}
async function assertNoRecoveryGuard(storage: string): Promise<void> {
	try {
		await fs.lstat(path.join(storage, RECOVERY_GUARD));
		throw Error('HARNESS_FENCE_RECOVERY_ACTIVE');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
	}
}
async function currentEpoch(storage: string, projectKey: string): Promise<number> {
	let value: unknown;
	try { value = await readJson(path.join(storage, EPOCH)); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return 0; }
		throw error;
	}
	if (!validEpoch(value, projectKey)) { throw Error('HARNESS_FENCE_EPOCH_INVALID'); }
	return value.epoch;
}
async function storeEpoch(storage: string, projectKey: string, epoch: number): Promise<void> {
	const target = path.join(storage, EPOCH);
	const tmp = target + '.' + randomUUID() + '.tmp';
	const handle = await fs.open(tmp, 'wx', 0o600);
	try {
		await handle.writeFile(JSON.stringify({ schemaVersion: 1, projectKey, epoch }));
		await handle.sync();
	} finally { await handle.close(); }
	try { await fs.rename(tmp, target); }
	finally { await fs.rm(tmp, { force: true }); }
}

/**
 * Fail-closed across IDE windows and processes on a local filesystem. No stale
 * lock is cleared automatically: an operator must reconcile uncertain effects.
 * Not a distributed lock and not protection against a nonparticipating process.
 */
export async function acquireSharedExecutionFence(root: string, storage: string, owner: FenceOwner): Promise<SharedExecutionFence> {
	if (!OWNERS.includes(owner)) { throw Error('HARNESS_FENCE_OWNER_INVALID'); }
	const canonical = await fs.realpath(root);
	if (canonical !== root || !(await fs.stat(canonical)).isDirectory()) { throw Error('HARNESS_FENCE_ROOT_CHANGED'); }
	await fs.mkdir(storage, { recursive: true, mode: 0o700 });
	const directory = await fs.lstat(storage);
	if (!directory.isDirectory() || directory.isSymbolicLink() ||
		await fs.realpath(storage) !== path.resolve(storage)) { throw Error('HARNESS_FENCE_STORAGE_UNSAFE'); }
	const projectKey = createHash('sha256').update(canonical).digest('hex');
	await assertNoRecoveryGuard(storage);
	const lockPath = path.join(storage, LOCK);
	const handle = await fs.open(lockPath, 'wx', 0o600).catch(error => {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') { throw Error('HARNESS_FENCE_HELD_RECONCILIATION_REQUIRED'); }
		throw error;
	});
	const identity = await handle.stat();
	let record: FenceRecord;
	try {
		const previous = await currentEpoch(storage, projectKey);
		if (previous >= Number.MAX_SAFE_INTEGER) { throw Error('HARNESS_FENCE_EPOCH_EXHAUSTED'); }
		record = {
			schemaVersion: 1, projectKey, epoch: previous + 1,
			token: randomBytes(16).toString('hex'), owner, pid: process.pid
		};
		await storeEpoch(storage, projectKey, record.epoch);
		await handle.writeFile(JSON.stringify(record));
		await handle.sync();
	} finally { await handle.close(); }
	const expected = JSON.stringify(record!);
	await assertNoRecoveryGuard(storage);
	let released = false;
	const assertCurrent = async (): Promise<void> => {
		if (released) { throw Error('HARNESS_FENCE_ALREADY_RELEASED'); }
		const stat = await fs.lstat(lockPath).catch(() => { throw Error('HARNESS_FENCE_LOST'); });
		if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino ||
			await fs.readFile(lockPath, 'utf8') !== expected ||
			await currentEpoch(storage, projectKey) !== record!.epoch) {
			throw Error('HARNESS_FENCE_LOST');
		}
	};
	return Object.freeze({
		epoch: record!.epoch, token: record!.token,
		assertCurrent,
		release: async (): Promise<void> => {
			await assertCurrent();
			await fs.rm(lockPath);
			released = true;
		}
	});
}

/** Redacted inspection for diagnostics only. Never unlocks or infers stale ownership. */
export async function inspectSharedExecutionFence(root: string, storage: string): Promise<{ held: boolean; epoch: number | null; owner?: FenceOwner }> {
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_FENCE_ROOT_CHANGED'); }
	const projectKey = createHash('sha256').update(canonical).digest('hex');
	let record: unknown;
	try { record = await readJson(path.join(storage, LOCK)); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { held: false, epoch: null }; }
		throw error;
	}
	if (!validFence(record, projectKey)) { throw Error('HARNESS_FENCE_UNSAFE_FILE'); }
	return { held: true, epoch: record.epoch, owner: record.owner };
}

export interface SharedFenceRecovery {
	released: boolean;
	epoch: number | null;
	owner?: FenceOwner;
}

/** A missing process is necessary but not sufficient for recovery. EPERM remains uncertain. */
function assertOwnerExited(pid: number): void {
	try {
		process.kill(pid, 0);
		throw Error('HARNESS_FENCE_OWNER_ACTIVE');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; }
	}
}

async function assertNoUncertainArtifacts(storage: string): Promise<void> {
	const checkDir = async (name: string, inspect: (file: string) => Promise<void>): Promise<void> => {
		const directory = path.join(storage, name);
		let info;
		try { info = await fs.lstat(directory); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; }
			throw error;
		}
		if (!info.isDirectory() || info.isSymbolicLink() ||
			await fs.realpath(directory) !== directory) { throw Error('HARNESS_FENCE_RECOVERY_UNSAFE_STATE'); }
		const entries = await fs.readdir(directory, { withFileTypes: true });
		if (entries.length > 600) { throw Error('HARNESS_FENCE_RECOVERY_UNSAFE_STATE'); }
		for (const entry of entries) {
			if (entry.isSymbolicLink()) { throw Error('HARNESS_FENCE_RECOVERY_UNSAFE_STATE'); }
			await inspect(entry.name);
		}
	};
	for (const file of ['execution.lock']) {
		try {
			await fs.lstat(path.join(storage, file));
			throw Error('HARNESS_FENCE_RECOVERY_LOCAL_LOCK');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
		}
	}
	await checkDir('workflows', async name => {
		if (name === 'execution.lock' || name === 'reconcile.guard' ||
			name.endsWith('.intent')) { throw Error('HARNESS_FENCE_RECOVERY_PENDING_WORKFLOW'); }
		if (!/^[a-f0-9-]{36}\.json$/i.test(name)) { return; }
		const file = path.join(storage, 'workflows', name);
		const record = await readJsonRecovery(file, 128 * 1024);
		if (!record || typeof record !== 'object' || Array.isArray(record) ||
			!['passed', 'failed', 'cancelled', 'interrupted'].includes((record as { status?: string }).status ?? '')) {
			throw Error('HARNESS_FENCE_RECOVERY_PENDING_WORKFLOW');
		}
	});
	await checkDir('tasks', async name => {
		if (!/^[a-f0-9-]{36}\.json$/i.test(name)) { return; }
		const file = path.join(storage, 'tasks', name);
		const task = await readJsonRecovery(file, 2 * 1024 * 1024);
		if (!task || typeof task !== 'object' || Array.isArray(task) ||
			!Array.isArray((task as { attempts?: unknown }).attempts) ||
			(task as { attempts: Array<{ status?: string }> }).attempts.some(attempt =>
				!attempt || !['passed', 'failed', 'cancelled', 'interrupted'].includes(attempt.status ?? ''))) {
			throw Error('HARNESS_FENCE_RECOVERY_PENDING_TASK');
		}
	});
	await checkDir('checkpoints', async name => {
		if (name.endsWith('.rollback.intent')) { throw Error('HARNESS_FENCE_RECOVERY_PENDING_ROLLBACK'); }
	});
}

async function readJsonRecovery(file: string, maxBytes: number): Promise<unknown> {
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
		throw Error('HARNESS_FENCE_RECOVERY_UNSAFE_STATE');
	}
	const bytes = await fs.readFile(file);
	if (bytes.length > maxBytes) { throw Error('HARNESS_FENCE_RECOVERY_UNSAFE_STATE'); }
	try { return JSON.parse(bytes.toString('utf8')); }
	catch { throw Error('HARNESS_FENCE_RECOVERY_UNSAFE_STATE'); }
}

/**
 * Explicit operator-only recovery of a CRASHED local fence. Reconcile the task
 * and workflow records separately first. This API cannot prove remote writers
 * exited or repair an uncertain rollback, so it refuses those situations.
 * Never removes an active, foreign or replaced lock. No automatic retry.
 */
export async function reconcileSharedExecutionFence(
	root: string, storage: string, approved: boolean
): Promise<SharedFenceRecovery> {
	if (!approved) { throw Error('HARNESS_FENCE_RECOVERY_CONSENT_REQUIRED'); }
	const canonical = await fs.realpath(root);
	if (canonical !== root || !(await fs.stat(canonical)).isDirectory()) {
		throw Error('HARNESS_FENCE_ROOT_CHANGED');
	}
	const directory = await fs.lstat(storage);
	if (!directory.isDirectory() || directory.isSymbolicLink() ||
		await fs.realpath(storage) !== path.resolve(storage)) {
		throw Error('HARNESS_FENCE_STORAGE_UNSAFE');
	}
	const guardPath = path.join(storage, RECOVERY_GUARD);
	const guard = await fs.open(guardPath, 'wx', 0o600).catch(error => {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			throw Error('HARNESS_FENCE_RECOVERY_ACTIVE');
		}
		throw error;
	});
	const identity = await guard.stat();
	const guardData = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString('hex') });
	let recorded = false;
	try {
		await guard.writeFile(guardData);
		await guard.sync();
		recorded = true;
		const projectKey = createHash('sha256').update(canonical).digest('hex');
		const file = path.join(storage, LOCK);
		let value: unknown;
		try { value = await readJson(file); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { released: false, epoch: null };
			}
			throw error;
		}
		if (!validFence(value, projectKey)) { throw Error('HARNESS_FENCE_UNSAFE_FILE'); }
		if (value.owner === 'project') { throw Error('HARNESS_FENCE_PROJECT_OWNER_UNSUPPORTED'); }
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink()) { throw Error('HARNESS_FENCE_UNSAFE_FILE'); }
		assertOwnerExited(value.pid);
		if (await currentEpoch(storage, projectKey) !== value.epoch) { throw Error('HARNESS_FENCE_EPOCH_INVALID'); }
		await assertNoUncertainArtifacts(storage);
		assertOwnerExited(value.pid);
		const currentStat = await fs.lstat(file);
		if (!currentStat.isFile() || currentStat.isSymbolicLink() ||
			currentStat.dev !== stat.dev || currentStat.ino !== stat.ino ||
			JSON.stringify(await readJson(file)) !== JSON.stringify(value) ||
			await currentEpoch(storage, projectKey) !== value.epoch) {
			throw Error('HARNESS_FENCE_LOST');
		}
		await fs.unlink(file);
		return { released: true, epoch: value.epoch, owner: value.owner };
	} finally {
		await guard.close();
		if (recorded) {
			const info = await fs.lstat(guardPath).catch(() => undefined);
			if (info?.isFile() && !info.isSymbolicLink() &&
				info.dev === identity.dev && info.ino === identity.ino &&
				await fs.readFile(guardPath, 'utf8') === guardData) {
				await fs.unlink(guardPath);
			}
		}
	}
}
