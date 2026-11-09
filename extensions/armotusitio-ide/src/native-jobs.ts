/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Background jobs for one agent run (dev servers, watchers): started through the same `runCommand` as any command, so the policy,
 * redaction and process-tree stop are identical, and owned by the run: they never outlive the runner process that started them.
 */
import { runCommand, type CommandRequest, type CommandResult } from './native-command-runner.ts';
import { redactSecrets } from './native-redact.ts';

export const MAX_RUNNING_JOBS = 4;
/** What `job_status` shows of a job's output; the full log stays in the run folder. */
const JOB_TAIL_CHARS = 8 * 1024;

export type JobState = 'running' | 'exited' | 'stopped' | 'timed-out' | 'failed';
export interface JobSnapshot {
	id: string;
	command: string;
	state: JobState;
	exitCode: number | null;
	runningSec: number;
	output: string;
}
interface Job {
	id: string;
	command: string;
	startedAt: number;
	abort: AbortController;
	tail: string;
	finished: Promise<void>;
	result?: CommandResult;
	failed?: boolean;
	stopRequested: boolean;
}

export class JobTable {
	private readonly jobs = new Map<string, Job>();
	private counter = 0;

	/** Starts the command without waiting for it; `limit` when too many are running. */
	start(request: Omit<CommandRequest, 'signal' | 'observe'>): string | 'limit' {
		if ([...this.jobs.values()].filter(job => !job.result && !job.failed).length >= MAX_RUNNING_JOBS) { return 'limit'; }
		const abort = new AbortController();
		const job: Job = { id: 'job-' + ++this.counter, command: [request.command, ...request.args].join(' ').slice(0, 200), startedAt: Date.now(), abort, tail: '', stopRequested: false, finished: Promise.resolve() };
		job.finished = runCommand({ ...request, signal: abort.signal, observe: text => { job.tail = (job.tail + text).slice(-JOB_TAIL_CHARS); } })
			.then(result => { job.result = result; }, () => { job.failed = true; });
		this.jobs.set(job.id, job);
		return job.id;
	}

	status(id: string): JobSnapshot | undefined {
		const job = this.jobs.get(id);
		if (!job) { return undefined; }
		const state: JobState = job.failed ? 'failed' : !job.result ? 'running' : job.result.timedOut ? 'timed-out' : job.stopRequested || job.result.cancelled ? 'stopped' : 'exited';
		return { id, command: job.command, state, exitCode: job.result?.exitCode ?? null, runningSec: Math.round(((job.result ? job.startedAt + job.result.durationMs : Date.now()) - job.startedAt) / 1000), output: redactSecrets(job.tail) };
	}

	list(): JobSnapshot[] { return [...this.jobs.keys()].map(id => this.status(id)!); }

	/** Asks a running job to stop and waits until its process tree is gone. */
	async stop(id: string): Promise<JobSnapshot | undefined> {
		const job = this.jobs.get(id);
		if (!job) { return undefined; }
		if (!job.result && !job.failed) { job.stopRequested = true; job.abort.abort(); }
		await job.finished;
		return this.status(id);
	}

	/** The run ended: nothing keeps running. */
	async stopAll(): Promise<void> { await Promise.all([...this.jobs.keys()].map(id => this.stop(id))); }
}
