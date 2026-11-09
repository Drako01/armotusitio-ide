/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Background jobs of a run: started under the command policy, observable, stoppable, and never left running. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleJob, handleRun, runAsJob, type RunnerConfig } from '../src/ats-runner.ts';
import { runCommand } from '../src/native-command-runner.ts';
import { JobTable, MAX_RUNNING_JOBS } from '../src/native-jobs.ts';
import type { PermissionSet } from '../src/native-permissions.ts';
import type { PermissionDecision } from '../src/native-permissions-types.ts';

const permissionsOf = (decision: PermissionDecision): PermissionSet => ({ preset: 'dev', warnings: [], describe: () => [], decide: () => ({ decision, source: 'user' }) });
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 8000): Promise<void> => { const end = Date.now() + ms; while (!condition() && Date.now() < end) { await wait(50); } };

async function withProject(work: (input: { root: string; logs: string; config: RunnerConfig }) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-jobs-')));
	const logs = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-jobs-logs-'));
	try {
		await fs.writeFile(path.join(root, 'server.cjs'), 'console.log("listening token=sk-secret-value-1234567890"); setInterval(() => console.log("tick"), 100);');
		await fs.writeFile(path.join(root, 'quick.cjs'), 'console.log("done"); process.exitCode = 3;');
		await work({ root, logs, config: { schemaVersion: 1, root, env: { ...process.env }, logDirectory: logs, policy: { subprojects: [], delegate: false, extras: ['node'] }, permissions: {}, jobs: true } });
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await fs.rm(logs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test('a job runs in the background, shows its redacted live output, and stop ends the whole process', async () => {
	await withProject(async ({ root, logs }) => {
		const jobs = new JobTable();
		const id = jobs.start({ root, cwd: '.', command: 'node', args: ['server.cjs'], env: process.env, logDirectory: logs });
		assert.equal(id, 'job-1');
		await until(() => (jobs.status('job-1')?.output.includes('tick') ?? false));
		const running = jobs.status('job-1')!;
		const stopped = await jobs.stop('job-1');
		const again = await jobs.stop('job-1');
		assert.deepEqual({
			state: running.state, output: running.output.includes('listening') && running.output.includes('tick'), leaked: running.output.includes('sk-secret'),
			stopped: stopped?.state, same: again?.state, unknown: jobs.status('job-9'), none: await jobs.stop('job-9')
		}, { state: 'running', output: true, leaked: false, stopped: 'stopped', same: 'stopped', unknown: undefined, none: undefined });
	});
});

test('a job that ends by itself keeps its exit code, and no more than the allowed number run at once', async () => {
	await withProject(async ({ root, logs }) => {
		const jobs = new JobTable();
		jobs.start({ root, cwd: '.', command: 'node', args: ['quick.cjs'], env: process.env, logDirectory: logs });
		await until(() => jobs.status('job-1')?.state === 'exited');
		const finished = jobs.status('job-1')!;
		const ids = Array.from({ length: MAX_RUNNING_JOBS + 1 }, () => jobs.start({ root, cwd: '.', command: 'node', args: ['server.cjs'], env: process.env, logDirectory: logs }));
		await jobs.stopAll();
		assert.deepEqual({ finished: [finished.state, finished.exitCode, finished.output.includes('done')], ids, after: jobs.list().filter(job => job.state === 'running').length },
			{ finished: ['exited', 3, true], ids: ['job-2', 'job-3', 'job-4', 'job-5', 'limit'], after: 0 });
	});
});

test('job_start applies the command policy and approvals of run, then job_status and job_stop manage it', async () => {
	await withProject(async ({ config }) => {
		const jobs = new JobTable();
		const denied = await handleRun(config, { command: 'bash', args: ['-c', 'sleep 100 &'] }, 1, { permissions: permissionsOf('allow'), jobs }, 'job');
		const noUi = await handleRun(config, { command: 'node', args: ['server.cjs'] }, 2, { permissions: permissionsOf('ask'), jobs }, 'job');
		const started = await handleRun(config, { command: 'node', args: ['server.cjs'] }, 3, { permissions: permissionsOf('allow'), jobs }, 'job');
		await until(() => (jobs.status('job-1')?.output.includes('tick') ?? false));
		const status = await handleJob('job_status', { id: 'job-1' }, { jobs });
		const listing = await handleJob('job_status', {}, { jobs });
		const stopped = await handleJob('job_stop', { id: 'job-1' }, { jobs });
		const missing = await handleJob('job_stop', { id: 'job-7' }, { jobs });
		const invalid = await handleJob('job_stop', {}, { jobs });
		const badType = await handleJob('job_status', { id: 5 }, { jobs });
		assert.deepEqual({
			denied: denied.text.startsWith('POLICY_DENIED'), noUi: noUi.isError, started: started.text.startsWith('started job-1'), count: jobs.list().length,
			status: status.text.startsWith('job-1 running') && status.text.includes('$ node server.cjs'), listing: listing.text.includes('job-1 running'),
			stopped: stopped.text.startsWith('job-1 stopped'), missing: [missing.isError, missing.text], invalid: invalid.isError, badType: badType.isError
		}, {
			denied: true, noUi: true, started: true, count: 1, status: true, listing: true, stopped: true, missing: [true, 'No background job job-7.'], invalid: true, badType: true
		});
	});
});

test('stopping a command right after it was requested still stops it, even before its process exists', async () => {
	await withProject(async ({ root, logs }) => {
		const abort = new AbortController();
		const started = Date.now();
		const pending = runCommand({ root, cwd: '.', command: 'node', args: ['server.cjs'], env: process.env, logDirectory: logs, signal: abort.signal });
		abort.abort();
		const result = await pending;
		assert.deepEqual({ cancelled: result.cancelled, quick: Date.now() - started < 15000 }, { cancelled: true, quick: true });
	});
});

test('a long install runs as a job whose exit code decides the result, with a timeout and no leftover process', async () => {
	await withProject(async ({ root, config }) => {
		await fs.writeFile(path.join(root, 'ok.cjs'), 'console.log("installed");');
		const jobs = new JobTable();
		const run = (script: string, timeoutSec = 30) => runAsJob(config, { command: 'node', args: [script], cwd: '.', timeoutSec }, 1, { jobs });
		const ok = await run('ok.cjs'), failed = await run('quick.cjs'), timedOut = await run('server.cjs', 1);
		assert.deepEqual({
			ok: [ok.isError, /exited \(exit 0\)/.test(ok.text), ok.text.includes('installed')],
			failed: [failed.isError, /exit 3/.test(failed.text)],
			timedOut: [timedOut.isError, /^timed out after 1 s/.test(timedOut.text)],
			running: jobs.list().filter(job => job.state === 'running').length
		}, { ok: [false, true, true], failed: [true, true], timedOut: [true, true], running: 0 });
	});
});
