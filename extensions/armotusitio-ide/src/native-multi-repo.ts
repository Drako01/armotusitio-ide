/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Goals across repositories (block T): one objective over several workspace folders, integrated in contract order (the
 * repository that adds an inert capability first, then the one that uses it), one branch per repository with the same
 * name, and pull requests that reference each other with the merge order.
 */

export interface RepoPart { name: string; root: string; dependsOn: string[] }
export interface RepoDelivery { name: string; branch: string; pullRequest?: string }

/** Integration order: dependencies first; a cycle cannot be integrated safely and is rejected. */
export function integrationOrder(parts: readonly RepoPart[]): RepoPart[] {
	const ordered: RepoPart[] = [];
	const done = new Set<string>();
	while (ordered.length < parts.length) {
		const next = parts.filter(part => !done.has(part.name) && part.dependsOn.every(dependency => done.has(dependency)));
		if (!next.length) { throw Error('HARNESS_CYCLE'); }
		for (const part of next) { ordered.push(part); done.add(part.name); }
	}
	return ordered;
}

/** Instruction for one repository's part: its role in the contract and backward compatibility (expand, migrate, contract). */
export function repoPartInstruction(objective: string, part: RepoPart, order: readonly RepoPart[], previous: readonly RepoDelivery[]): string {
	const position = order.findIndex(item => item.name === part.name) + 1;
	return objective + '\n\nThis goal spans ' + order.length + ' repositories, integrated in this order: ' + order.map(item => item.name).join(' → ') + '. You work on "' + part.name + '" (' + position + ' of ' + order.length + ').' +
		(previous.length ? ' Already delivered: ' + previous.map(item => item.name + ' on ' + item.branch).join(', ') + '.' : '') +
		' Keep this repository working with the previous version of the others (expand → migrate → contract): a new capability must be inert until its user arrives.';
}

/** The section every linked pull request carries: the other parts and the merge order. */
export function linkedPullRequestsSection(deliveries: readonly RepoDelivery[], current: string): string {
	return '## Cambios enlazados\n\nOrden de merge:\n' + deliveries.map((item, index) => (index + 1) + '. ' + item.name + ' — `' + item.branch + '`' + (item.pullRequest ? ' (' + item.pullRequest + ')' : '') + (item.name === current ? ' ← este PR' : '')).join('\n') + '\n';
}
