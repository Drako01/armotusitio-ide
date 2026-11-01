/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Durable goal journal (block N): append-only JSON lines in the IDE's storage, replayed to resume after a crash. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GoalCharter } from './native-goal.ts';
import type { RunOutcome } from './native-run-outcome.ts';

export const JOURNAL_SCHEMA = 1;
export type GoalStatus = 'queued' | 'running' | 'paused' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface GoalStep {
	index: number;
	title: string;
	/** Agent role that ran the step (block P). */
	role?: string;
	status: 'running' | 'done' | 'rejected' | 'failed';
	outcome?: RunOutcome;
	/** Metric measured by the IDE after the step (block M), never the agent's own claim. */
	metric?: number;
	/** Why a step was rejected (a guard or the charter validator). */
	rejection?: string[];
	startedAt: string;
	endedAt?: string;
}
export type JournalEntry =
	| { type: 'charter'; at: string; charter: GoalCharter; baseline?: number; baseCommit?: string }
	| { type: 'step-start'; at: string; index: number; title: string; role?: string }
	| { type: 'step-end'; at: string; index: number; status: GoalStep['status']; outcome?: RunOutcome; metric?: number; rejection?: string[] }
	| { type: 'question'; at: string; id: string; text: string }
	| { type: 'answer'; at: string; id: string; text: string }
	| { type: 'state'; at: string; status: GoalStatus; reason?: string };
export interface GoalState {
	goalId: string;
	status: GoalStatus;
	reason?: string;
	charter: GoalCharter;
	baseline?: number;
	baseCommit?: string;
	steps: GoalStep[];
	questions: Array<{ id: string; text: string; answer?: string }>;
	updatedAt: string;
}
export interface GoalJournal {
	append(entry: JournalEntry): Promise<void>;
	load(goalId: string): Promise<GoalState>;
}

const MAX_LINE_BYTES = 256 * 1024;
const GOAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RETRIES = 5;

/** Fold entries into the goal state; an entry that does not fit the sequence is ignored, never trusted. */
export function replayJournal(goalId: string, entries: readonly JournalEntry[]): GoalState {
	const charter = entries.find((entry): entry is Extract<JournalEntry, { type: 'charter' }> => entry.type === 'charter');
	if (!charter) { throw Error('HARNESS_RESUME_STATE_INVALID'); }
	const state: GoalState = { goalId, status: 'queued', charter: charter.charter, baseline: charter.baseline, baseCommit: charter.baseCommit, steps: [], questions: [], updatedAt: charter.at };
	for (const entry of entries) {
		state.updatedAt = entry.at;
		if (entry.type === 'step-start') { state.steps.push({ index: entry.index, title: entry.title, role: entry.role, status: 'running', startedAt: entry.at }); }
		if (entry.type === 'step-end') {
			const step = state.steps.find(item => item.index === entry.index && item.status === 'running');
			if (step) { Object.assign(step, { status: entry.status, outcome: entry.outcome, metric: entry.metric, rejection: entry.rejection, endedAt: entry.at }); }
		}
		if (entry.type === 'question') { state.questions.push({ id: entry.id, text: entry.text }); }
		if (entry.type === 'answer') { const question = state.questions.find(item => item.id === entry.id); if (question) { question.answer = entry.text; } }
		if (entry.type === 'state') { state.status = entry.status; state.reason = entry.reason; }
	}
	return state;
}

/** A goal still marked active whose process is gone was interrupted; its running step is kept with its diff for resuming. */
export function interruptedOnLoad(state: GoalState): GoalState {
	return ['running', 'queued'].includes(state.status) ? { ...state, status: 'interrupted', reason: 'ide-closed' } : state;
}

/** Retry transient file locks (`EBUSY`, `EPERM` from antivirus or indexers on Windows) before failing loudly. */
async function retrying<T>(work: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try { return await work(); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= RETRIES || !['EBUSY', 'EPERM', 'EAGAIN'].includes(code ?? '')) { throw error; }
			await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
		}
	}
}

export class FileGoalJournal implements GoalJournal {
	private readonly directory: string;
	private readonly goalId: string;
	constructor(directory: string, goalId: string) {
		if (!GOAL_ID.test(goalId)) { throw Error('HARNESS_RESUME_ID_INVALID'); }
		this.directory = directory; this.goalId = goalId;
	}
	private get file(): string { return path.join(this.directory, this.goalId + '.jsonl'); }
	/** One fsync'ed line per entry: a crash loses at most the line being written, which replay then ignores. */
	async append(entry: JournalEntry): Promise<void> {
		const line = JSON.stringify({ v: JOURNAL_SCHEMA, ...entry }) + '\n';
		if (Buffer.byteLength(line) > MAX_LINE_BYTES) { throw Error('HARNESS_WORKFLOW_STATE_TOO_LARGE'); }
		await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
		await retrying(async () => {
			const handle = await fs.open(this.file, 'a', 0o600);
			try { await handle.appendFile(line); await handle.sync(); }
			finally { await handle.close(); }
		});
	}
	async load(goalId = this.goalId): Promise<GoalState> {
		if (goalId !== this.goalId) { throw Error('HARNESS_RESUME_ID_INVALID'); }
		const raw = await retrying(() => fs.readFile(this.file, 'utf8')).catch(error => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { throw Error('HARNESS_RESUME_UNAVAILABLE'); }
			throw error;
		});
		const entries: JournalEntry[] = [];
		for (const line of raw.split('\n')) {
			if (!line.trim()) { continue; }
			try {
				const value = JSON.parse(line) as JournalEntry & { v?: number };
				// A newer schema is never guessed: the IDE that wrote it must be the one that resumes it.
				if (value.v !== JOURNAL_SCHEMA) { throw Error('HARNESS_INCOMPATIBLE_SCHEMA'); }
				entries.push(value);
			} catch (error) {
				if ((error as Error).message === 'HARNESS_INCOMPATIBLE_SCHEMA') { throw error; }
				/* A torn last line from a crash is skipped. */
			}
		}
		return replayJournal(this.goalId, entries);
	}
	/** Goals with a journal in this directory, newest first. */
	static async list(directory: string): Promise<string[]> {
		const names = await fs.readdir(directory).catch(() => [] as string[]);
		const goals = names.filter(name => name.endsWith('.jsonl')).map(name => name.slice(0, -6)).filter(id => GOAL_ID.test(id));
		const stats = await Promise.all(goals.map(async id => [id, (await fs.stat(path.join(directory, id + '.jsonl'))).mtimeMs] as const));
		return stats.sort((left, right) => right[1] - left[1]).map(([id]) => id);
	}
}
