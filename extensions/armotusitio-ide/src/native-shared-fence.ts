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
