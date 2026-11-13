/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar. */
/**
 * Bounded, private, attributed checkpoints for sequential chat writer tools.
 * Ambiguous/concurrent events are not assigned to tools; the existing run-level
 * diff remains the fallback. No checkpoint is ever restored without fresh approval.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { gitOutput } from './native-git.ts';
import { captureWorkingTree, diffWorkingTree, type WorkingTreeSnapshot } from './native-run-diff.ts';
import { safeStorage, writeDurable } from './native-worktree-checkpoint.ts';
import { SECRET_NAME } from './native-sensitive-scope.ts';
import type { ChatStep } from './native-run-steps.ts';

const MAX_CHECKPOINTS = 24;
const MAX_FILES = 12;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
/** Directory entries examined per listing: a flooded store is truncated instead of being read without bound. */
const MAX_STORE_ENTRIES = 256;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
interface FileRevision {
	path: string;
	/** Previous exact bytes (base64), null for a file that did not exist. */
	before: string | null;
	/** SHA-256 or 'missing' of the file immediately after the tool. */
	after: string;
}
export interface ToolCheckpoint {
	schemaVersion: 1;
	id: string;
	rootDigest: string;
	at: string;
	/** The writer run (one chat turn) that owned the tool; absent in records written before turns were attributed. */
	turnId?: string;
	/** Position of the tool among the checkpoints of its turn, starting at 1. */
	sequence?: number;
	stepId: string;
	kind: 'edit' | 'command';
	state: 'ready' | 'restored';
	files: FileRevision[];
}
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

function safeRelative(relative: string): boolean {
	return !!relative && relative.length <= 512 && !relative.includes('\\') && !relative.includes('\0')
		&& !path.isAbsolute(relative) && !/[:<>|]/.test(relative) && !/^[A-Za-z]:/.test(relative)
		&& relative.split('/').every(part => !!part && part !== '.' && part !== '..'
			&& !part.startsWith('.') && !SECRET_NAME.test(part)
			&& !['node_modules', 'dist', 'harness'].includes(part.toLowerCase()));
}

/** Refuse linked ancestors and non-regular targets, including when a file was deleted. */
async function safeTarget(root: string, relative: string): Promise<string | undefined> {
	if (!safeRelative(relative) || await fs.realpath(root).catch(() => undefined) !== path.resolve(root)) { return undefined; }
	let parent = root;
	for (const component of relative.split('/').slice(0, -1)) {
		parent = path.join(parent, component);
		const stat = await fs.lstat(parent).catch(() => undefined);
		if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) { return undefined; }
	}
	const file = path.resolve(root, relative);
	const stat = await fs.lstat(file).catch(() => undefined);
	if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)) { return undefined; }
	return file;
}
async function bytesOf(root: string, relative: string): Promise<Buffer | null | undefined> {
	const target = await safeTarget(root, relative);
	if (!target) { return undefined; }
	try {
		const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { return undefined; }
			const bytes = await handle.readFile();
			return bytes.length > MAX_FILE_BYTES ? undefined : bytes;
		} finally { await handle.close(); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
		return undefined;
	}
}
const hashOf = (data: Buffer | null | undefined): string | undefined => data === undefined ? undefined : data === null ? 'missing' : digest(data);
function validate(value: unknown, root: string): ToolCheckpoint | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
	const row = value as ToolCheckpoint;
	if (row.schemaVersion !== 1 || !UUID.test(row.id) || row.rootDigest !== digest(root)
		|| !['ready', 'restored'].includes(row.state) || !['edit', 'command'].includes(row.kind)
		|| typeof row.stepId !== 'string' || row.stepId.length > 64
		|| (row.turnId !== undefined && !UUID.test(row.turnId))
		|| (row.sequence !== undefined && (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.sequence > MAX_CHECKPOINTS))
		|| typeof row.at !== 'string' || Number.isNaN(Date.parse(row.at))
		|| !Array.isArray(row.files) || !row.files.length || row.files.length > MAX_FILES) { return; }
	for (const file of row.files) {
		if (!file || !safeRelative(file.path) || !(file.after === 'missing' || SHA.test(file.after))
			|| !(file.before === null || typeof file.before === 'string' && file.before.length <= Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8
				&& /^[A-Za-z0-9+/]*={0,2}$/.test(file.before))) { return; }
	}
	return row;
}
async function load(root: string, storage: string, id: string): Promise<ToolCheckpoint> {
	if (!UUID.test(id)) { throw Error('HARNESS_TOOL_CHECKPOINT_INVALID'); }
	await safeStorage(storage);
	const file = path.join(storage, id + '.json');
	const stat = await fs.lstat(file).catch(() => undefined);
	if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) { throw Error('HARNESS_TOOL_CHECKPOINT_INVALID'); }
	const record = validate(JSON.parse(await fs.readFile(file, 'utf8')), root);
	if (!record || record.id !== id) { throw Error('HARNESS_TOOL_CHECKPOINT_INVALID'); }
	return record;
}
const intentFile = (storage: string, id: string): string => path.join(storage, id + '.restore.intent');
const exists = (file: string): Promise<boolean> => fs.lstat(file).then(() => true, () => false);

