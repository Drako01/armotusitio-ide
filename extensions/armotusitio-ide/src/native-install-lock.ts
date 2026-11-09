/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Cross-process exclusion for operations that rewrite one dependency folder (a repair or an install): two IDE windows or two agents
 * must never delete and reinstall the same `node_modules` at once. One lock file per folder in the OS temp directory, created
 * exclusively (`wx`); a lock whose owner process is gone, or that is older than any install may last, is stale and taken over.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Longer than the longest install (`REPAIR_INSTALL_TIMEOUT_SEC` twice, plus the deletion), so an old lock is certainly abandoned. */
export const INSTALL_LOCK_MAX_AGE_MS = 40 * 60 * 1000;

export interface InstallLock { release(): Promise<void> }
export interface InstallLockOptions { directory?: string; now?: () => number; isAlive?: (pid: number) => boolean }

const processAlive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** The lock of `folder`, or `undefined` when another live process holds it. */
export async function acquireInstallLock(folder: string, options: InstallLockOptions = {}): Promise<InstallLock | undefined> {
	const now = options.now ?? Date.now, isAlive = options.isAlive ?? processAlive;
	const key = crypto.createHash('sha256').update(process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder)).digest('hex').slice(0, 24);
	const file = path.join(options.directory ?? os.tmpdir(), 'ats-install-' + key + '.lock');
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(file, 'wx');
			await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
			await handle.close();
			return { release: () => fs.rm(file, { force: true }) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
			const owner = await fs.readFile(file, 'utf8').then(text => JSON.parse(text) as { pid?: unknown; at?: unknown }).catch(() => undefined);
			const stale = !owner || typeof owner.pid !== 'number' || typeof owner.at !== 'number' || now() - owner.at > INSTALL_LOCK_MAX_AGE_MS || !isAlive(owner.pid);
			if (!stale) { return undefined; }
			await fs.rm(file, { force: true });
		}
	}
	return undefined;
}
