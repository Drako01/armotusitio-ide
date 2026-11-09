/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireInstallLock, INSTALL_LOCK_MAX_AGE_MS } from '../src/native-install-lock.ts';

test('one holder per folder; release frees it; other folders are independent', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-lock-'));
	try {
		const first = await acquireInstallLock('/p/a', { directory });
		const second = await acquireInstallLock('/p/a', { directory });
		const other = await acquireInstallLock('/p/b', { directory });
		await first?.release();
		const third = await acquireInstallLock('/p/a', { directory });
		assert.deepEqual([!!first, second, !!other, !!third], [true, undefined, true, true]);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a lock left by a dead process or an expired one is taken over, a live fresh one is not', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-lock-'));
	try {
		let clock = 1000, alive = true;
		const options = () => ({ directory, now: () => clock, isAlive: () => alive });
		await acquireInstallLock('/p', options());
		const live = await acquireInstallLock('/p', options());
		alive = false;
		const dead = await acquireInstallLock('/p', options());
		alive = true; clock += INSTALL_LOCK_MAX_AGE_MS + 1;
		const expired = await acquireInstallLock('/p', options());
		await fs.writeFile((await fs.readdir(directory)).map(name => path.join(directory, name))[0], 'not json');
		const corrupt = await acquireInstallLock('/p', options());
		assert.deepEqual([live, !!dead, !!expired, !!corrupt], [undefined, true, true, true]);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
