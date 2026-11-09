/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Cross-process exclusion for operations that rewrite one dependency folder (a repair or an install): two IDE windows or two agents
 * must never delete and reinstall the same `node_modules` at once.
 *
 * One lock file per folder in the OS temp directory, created exclusively (`wx`) and holding a unique owner id. A live owner keeps it
 * fresh with a heartbeat (the file's modification time), so an operation may last as long as it needs; the lock is only abandoned when
 * its process is gone or when the heartbeat stopped (a hung or killed process, a reused pid, a corrupt file). Taking over is serialised by a
 * short-lived mutex file and re-checks staleness inside it, so a lock created meanwhile is never removed. Release and
 * heartbeat check the owner id first, so a process whose lock was taken never removes or refreshes the new owner's lock.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const HEARTBEAT_MS = 10_000;
const TAKEOVER_STALE_MS = 5_000;
const MAX_ATTEMPTS = 40;
/** No heartbeat for this long means the owner is hung or gone, even if its pid is alive (or was reused by an unrelated process). */
export const HEARTBEAT_STALE_MS = 60_000;

export interface InstallLock {
	readonly owner: string;
	/** False once the lock was taken over or removed by someone else (for example after a long suspension). */
	held(): Promise<boolean>;
	/** Removes the lock only while this process still owns it; idempotent. */
	release(): Promise<void>;
}
export interface InstallLockOptions {
	directory?: string;
	now?: () => number;
	isAlive?: (pid: number) => boolean;
	heartbeatMs?: number;
	staleMs?: number;
}
interface LockRecord { owner: string; pid: number }

const processAlive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};
const readRecord = (file: string): Promise<LockRecord | undefined> => fs.readFile(file, 'utf8').then(text => {
	const value = JSON.parse(text) as Partial<LockRecord>;
	return typeof value.owner === 'string' && typeof value.pid === 'number' ? { owner: value.owner, pid: value.pid } : undefined;
}).catch(() => undefined);

/** The lock of `folder`, or `undefined` when another live, recently-seen process holds it. */
export async function acquireInstallLock(folder: string, options: InstallLockOptions = {}): Promise<InstallLock | undefined> {
	const now = options.now ?? Date.now, isAlive = options.isAlive ?? processAlive, staleMs = options.staleMs ?? HEARTBEAT_STALE_MS;
	const key = crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder)).digest('hex').slice(0, 24);
	const file = path.join(options.directory ?? os.tmpdir(), 'ats-install-' + key + '.lock');
	const owner = crypto.randomUUID();
	const create = async (): Promise<boolean> => {
		try {
			const handle = await fs.open(file, 'wx');
			try { await handle.writeFile(JSON.stringify({ owner, pid: process.pid } satisfies LockRecord)); } finally { await handle.close(); }
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') { return false; }
			throw error;
		}
	};
	const isStale = async (): Promise<boolean> => {
		const [record, stat] = await Promise.all([readRecord(file), fs.stat(file).catch(() => undefined)]);
		return !stat ? false : !record || !isAlive(record.pid) || now() - stat.mtimeMs > staleMs;
	};
	/**
	 * Removes a stale lock. Only the holder of a short-lived takeover mutex may do it, and it checks staleness again inside the mutex, so
	 * a lock created by someone else after the first check is never removed. Returns false when another contender holds the mutex.
	 */
	const takeOver = async (): Promise<boolean> => {
		const mutex = file + '.takeover';
		const held = await fs.open(mutex, 'wx').then(handle => handle.close(), async (error: NodeJS.ErrnoException) => {
			// A takeover that died leaves its mutex behind; one older than any takeover can last is removed.
			if (error.code === 'EEXIST' && Date.now() - ((await fs.stat(mutex).catch(() => undefined))?.mtimeMs ?? Date.now()) > TAKEOVER_STALE_MS) { await fs.rm(mutex, { force: true }); }
			return 'busy' as const;
		});
		if (held === 'busy') { return false; }
		try { if (await isStale()) { await fs.rm(file, { force: true }); } } finally { await fs.rm(mutex, { force: true }); }
		return true;
	};

	for (let attempt = 0; ; attempt++) {
		if (await create()) { break; }
		if (attempt >= MAX_ATTEMPTS || !await isStale()) { return undefined; }
		if (!await takeOver()) { await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 20)); }
	}

	const owned = async (): Promise<boolean> => (await readRecord(file))?.owner === owner;
	let released = false;
	const timer = setInterval(() => { void owned().then(mine => mine ? fs.utimes(file, new Date(now()), new Date(now())) : undefined).catch(() => undefined); }, options.heartbeatMs ?? HEARTBEAT_MS);
	timer.unref();
	return {
		owner,
		held: owned,
		release: async () => {
			if (released) { return; }
			released = true;
			clearInterval(timer);
			if (await owned()) { await fs.rm(file, { force: true }); }
		}
	};
}
