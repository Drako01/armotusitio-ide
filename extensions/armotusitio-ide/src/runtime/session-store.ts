/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Durable registry of native agent sessions, one private file per project next to its chat history. Writes are atomic
 * (fsync + rename) under a cross-window lock. Before a turn starts, a `pending` journal entry is written; a crash leaves
 * that entry behind, and recovery turns it into `lost`: it is reported, never replayed. Nothing secret is stored: native
 * ids, digests of inputs (never the inputs) and states. A corrupt file is quarantined; a newer schema is never overwritten.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withFileLock } from '../native-chat.ts';
import { processAlive } from '../native-runtime.ts';
import { safeStorage, writeDurable } from '../native-worktree-checkpoint.ts';
import type { NativeProvider } from '../native-providers.ts';
import type { SessionIdentity, SessionRole, SessionState } from './contracts.ts';

export const SESSION_STORE_VERSION = 1;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 64;
const MAX_JOURNAL = 50;

export type JournalStatus = 'pending' | 'running' | 'completed' | 'interrupted' | 'failed' | 'lost';
export interface TurnJournalEntry {
	clientTurnId: string;
	turnId?: string;
	role: SessionRole;
	status: JournalStatus;
	/** sha256 of the turn input: proves which input a turn had without storing it. */
	inputDigest: string;
	startedAt: string;
	endedAt?: string;
	/** IDE process that owns the turn; a dead owner means the turn was cut off. */
	pid: number;
	error?: string;
}
export interface SessionRecord {
	key: string;
	identity: SessionIdentity;
	nativeSessionId?: string;
	providerVersion?: string;
	model?: string;
	effort?: string;
	role?: SessionRole;
	state: SessionState;
	createdAt: string;
	updatedAt: string;
	/** Sequence of the last event the IDE processed. */
	cursor: number;
	/** Caller-defined reference (a chat message id) of the last input a completed turn delivered: later turns send only what is newer. */
	lastInputRef?: string;
	forkedFrom?: string;
	/** The provider switch this session was created by: a new session, never the other provider's id. */
	handoffFrom?: { provider: NativeProvider; nativeSessionId?: string };
	journal: TurnJournalEntry[];
}
interface StoreFile { schemaVersion: number; sessions: Record<string, SessionRecord> }

export function digestInput(text: string): string { return createHash('sha256').update(text).digest('hex'); }

const STATES = new Set<SessionState>(['starting', 'ready', 'running', 'awaiting_approval', 'awaiting_user_input', 'interrupted', 'recovering', 'failed', 'closed']);
const JOURNAL_STATES = new Set<JournalStatus>(['pending', 'running', 'completed', 'interrupted', 'failed', 'lost']);

function validRecord(value: SessionRecord): boolean {
	return !!value && typeof value.key === 'string' && !!value.identity && typeof value.identity.root === 'string' && (value.identity.provider === 'claude' || value.identity.provider === 'codex') &&
		STATES.has(value.state) && Number.isSafeInteger(value.cursor) && Array.isArray(value.journal) && value.journal.length <= MAX_JOURNAL &&
		value.journal.every(entry => typeof entry.clientTurnId === 'string' && JOURNAL_STATES.has(entry.status) && /^[a-f0-9]{64}$/.test(entry.inputDigest) && Number.isSafeInteger(entry.pid)) &&
		(value.nativeSessionId === undefined || (typeof value.nativeSessionId === 'string' && value.nativeSessionId.length <= 200));
}

/**
 * Upgrades older layouts in memory; the next write stores the current version. Version 0 (no `schemaVersion`) was never
 * released, so it only needs the field. Newer versions are refused so an older IDE never rewrites them.
 */
