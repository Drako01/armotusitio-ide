/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Files a run changed, separated from the user's earlier edits. Read-only git plus content hashes; nothing is modified. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gitOutput } from './native-git.ts';

const MAX_ENTRIES = 5000;
const MAX_HASHED_BYTES = 8 * 1024 * 1024;
/** Files listed in a run summary; the count stays exact beyond it. */
const MAX_LISTED = 200;

export interface RunFileChange {
	path: string;
	change: 'added' | 'modified' | 'deleted';
	/** The file already had uncommitted changes before the run, so not every change in it is the run's. */
	preexisting: boolean;
}
export interface RunDiffSummary {
	/** False when the project is not a git repository or its state could not be read: nothing is claimed. */
	available: boolean;
	files: RunFileChange[];
	/** Total changed files, including those beyond the listed ones. */
	count: number;
	/** Fingerprint of each listed file right after the run, so a discard never overwrites a later user edit. */
	after?: Record<string, string>;
}
/** Uncommitted state of the working tree: project-relative path to a content fingerprint. */
export interface WorkingTreeSnapshot {
	source: 'git' | 'none';
	entries: Map<string, string>;
	untracked: Set<string>;
}

async function fingerprint(file: string): Promise<string> {
	try {
		const stat = await fs.lstat(file);
		if (!stat.isFile()) { return stat.isSymbolicLink() ? 'link:' + await fs.readlink(file) : 'special'; }
		if (stat.size > MAX_HASHED_BYTES) { return 'large:' + stat.size + ':' + stat.mtimeMs; }
		return createHash('sha256').update(await fs.readFile(file)).digest('hex');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return 'missing'; }
		throw error;
	}
}

/**
 * Uncommitted files and their content, read with `git status` (renames split into a deletion and an addition).
 * Only a project that is itself the repository root is measured, as in native-agent-scope.ts: inside a parent
 * repository, status paths would be relative to that repository and would include unrelated work.
 */
export async function captureWorkingTree(root: string): Promise<WorkingTreeSnapshot> {
	const empty: WorkingTreeSnapshot = { source: 'none', entries: new Map(), untracked: new Set() };
	if (!await fs.lstat(path.join(root, '.git')).then(() => true, () => false)) { return empty; }
	let raw: Buffer;
	try { raw = await gitOutput(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']); }
	catch { return empty; }
	const records = raw.toString('utf8').split('\0').filter(Boolean);
	if (records.length > MAX_ENTRIES) { return empty; }
	const snapshot: WorkingTreeSnapshot = { source: 'git', entries: new Map(), untracked: new Set() };
	for (const record of records) {
		const file = record.slice(3);
		if (!file || file.endsWith('/')) { continue; }
		snapshot.entries.set(file, await fingerprint(path.join(root, file)));
		if (record.startsWith('??')) { snapshot.untracked.add(file); }
	}
	return snapshot;
}

/** What changed between two snapshots. A file the run reverted to its committed content counts as modified. */
export function diffWorkingTree(before: WorkingTreeSnapshot, after: WorkingTreeSnapshot): RunDiffSummary {
	if (before.source !== 'git' || after.source !== 'git') { return { available: false, files: [], count: 0 }; }
	const changed: RunFileChange[] = [];
	for (const file of new Set([...before.entries.keys(), ...after.entries.keys()])) {
		const previous = before.entries.get(file), current = after.entries.get(file);
		if (previous === current) { continue; }
		const preexisting = previous !== undefined;
		const change = current === 'missing' ? 'deleted' : !preexisting && after.untracked.has(file) ? 'added' : 'modified';
		changed.push({ path: file, change, preexisting });
	}
	changed.sort((left, right) => left.path.localeCompare(right.path));
	return { available: true, files: changed.slice(0, MAX_LISTED), count: changed.length };
}

/**
 * Undo what a run changed, file by file, restoring the committed content: added files are removed, modified and deleted
 * ones come back from HEAD. A file that already had the user's changes before the run is never touched, and neither is
 * one the user edited after it (its content no longer matches what the run left). Reads git; never runs a git mutation.
 */
export async function discardRunChanges(root: string, summary: RunDiffSummary, after: Map<string, string>): Promise<{ discarded: string[]; skipped: string[] }> {
	const discarded: string[] = [], skipped: string[] = [];
	for (const file of summary.files) {
		const target = path.join(root, file.path);
		if (file.preexisting || (after.has(file.path) && after.get(file.path) !== await fingerprint(target))) { skipped.push(file.path); continue; }
		if (file.change === 'added') { await fs.rm(target, { force: true }); }
		else {
			const committed = await gitOutput(root, ['show', 'HEAD:' + file.path]).catch(() => undefined);
			if (committed === undefined) { skipped.push(file.path); continue; }
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, committed);
		}
		discarded.push(file.path);
	}
	return { discarded, skipped };
}

/** Content fingerprints of the files a run changed, kept so a later discard can tell whether the user edited them since. */
export async function fingerprintFiles(root: string, files: readonly RunFileChange[]): Promise<Record<string, string>> {
	return Object.fromEntries(await Promise.all(files.map(async file => [file.path, await fingerprint(path.join(root, file.path))] as const)));
}

/** A stored summary is display data; anything malformed is dropped instead of trusted. */
export function validRunDiff(value: RunDiffSummary | undefined): boolean {
	return value === undefined || (!!value && typeof value.available === 'boolean' && Number.isSafeInteger(value.count) && value.count >= 0 &&
		Array.isArray(value.files) && value.files.length <= MAX_LISTED && value.files.every(file => !!file && typeof file.path === 'string' && file.path.length <= 4096 &&
			['added', 'modified', 'deleted'].includes(file.change) && typeof file.preexisting === 'boolean'));
}
