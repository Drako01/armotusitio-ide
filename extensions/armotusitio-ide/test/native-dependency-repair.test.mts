/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { repairDependencies, type RepairDeps, type RepairStepResult } from '../src/native-dependency-repair.ts';
import { classifyFailure } from '../src/native-failure-class.ts';
import { acquireInstallLock } from '../src/native-install-lock.ts';
import { handleRepair, handleRepairStatus, type RunnerConfig } from '../src/ats-runner.ts';
import { RepairTable } from '../src/native-repair-table.ts';

const OK: RepairStepResult = { isError: false, text: 'done' };
const fail = (text: string): RepairStepResult => ({ isError: true, text });

interface Harness { root: string; calls: string[]; deps: RepairDeps; installPackage(): Promise<void>; corrupt(): Promise<void> }

/** A one-dependency pnpm project in a temp folder; `run` and `remove` are scripted by each test and recorded in `calls`. */
async function withProject(script: { run?: (n: number, h: Harness) => Promise<RepairStepResult>; remove?: RepairStepResult; lockfile?: boolean }, work: (h: Harness) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-repair-')));
	try {
		await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { left: '1.0.0' }, devDependencies: { right: '1.0.0' } }));
		const calls: string[] = [];
		let runs = 0;
		const harness: Harness = {
			root, calls,
			installPackage: async () => { for (const name of ['left', 'right']) { await fs.mkdir(path.join(root, 'node_modules', name), { recursive: true }); await fs.writeFile(path.join(root, 'node_modules', name, 'package.json'), '{}'); } },
			corrupt: async () => { await fs.mkdir(path.join(root, 'node_modules', 'left'), { recursive: true }); await fs.writeFile(path.join(root, 'node_modules', 'left', 'package.json'), '{broken'); },
			deps: {
				root, subprojects: [{ path: '.', ecosystem: 'node', packageManager: 'pnpm' }],
				installCommands: async () => script.lockfile === false ? [] : [{ command: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'], cwd: '.', cacheOnly: false }],
				run: async (command, args) => { calls.push('run ' + command + ' ' + args[0]); return script.run ? await script.run(++runs, harness) : OK; },
				remove: async relative => { calls.push('remove ' + relative); await fs.rm(path.join(root, relative), { recursive: true, force: true }); return script.remove ?? OK; },
				sleep: async ms => { calls.push('sleep ' + ms); }
			}
		};
		await work(harness);
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('a healthy install is left alone, and diagnose mode never runs anything', async () => {
	await withProject({}, async h => {
		await h.installPackage();
		const healthy = await repairDependencies(h.deps, {});
		await fs.rm(path.join(h.root, 'node_modules', 'right'), { recursive: true });
		const diagnosis = await repairDependencies(h.deps, { mode: 'diagnose' });
		assert.deepEqual({ healthy: healthy.text.split(':')[0], diagnosis: diagnosis.text, calls: h.calls }, { healthy: 'HEALTHY .', diagnosis: 'DIAGNOSIS . (pnpm): missing: right.', calls: [] });
	});
});

test('missing packages are repaired by a reinstall in place, without deleting anything', async () => {
	await withProject({ run: async (_n, h) => { await h.installPackage(); return OK; } }, async h => {
		const result = await repairDependencies(h.deps, {});
		assert.deepEqual({ outcome: result.text.split(' ')[0], error: result.isError, calls: h.calls }, { outcome: 'REPAIRED', error: false, calls: ['run pnpm install'] });
	});
});

test('a corrupt tree that the in-place install cannot fix is deleted once and installed again', async () => {
	await withProject({ run: async (n, h) => n === 1 ? (await h.corrupt(), fail('UNKNOWN: unknown error, open ms/package.json')) : (await h.installPackage(), OK) }, async h => {
		await h.corrupt();
		const result = await repairDependencies(h.deps, {});
		assert.deepEqual({ outcome: result.text.split(' ')[0], calls: h.calls, attempts: /reinstall in place failed; delete node_modules done; clean install ran/.test(result.text) }, { outcome: 'REPAIRED', calls: ['run pnpm install', 'remove node_modules', 'run pnpm install'], attempts: true });
	});
});

test('when the clean install fails too it reports the cause, the attempts and the next step, and stops after two installs', async () => {
	await withProject({ run: async () => fail('EBUSY: resource busy or locked, open C:\\x\\pkg.json') }, async h => {
		const result = await repairDependencies(h.deps, {});
		assert.deepEqual({ outcome: result.text.split(' ')[0], error: result.isError, calls: h.calls, kind: /\[locked-files, change-strategy\]/.test(result.text), next: /antivirus/.test(result.text) },
			{ outcome: 'FAILED', error: true, calls: ['run pnpm install', 'remove node_modules', 'run pnpm install'], kind: true, next: true });
	});
});

test('a policy refusal or a full disk never leads to deleting the folder', async () => {
	for (const text of ['POLICY_DENIED: not-allowed', 'ENOSPC: no space left on device']) {
		await withProject({ run: async () => fail(text) }, async h => {
			const result = await repairDependencies(h.deps, {});
			assert.deepEqual([result.text.split(' ')[0], h.calls], ['FAILED', ['run pnpm install']]);
		});
	}
});

test('a refused deletion is reported, not worked around', async () => {
	await withProject({ run: async () => fail('EPERM: operation not permitted'), remove: fail('POLICY_DENIED: protected-path') }, async h => {
		const result = await repairDependencies(h.deps, {});
		assert.deepEqual({ outcome: result.text.split(' ')[0], kind: /\[policy, security-blocked\]/.test(result.text), calls: h.calls }, { outcome: 'FAILED', kind: true, calls: ['run pnpm install', 'remove node_modules'] });
	});
});

test('only network failures are retried as they are, with backoff', async () => {
	await withProject({ run: async (n, h) => n < 3 ? fail('ETIMEDOUT: registry') : (await h.installPackage(), OK) }, async h => {
		const result = await repairDependencies(h.deps, {});
		assert.deepEqual({ outcome: result.text.split(' ')[0], calls: h.calls }, { outcome: 'REPAIRED', calls: ['run pnpm install', 'sleep 1000', 'run pnpm install', 'sleep 4000', 'run pnpm install'] });
	});
});

test('without a lockfile or a Node project the repair is blocked with a reason', async () => {
	await withProject({ lockfile: false }, async h => {
		const noLock = await repairDependencies(h.deps, {});
		const unknown = await repairDependencies(h.deps, { path: 'apps/none' });
		const invalid = await repairDependencies(h.deps, { mode: 'wipe' });
		assert.deepEqual({ noLock: noLock.text.split(':')[0], unknown: unknown.text.split(':')[0], invalid: invalid.text.slice(0, 14), calls: h.calls }, { noLock: 'BLOCKED no-lockfile', unknown: 'BLOCKED no-project', invalid: 'Invalid input:', calls: [] });
	});
});

test('failures are classified so only transient ones are retried automatically', () => {
	const table = ['POLICY_DENIED: x', 'ENOSPC', 'ERR_PNPM_OUTDATED_LOCKFILE', 'EBUSY', 'spawn pnpm ENOENT', 'ECONNRESET', 'timed out after 60 s', 'something odd'];
	assert.deepEqual(table.map(text => classifyFailure(text).class), ['security-blocked', 'unrecoverable', 'needs-approval', 'change-strategy', 'change-strategy', 'auto-recoverable', 'change-strategy', 'unrecoverable']);
});

test('the runner tool detects the project itself and is unavailable unless the file tools are on', async () => {
	await withProject({}, async h => {
		await fs.writeFile(path.join(h.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
		const base: RunnerConfig = { schemaVersion: 1, root: h.root, env: {}, logDirectory: h.root, policy: { subprojects: [], delegate: false, extras: [] }, permissions: {} };
		const withFiles = await handleRepair({ ...base, files: true }, { mode: 'diagnose' }, 0);
		const without = await handleRepair(base, { mode: 'diagnose' }, 0);
		assert.deepEqual([withFiles.text, without.text], ['DIAGNOSIS . (pnpm): node_modules is missing.', 'Unknown tool']);
	});
});

test('a repair starts in the background, is read with repair_status, frees the folder at its end, and is refused while another process holds it', async () => {
	await withProject({}, async h => {
		await fs.writeFile(path.join(h.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
		const base: RunnerConfig = { schemaVersion: 1, root: h.root, env: {}, logDirectory: h.root, policy: { subprojects: [], delegate: false, extras: [] }, permissions: {}, files: true };
		const repairs = new RepairTable();
		const held = await acquireInstallLock(h.root);
		const blocked = await handleRepair(base, {}, 0, { repairs });
		const diagnosed = await handleRepair(base, { mode: 'diagnose' }, 0, { repairs });
		await held?.release();
		const started = await handleRepair(base, {}, 0, { repairs });
		const id = /STARTED (repair-\d+)/.exec(started.text)?.[1] ?? '';
		const finished = await repairs.wait(id);
		const status = await handleRepairStatus({ id }, { repairs });
		const again = await acquireInstallLock(h.root);
		await again?.release();
		assert.deepEqual({ blocked: blocked.text.split(':')[0], diagnosed: diagnosed.text.slice(0, 9), started: started.isError, tellsNotToClaim: /Do not report/.test(started.text), final: finished?.state, status: status.text.startsWith(id + ' . FAILED'), freed: !!again, unknown: (await handleRepairStatus({ id: 'repair-99' }, { repairs })).text, invalid: (await handleRepairStatus({ id: 3 }, { repairs })).isError },
			{ blocked: 'BLOCKED install-in-progress', diagnosed: 'DIAGNOSIS', started: false, tellsNotToClaim: true, final: 'failed', status: true, freed: true, unknown: 'No repair repair-99.', invalid: true });
	});
});

test('the repair table caps running repairs, reports success, and stop cancels the work and its next step', async () => {
	const table = new RepairTable();
	const open: Array<(result: RepairStepResult) => void> = [];
	const blocked = (signal: AbortSignal) => new Promise<RepairStepResult>(resolve => { open.push(resolve); signal.addEventListener('abort', () => resolve({ isError: true, text: 'CANCELLED x' })); });
	const first = table.start('a', blocked), second = table.start('b', blocked), third = table.start('c', blocked);
	const running = table.list().map(repair => repair.state);
	open[0]({ isError: false, text: 'REPAIRED a' });
	const done = await table.wait(first as string);
	const stopped = await table.stop(second as string);
	const gone = await table.stop('repair-99');
	assert.deepEqual({ third, running, done: [done?.state, done?.text], stopped: stopped?.state, gone }, { third: 'limit', running: ['running', 'running'], done: ['succeeded', 'REPAIRED a'], stopped: 'cancelled', gone: undefined });
});

test('other ecosystems are repaired by their lockfile install, judged by the exit code, and never by deleting anything', async () => {
	await withProject({ run: async n => n === 1 ? fail('ETIMEDOUT: proxy') : OK }, async h => {
		const deps = { ...h.deps, subprojects: [{ path: 'svc', ecosystem: 'go' as const }], installCommands: async () => [{ command: 'go', args: ['mod', 'download'], cwd: 'svc', cacheOnly: true }] };
		const diagnosis = await repairDependencies(deps, { path: 'svc', mode: 'diagnose' });
		const repaired = await repairDependencies(deps, { path: 'svc' });
		const broken = await repairDependencies({ ...deps, run: async () => fail('EBUSY') }, { path: 'svc' });
		assert.deepEqual({ diagnosis: diagnosis.text.slice(0, 22), repaired: repaired.text.slice(0, 17), brokenFailed: broken.text.startsWith('FAILED'), removed: h.calls.some(call => call.startsWith('remove')) },
			{ diagnosis: 'DIAGNOSIS svc (go): no', repaired: 'REPAIRED svc (go ', brokenFailed: true, removed: false });
	});
});

test('a damaged package.json is reported instead of being treated as "nothing declared"', async () => {
	await withProject({}, async h => {
		await h.installPackage();
		await fs.writeFile(path.join(h.root, 'package.json'), '{broken');
		const damaged = await repairDependencies(h.deps, { mode: 'diagnose' });
		await fs.rm(path.join(h.root, 'package.json'));
		const absent = await repairDependencies(h.deps, { mode: 'diagnose' });
		assert.deepEqual([damaged.text, absent.text], ['DIAGNOSIS . (pnpm): unreadable: package.json.', 'DIAGNOSIS . (pnpm): every declared package is installed and readable.']);
	});
});