export function migrateStore(value: unknown): StoreFile {
	const file = value as Partial<StoreFile> | undefined;
	if (!file || typeof file !== 'object' || Array.isArray(file)) { throw Error('RUNTIME_STORE_INVALID'); }
	const version = file.schemaVersion ?? 0;
	if (version > SESSION_STORE_VERSION) { throw Error('RUNTIME_STORE_NEWER'); }
	const sessions = file.sessions ?? {};
	if (typeof sessions !== 'object' || Array.isArray(sessions) || !Object.values(sessions).every(validRecord)) { throw Error('RUNTIME_STORE_INVALID'); }
	return { schemaVersion: SESSION_STORE_VERSION, sessions };
}

export class AgentSessionStore {
	private readonly directory: string;
	private readonly file: string;
	/** Set when a corrupt registry was moved aside during this IDE session. */
	quarantined = false;

	constructor(directory: string) {
		this.directory = directory;
		this.file = path.join(directory, 'agent-sessions.json');
	}

	async get(key: string): Promise<SessionRecord | undefined> { return (await this.read()).sessions[key]; }

	async list(): Promise<SessionRecord[]> { return Object.values((await this.read()).sessions); }

	/** Read-modify-write under the lock; `mutate` returning `undefined` deletes the record. */
	async update(key: string, mutate: (record: SessionRecord | undefined) => SessionRecord | undefined): Promise<SessionRecord | undefined> {
		await safeStorage(this.directory);
		return withFileLock(this.file + '.lock', async () => {
			const store = await this.read();
			const next = mutate(store.sessions[key] ? structuredClone(store.sessions[key]) : undefined);
			if (next) {
				next.updatedAt = new Date().toISOString();
				next.journal = next.journal.slice(-MAX_JOURNAL);
				store.sessions[key] = next;
			} else {
				delete store.sessions[key];
			}
			// Oldest sessions go first when a project accumulates too many.
			const keys = Object.keys(store.sessions).sort((left, right) => store.sessions[left].updatedAt.localeCompare(store.sessions[right].updatedAt));
			for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) { delete store.sessions[old]; }
			await writeDurable(this.file, store, false, MAX_BYTES);
			return next;
		});
	}

	/**
	 * Turns owned by a dead IDE process that never ended: they are marked `lost` (connection lost), never replayed.
	 * Returns the entries changed, per session key.
	 */
	async reconcile(alive: (pid: number) => boolean = pid => pid === process.pid || processAlive(pid)): Promise<Array<{ key: string; entry: TurnJournalEntry }>> {
		const lost: Array<{ key: string; entry: TurnJournalEntry }> = [];
		for (const record of await this.list()) {
			const open = record.journal.filter(entry => (entry.status === 'pending' || entry.status === 'running') && !alive(entry.pid));
			if (!open.length) { continue; }
			await this.update(record.key, current => {
				if (!current) { return current; }
				for (const entry of current.journal) {
					if (open.some(item => item.clientTurnId === entry.clientTurnId) && (entry.status === 'pending' || entry.status === 'running')) {
						entry.status = 'lost'; entry.endedAt = new Date().toISOString(); entry.error = 'RUNTIME_CONNECTION_LOST';
						lost.push({ key: current.key, entry: { ...entry } });
					}
				}
				if (current.state !== 'closed' && current.state !== 'failed') { current.state = 'interrupted'; }
				return current;
			});
		}
		return lost;
	}

	private async read(): Promise<StoreFile> {
		let raw: string;
		try {
			const stat = await fs.lstat(this.file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) { return this.quarantine(); }
			raw = await fs.readFile(this.file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { schemaVersion: SESSION_STORE_VERSION, sessions: {} }; }
			throw error;
		}
		try { return migrateStore(JSON.parse(raw)); }
		catch (error) {
			if ((error as Error).message === 'RUNTIME_STORE_NEWER') { throw error; }
			return this.quarantine();
		}
	}

	private async quarantine(): Promise<StoreFile> {
		await fs.rename(this.file, this.file + '.' + Date.now() + '.corrupt').catch(() => fs.rm(this.file, { force: true }));
		this.quarantined = true;
		return { schemaVersion: SESSION_STORE_VERSION, sessions: {} };
	}
}
