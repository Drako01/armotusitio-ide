/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Background repairs of a run: `repair_dependencies` returns at once with an id, the agent keeps working, and `repair_status` reports
 * the state and the final result. Same shape as the job table (`native-jobs.ts`): capped, stoppable, never left running when the run ends.
 */
import type { RepairStepResult } from './native-dependency-repair.ts';

export const MAX_RUNNING_REPAIRS = 2;
export type RepairState = 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface RepairSnapshot { id: string; project: string; state: RepairState; runningSec: number; text: string }
interface Repair { id: string; project: string; startedAt: number; endedAt?: number; abort: AbortController; finished: Promise<void>; result?: RepairStepResult }

export class RepairTable {
	private readonly repairs = new Map<string, Repair>();
	private counter = 0;

	/** Starts the work without waiting for it; `limit` when too many repairs are running. */
	start(project: string, work: (signal: AbortSignal) => Promise<RepairStepResult>): string | 'limit' {
		if ([...this.repairs.values()].filter(repair => !repair.result).length >= MAX_RUNNING_REPAIRS) { return 'limit'; }
		const abort = new AbortController();
		const repair: Repair = { id: 'repair-' + ++this.counter, project, startedAt: Date.now(), abort, finished: Promise.resolve() };
		repair.finished = work(abort.signal).then(
			result => { repair.result = result; },
			error => { repair.result = { isError: true, text: 'FAILED ' + project + ': the repair stopped unexpectedly (' + (error as Error).message + ').' }; }
		).then(() => { repair.endedAt = Date.now(); });
		this.repairs.set(repair.id, repair);
		return repair.id;
	}

	status(id: string): RepairSnapshot | undefined {
		const repair = this.repairs.get(id);
		if (!repair) { return undefined; }
		const state: RepairState = !repair.result ? 'running' : repair.abort.signal.aborted ? 'cancelled' : repair.result.isError ? 'failed' : 'succeeded';
		return { id, project: repair.project, state, runningSec: Math.round(((repair.endedAt ?? Date.now()) - repair.startedAt) / 1000), text: repair.result?.text ?? '' };
	}

	list(): RepairSnapshot[] { return [...this.repairs.keys()].map(id => this.status(id)!); }

	/** Resolves when the repair has ended. */
	async wait(id: string): Promise<RepairSnapshot | undefined> {
		await this.repairs.get(id)?.finished;
		return this.status(id);
	}

	/** Asks a running repair to stop (its current install is stopped by the caller's signal handler) and waits until it has. */
	async stop(id: string): Promise<RepairSnapshot | undefined> {
		const repair = this.repairs.get(id);
		if (!repair) { return undefined; }
		if (!repair.result) { repair.abort.abort(); }
		return await this.wait(id);
	}

	/** The run ended: nothing keeps running. */
	async stopAll(): Promise<void> { await Promise.all([...this.repairs.keys()].map(id => this.stop(id))); }
}
