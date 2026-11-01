/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Delivery (block R, decision D7). Work happens in a managed worktree on `harness/<slug>`, created from the base commit,
 * so the user's checkout and uncommitted changes are never touched. Only the orchestrator commits; push and PR need the user.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { managedGit } from './native-worktree-checkpoint.ts';
import type { DoneResult } from './native-dod.ts';
import type { GoalState } from './native-goal-journal.ts';
import type { Spec } from './native-roles.ts';

export interface Delivery { root: string; branch: string; base: string; worktree: string }

const git = (root: string, args: string[]) => managedGit(root, args, { failure: 'HARNESS_WORKTREE_GIT_FAILED', maxBuffer: 4 * 1024 * 1024 });

/** `harness/<slug>`: lowercase ASCII words of the objective, bounded. */
export function deliverySlug(objective: string): string {
	const slug = objective.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
	return slug || 'objetivo';
}

/** A new branch and worktree from the base commit; the user's checkout is not modified. */
export async function createDelivery(root: string, storage: string, objective: string): Promise<Delivery> {
	const base = await git(root, ['rev-parse', '--verify', 'HEAD']);
	let branch = 'harness/' + deliverySlug(objective);
	for (let suffix = 2; await git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).then(() => true, () => false); suffix++) { branch = 'harness/' + deliverySlug(objective) + '-' + suffix; }
	await fs.mkdir(storage, { recursive: true, mode: 0o700 });
	const worktree = path.join(await fs.realpath(storage), branch.replace('/', '-'));
	await git(root, ['worktree', 'add', '-b', branch, worktree, base]);
	return { root, branch, base, worktree: await fs.realpath(worktree) };
}

/** One Conventional Commit for what the step changed; nothing is committed when nothing changed. */
export async function commitStep(delivery: Delivery, message: string): Promise<string | undefined> {
	await git(delivery.worktree, ['add', '-A']);
	if (!(await git(delivery.worktree, ['diff', '--cached', '--name-only']))) { return undefined; }
	await git(delivery.worktree, ['commit', '--no-verify', '-m', message]);
	return git(delivery.worktree, ['rev-parse', 'HEAD']);
}

/** Commit message in the project's format (Conventional Commits by default). */
export function commitMessage(kind: 'feat' | 'fix' | 'test' | 'refactor' | 'chore', title: string): string {
	return kind + ': ' + title.replace(/\s+/g, ' ').trim().replace(/^./, char => char.toLowerCase()).slice(0, 72);
}

/** Files the branch changed, to check before integrating it into the user's checkout. */
export async function deliveryFiles(delivery: Delivery): Promise<string[]> {
	return (await git(delivery.root, ['diff', '--name-only', delivery.base, delivery.branch])).split('\n').filter(Boolean);
}

/**
 * Accept: fast-forward the user's branch when nothing the delivery touches has uncommitted user changes.
 * Otherwise nothing is integrated and the user is offered the pull request (never a stash, never a discard).
 */
export async function acceptDelivery(delivery: Delivery): Promise<{ integrated: boolean; conflicts: string[] }> {
	const touched = new Set(await deliveryFiles(delivery));
	// Raw output: trimming would eat the leading status column of the first entry.
	const status = await managedGit(delivery.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { failure: 'HARNESS_WORKTREE_GIT_FAILED', maxBuffer: 4 * 1024 * 1024, raw: true });
	const dirty = status.split('\0').map(entry => entry.slice(3)).filter(Boolean);
	const conflicts = dirty.filter(file => touched.has(file));
	if (conflicts.length) { return { integrated: false, conflicts }; }
	await git(delivery.root, ['merge', '--ff-only', delivery.branch]);
	await discardDelivery(delivery, false);
	return { integrated: true, conflicts: [] };
}

/** Discard: remove the worktree and, unless it was integrated, the branch. The user's changes are not touched. */
export async function discardDelivery(delivery: Delivery, deleteBranch = true): Promise<void> {
	await git(delivery.root, ['worktree', 'remove', '--force', delivery.worktree]);
	if (deleteBranch) { await git(delivery.root, ['branch', '-D', delivery.branch]); }
}

export interface DeliveryContent { state: GoalState; spec?: Spec; done?: DoneResult[]; files: string[]; reviewNotes?: string[]; card?: string }

/** The delivery package: what was done and why, criteria with evidence, the Definition of Done, metrics and pending work. */
export function deliveryPackage(content: DeliveryContent): string {
	const { state } = content;
	const metrics = state.steps.map(step => step.metric).filter((value): value is number => value !== undefined);
	const lines = [
		'# Entrega: ' + state.charter.objective.split('\n')[0].slice(0, 120), '',
		'**Estado:** ' + state.status + (state.reason ? ' (' + state.reason + ')' : ''), '',
		'## Qu\u00e9 se hizo', ...state.steps.map(step => '- ' + step.title + ' — ' + step.status + (step.metric === undefined ? '' : ' · m\u00e9trica ' + step.metric)), ''
	];
	if (state.baseline !== undefined) { lines.push('## M\u00e9tricas', '- Antes: ' + state.baseline, '- Despu\u00e9s: ' + (metrics.at(-1) ?? state.baseline), ''); }
	if (content.spec?.criteria.length) { lines.push('## Criterios de aceptaci\u00f3n', ...content.spec.criteria.map(criterion => '- ' + criterion.id + ': ' + criterion.then), ''); }
	if (content.done) { lines.push('## Definici\u00f3n de Terminado', ...content.done.map(item => '- ' + ({ passed: '\u2705', failed: '\u274c', 'not-applicable': '\u2796', pending: '\u23f3' }[item.status]) + ' ' + item.title + (item.evidence ? ' — ' + item.evidence : '') + (item.reason ? ' — ' + item.reason : '')), ''); }
	if (content.reviewNotes?.length) { lines.push('## Revisi\u00f3n', ...content.reviewNotes.map(note => '- ' + note), ''); }
	const assumptions = [...state.charter.assumptions, ...(content.spec?.assumptions ?? [])];
	if (assumptions.length) { lines.push('## Supuestos', ...assumptions.map(item => '- ' + item), ''); }
	if (content.spec?.risks.length) { lines.push('## Riesgos residuales', ...content.spec.risks.map(item => '- ' + item), ''); }
	lines.push('## Archivos cambiados', ...content.files.map(file => '- `' + file + '`'), '', '## C\u00f3mo probarlo', '- Revis\u00e1 el diff de la rama y corr\u00e9 las verificaciones del proyecto.');
	return lines.join('\n') + '\n';
}

/** Pull request description following the project rules (for example, only the key of the card that the PR closes). */
export function pullRequestDescription(content: DeliveryContent): string {
	const summary = content.state.steps.filter(step => step.status === 'done').map(step => '- ' + step.title).join('\n');
	return (content.card ? content.card + '\n\n' : '') + '## Resumen\n' + (summary || '- ' + content.state.charter.objective.slice(0, 200)) + '\n\n## Verificaci\u00f3n\n' +
		(content.done ?? []).map(item => '- ' + item.title + ': ' + item.status).join('\n') + '\n';
}