/** Every valid record of this root, newest first. File names are random, so age comes from the record itself. */
async function storedCheckpoints(root: string, storage: string): Promise<ToolCheckpoint[]> {
	await safeStorage(storage);
	const ids = (await fs.readdir(storage)).filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5))).slice(0, MAX_STORE_ENTRIES).map(name => name.slice(0, -5));
	const records = await Promise.all(ids.map(id => load(root, storage, id).catch(() => undefined)));
	return records.filter((record): record is ToolCheckpoint => !!record)
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (b.sequence ?? 0) - (a.sequence ?? 0) || b.id.localeCompare(a.id));
}

export async function listChatToolCheckpoints(root: string, storage: string): Promise<ToolCheckpoint[]> {
	return (await storedCheckpoints(root, storage)).filter(record => record.state === 'ready').slice(0, MAX_CHECKPOINTS);
}

/** What a file of a checkpoint did and whether restoring it now would succeed. */
export interface ToolCheckpointFile {
	path: string;
	change: 'added' | 'modified' | 'deleted';
	/** False when the file changed after the tool (usually a later human edit): a restore would leave everything untouched. */
	restorable: boolean;
}
export type ToolCheckpointView = Pick<ToolCheckpoint, 'id' | 'at' | 'turnId' | 'sequence' | 'stepId' | 'kind'> & { files: ToolCheckpointFile[] };

/** Read-only preview with the same fingerprint rule as the restore; never writes, never returns file contents. */
export async function inspectChatToolCheckpoints(root: string, storage: string): Promise<ToolCheckpointView[]> {
	return Promise.all((await listChatToolCheckpoints(root, storage)).map(async record => ({
		id: record.id, at: record.at, turnId: record.turnId, sequence: record.sequence, stepId: record.stepId, kind: record.kind,
		files: await Promise.all(record.files.map(async file => ({
			path: file.path,
			change: file.before === null ? 'added' as const : file.after === 'missing' ? 'deleted' as const : 'modified' as const,
			restorable: hashOf(await bytesOf(root, file.path)) === file.after
		})))
	})));
}

/** The exact bytes a file had before its tool, for a read-only diff; null when the tool created it. */
export async function toolCheckpointBefore(root: string, storage: string, id: string, file: string): Promise<Buffer | null> {
	const entry = (await load(root, storage, id)).files.find(item => item.path === file);
	if (!entry) { throw Error('HARNESS_TOOL_CHECKPOINT_INVALID'); }
	return entry.before === null ? null : Buffer.from(entry.before, 'base64');
}

/**
 * An explicit writer-fenced restore. If a file changed after its tool, nothing is overwritten.
 * A restore interrupted half-way leaves its intent on disk; a new, freshly confirmed call resumes it: files that
 * already hold the checkpoint's previous bytes count as restored, and any other content still blocks the whole restore.
 */
export async function restoreChatToolCheckpoint(root: string, storage: string, id: string, assertFence: () => Promise<void>): Promise<{ restored: string[]; skipped: string[] }> {
	await assertFence();
	const record = await load(root, storage, id);
	if (record.state !== 'ready') { throw Error('HARNESS_TOOL_CHECKPOINT_USED'); }
	const journal = intentFile(storage, id);
	const intent = await fs.lstat(journal).catch(() => undefined);
	// Only the regular file this module writes is an intent; anything else in its place is not trusted.
	if (intent && (!intent.isFile() || intent.isSymbolicLink())) { throw Error('HARNESS_TOOL_CHECKPOINT_RECOVERY_REQUIRED'); }
	const resuming = !!intent;
	const candidates: Array<{ path: string; file: string; before: Buffer | null; after: string }> = [];
	const skipped: string[] = [];
	const restored: string[] = [];
	for (const entry of record.files) {
		const target = await safeTarget(root, entry.path);
		const current = target ? await bytesOf(root, entry.path) : undefined;
		const before = entry.before === null ? null : Buffer.from(entry.before, 'base64');
		if (!target || (before && before.length > MAX_FILE_BYTES)) { skipped.push(entry.path); continue; }
		if (resuming && hashOf(current) === hashOf(before) && entry.after !== hashOf(before)) { restored.push(entry.path); continue; }
		if (hashOf(current) !== entry.after) { skipped.push(entry.path); continue; }
		candidates.push({ path: entry.path, file: target, before, after: entry.after });
	}
	// A partial or ambiguous restore is rejected atomically before changing files.
	if (skipped.length) { return { restored: [], skipped }; }
	await assertFence();
	if (!resuming) { await writeDurable(journal, { schemaVersion: 1, id, at: new Date().toISOString() }, true); }
	// A failure below keeps the intent on disk, so the interruption stays visible and resumable.
	for (const item of candidates) {
		await assertFence();
		if (hashOf(await bytesOf(root, item.path)) !== item.after) { throw Error('HARNESS_TOOL_CHECKPOINT_CHANGED'); }
		if (item.before === null) {
			await fs.rm(item.file, { force: true });
		} else {
			await fs.mkdir(path.dirname(item.file), { recursive: true });
			const temporary = item.file + '.' + randomUUID() + '.checkpoint.tmp';
			try {
				await fs.writeFile(temporary, item.before, { flag: 'wx', mode: 0o600 });
				await assertFence();
				if (hashOf(await bytesOf(root, item.path)) !== item.after) { throw Error('HARNESS_TOOL_CHECKPOINT_CHANGED'); }
				await fs.rename(temporary, item.file);
			} finally { await fs.rm(temporary, { force: true }); }
		}
		restored.push(item.path);
	}
	await writeDurable(path.join(storage, id + '.json'), { ...record, state: 'restored' }, false, MAX_RECORD_BYTES);
	await fs.rm(journal, { force: true });
	return { restored, skipped: [] };
}

