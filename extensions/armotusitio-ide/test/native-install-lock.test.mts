/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireInstallLock } from '../src/native-install-lock.ts';

const CHILD = path.join(import.meta.dirname, 'native-install-lock-child.mts');
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function withDirectory(work: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-lock-'));
	try { await work(directory); } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
const lockFile = async (directory: string): Promise<string> => path.join(directory, (await fs.readdir(directory)).find(name => name.endsWith('.lock'))!);

/** Starts a real process that holds the lock; resolves once it said so. */
function holder(folder: string, directory: string, heartbeatMs: number, staleMs: number): Promise<{ child: ChildProcessWithoutNullStreams; first: string; done: Promise<number | null> }> {
	const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CHILD, folder, directory, String(heartbeatMs), String(staleMs)]);
	const done = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
	return new Promise((resolve, reject) => {
		child.stdout.once('data', data => resolve({ child, first: String(data).trim(), done }));
		child.once('error', reject);
	});
}

test('one holder per folder; release frees it; other folders are independent', async () => {
	await withDirectory(async directory => {
		const first = await acquireInstallLock('/p/a', { directory });
		const second = await acquireInstallLock('/p/a', { directory });
		const other = await acquireInstallLock('/p/b', { directory });
		await first?.release();
		await first?.release();
		const third = await acquireInstallLock('/p/a', { directory });
		await Promise.all([other?.release(), third?.release()]);
		assert.deepEqual([!!first, second, !!other, !!third, first?.owner !== third?.owner], [true, undefined, true, true, true]);
	});
});

test('only the owner removes a lock: a lock taken over is never released or refreshed by its former holder', async () => {
	await withDirectory(async directory => {
		const slow = await acquireInstallLock('/p', { directory, isAlive: () => true, staleMs: 50, heartbeatMs: 1_000_000 });
		await wait(120);
		const next = await acquireInstallLock('/p', { directory, isAlive: () => true, staleMs: 50, heartbeatMs: 1_000_000 });
		const before = [await slow?.held(), await next?.held()];
		await slow?.release();
		const afterOld = await next?.held();
		await next?.release();
		assert.deepEqual([before, afterOld, (await fs.readdir(directory)).length], [[false, true], true, 0]);
	});
});

test('a dead owner, a corrupt file and a silent owner with a reused pid are all recovered; a live fresh owner is not', async () => {
	await withDirectory(async directory => {
		const options = (isAlive: boolean) => ({ directory, isAlive: () => isAlive, staleMs: 400, heartbeatMs: 1_000_000 });
		await acquireInstallLock('/p', options(true));
		const live = await acquireInstallLock('/p', options(true));
		const dead = await acquireInstallLock('/p', options(false));
		await fs.writeFile(await lockFile(directory), 'not json');
		const corrupt = await acquireInstallLock('/p', options(true));
		await wait(450);
		const silent = await acquireInstallLock('/p', options(true));
		assert.deepEqual([live, !!dead, !!corrupt, !!silent], [undefined, true, true, true]);
	});
});

test('the heartbeat keeps a long operation valid far past the stale window', async () => {
	await withDirectory(async directory => {
		const long = await acquireInstallLock('/p', { directory, heartbeatMs: 50, staleMs: 400 });
		await wait(1000);
		const rival = await acquireInstallLock('/p', { directory, staleMs: 400 });
		const stillHeld = await long?.held();
		await long?.release();
		assert.deepEqual([rival, stillHeld, !!await acquireInstallLock('/p', { directory })], [undefined, true, true]);
	});
});

test('between real processes: the second is refused, a killed holder is recovered, and a clean exit releases', async () => {
	await withDirectory(async directory => {
		const a = await holder('/p', directory, 50, 400);
		const b = await holder('/p', directory, 50, 400);
		await wait(900);
		const stillRefused = await holder('/p', directory, 50, 400);
		a.child.kill('SIGKILL');
		await a.done;
		const recovered = await holder('/p', directory, 50, 400);
		recovered.child.stdin.end();
		const exit = await recovered.done;
		const afterExit = await holder('/p', directory, 50, 400);
		afterExit.child.stdin.end();
		await afterExit.done;
		assert.deepEqual([a.first, b.first, stillRefused.first, recovered.first, exit, afterExit.first], ['held', 'refused', 'refused', 'held', 0, 'held']);
	});
});

test('twenty contenders racing for one stale lock produce exactly one owner', async () => {
	await withDirectory(async directory => {
		await acquireInstallLock('/p', { directory, isAlive: () => false });
		const winners = (await Promise.all(Array.from({ length: 20 }, () => acquireInstallLock('/p', { directory, isAlive: () => false, heartbeatMs: 1_000_000 })))).filter(lock => lock);
		const held = await Promise.all(winners.map(lock => lock!.held()));
		await Promise.all(winners.map(lock => lock!.release()));
		assert.deepEqual([held.filter(Boolean).length], [1]);
	});
});
