/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Working alongside the user (block O): git states that block a goal, user git actions and edits that collide with a step. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitOutput } from './native-git.ts';
import type { WorkingTreeSnapshot } from './native-run-diff.ts';

export type GitBlocker = 'merge-in-progress' | 'rebase-in-progress' | 'cherry-pick-in-progress' | 'conflicts' | 'detached-head' | 'dirty-submodules';
/** Branch, HEAD and every ref; any change between steps that the goal did not make is a user action. */
export interface RefSnapshot { head: string; branch: string; refs: string }

async function gitDir(root: string): Promise<string | undefined> {
	const marker = path.join(root, '.git');
	const stat = await fs.lstat(marker).catch(() => undefined);
	if (!stat) { return undefined; }
	if (stat.isDirectory()) { return marker; }
	// A linked worktree: `.git` is a file naming its private git folder.
	const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(marker, 'utf8'));
	return pointer ? path.resolve(root, pointer[1].trim()) : undefined;
}

/** States in which a goal must not start (EC-18, EC-21); each one tells the user what to resolve. */
export async function gitBlockers(root: string): Promise<GitBlocker[]> {
	const directory = await gitDir(root);
	if (!directory) { return []; }
	const exists = (name: string) => fs.lstat(path.join(directory, name)).then(() => true, () => false);
	const blockers: GitBlocker[] = [];
	if (await exists('MERGE_HEAD')) { blockers.push('merge-in-progress'); }
	if (await exists('rebase-merge') || await exists('rebase-apply')) { blockers.push('rebase-in-progress'); }
	if (await exists('CHERRY_PICK_HEAD')) { blockers.push('cherry-pick-in-progress'); }
	const status = (await gitOutput(root, ['status', '--porcelain=v1', '-z']).catch(() => Buffer.alloc(0))).toString('utf8').split('\0');
	if (status.some(entry => /^(DD|AU|UD|UA|DU|AA|UU) /.test(entry))) { blockers.push('conflicts'); }
	const branch = (await gitOutput(root, ['symbolic-ref', '-q', 'HEAD']).catch(() => Buffer.alloc(0))).toString('utf8').trim();
	if (!branch) { blockers.push('detached-head'); }
	const submodules = (await gitOutput(root, ['submodule', 'status']).catch(() => Buffer.alloc(0))).toString('utf8');
	if (submodules.split('\n').some(line => /^[+U]/.test(line))) { blockers.push('dirty-submodules'); }
	return blockers;
}

export async function captureRefs(root: string): Promise<RefSnapshot> {
	const read = async (args: string[]) => (await gitOutput(root, args).catch(() => Buffer.alloc(0))).toString('utf8').trim();
	return { head: await read(['rev-parse', 'HEAD']), branch: await read(['symbolic-ref', '-q', '--short', 'HEAD']), refs: await read(['for-each-ref', '--format=%(refname) %(objectname)']) };
}

/** A commit, branch switch, stash or pull by the user pauses the goal; it is never counted as an agent violation (D1). */
export function userGitAction(before: RefSnapshot, after: RefSnapshot): 'commit' | 'branch-switch' | 'refs-changed' | undefined {
	if (before.branch !== after.branch) { return 'branch-switch'; }
	if (before.head !== after.head) { return 'commit'; }
	return before.refs !== after.refs ? 'refs-changed' : undefined;
}

/**
 * Files the user changed during a step that the agent also changed (EC-17): the step goes to "conflict" and both
 * changes are kept. `userSaved` are paths the editor reported as saved by the user while the step ran.
 */
export function editConflicts(agentFiles: readonly string[], userSaved: ReadonlySet<string>): string[] {
	return agentFiles.filter(file => userSaved.has(file));
}

/** Hashes of the scope at the start of a step, so a later comparison can tell whose change a file holds. */
export function scopeChangedOutsideRun(before: WorkingTreeSnapshot, after: WorkingTreeSnapshot, runFiles: ReadonlySet<string>): string[] {
	const changed: string[] = [];
	for (const file of new Set([...before.entries.keys(), ...after.entries.keys()])) {
		if (before.entries.get(file) !== after.entries.get(file) && !runFiles.has(file)) { changed.push(file); }
	}
	return changed.sort();
}