/** Sequential tool observation: concurrent editing invalidates attribution for this run. */
export class ChatToolCheckpointRecorder {
	private initial?: WorkingTreeSnapshot;
	private previous?: WorkingTreeSnapshot;
	private readonly contents = new Map<string, Buffer | null>();
	private readonly active = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private ambiguous = false;
	private written = 0;
	/** One recorder observes one writer run, so its id attributes every checkpoint to that turn. */
	readonly turnId = randomUUID();
	private readonly root: string;
	private readonly storage: string;
	constructor(root: string, storage: string) { this.root = root; this.storage = storage; }

	async begin(): Promise<void> {
		this.initial = this.previous = await captureWorkingTree(this.root);
		if (this.previous.source !== 'git') { this.ambiguous = true; }
	}
	observe(step: ChatStep): void {
		if (this.ambiguous || !['edit', 'command'].includes(step.kind)) { return; }
		if (step.status === 'running') {
			this.active.add(step.id);
			if (this.active.size > 1) { this.ambiguous = true; }
			return;
		}
		if (!this.active.delete(step.id) || this.active.size || step.status !== 'ok') {
			this.ambiguous = true;
			return;
		}
		this.queue = this.queue.then(() => this.record(step)).catch(() => { this.ambiguous = true; });
	}
	private async record(step: ChatStep): Promise<void> {
		// A later tool that started before this observation ran makes ownership uncertain.
		if (this.active.size) { this.ambiguous = true; }
		if (this.ambiguous || !this.previous || !this.initial || this.written >= MAX_CHECKPOINTS) { return; }
		const next = await captureWorkingTree(this.root);
		const changes = diffWorkingTree(this.previous, next);
		if (!changes.available || changes.count > MAX_FILES || changes.files.some(file => this.initial!.entries.has(file.path) || !safeRelative(file.path))) {
			this.ambiguous = true; return;
		}
		const revisions: FileRevision[] = [];
		for (const change of changes.files) {
			const afterBytes = await bytesOf(this.root, change.path);
			if (afterBytes === undefined) { this.ambiguous = true; return; }
			let before: Buffer | null | undefined = this.contents.get(change.path);
			if (before === undefined) {
				// `--filters` yields the bytes a checkout writes (line endings, smudge), not the normalized blob.
				const committed = await gitOutput(this.root, ['cat-file', '--filters', 'HEAD:' + change.path]).catch(() => undefined);
				before = committed === undefined ? null : committed;
			}
			if (before && before.length > MAX_FILE_BYTES) { this.ambiguous = true; return; }
			revisions.push({ path: change.path, before: before === null ? null : before.toString('base64'), after: hashOf(afterBytes)! });
			this.contents.set(change.path, afterBytes);
		}
		this.previous = next;
		if (!revisions.length) { return; }
		await safeStorage(this.storage);
		const id = randomUUID();
		const record: ToolCheckpoint = {
			schemaVersion: 1, id, rootDigest: digest(this.root), at: new Date().toISOString(),
			turnId: this.turnId, sequence: this.written + 1, stepId: step.id, kind: step.kind as 'edit' | 'command', state: 'ready', files: revisions
		};
		await writeDurable(path.join(this.storage, id + '.json'), record, true, MAX_RECORD_BYTES);
		this.written++;
		// Keep the newest 24 records across runs; one with a pending restore intent is never pruned.
		for (const old of (await storedCheckpoints(this.root, this.storage)).slice(MAX_CHECKPOINTS)) {
			if (!await exists(intentFile(this.storage, old.id))) { await fs.rm(path.join(this.storage, old.id + '.json'), { force: true }); }
		}
	}
	async finish(): Promise<number> { await this.queue; return this.written; }
}
