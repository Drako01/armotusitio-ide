/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

/** Release identity rules shared by the local recipe (release.sh) and the release CI. */
export const releaseMetadataPath = 'build/armotusitio/product-overrides.json';

export interface ReleaseDraft {
	readonly tag_name: string;
	readonly draft: boolean;
	readonly target_commitish?: string;
}

export interface ReleasePlan {
	readonly revision: number;
	readonly tag: string;
	readonly draft?: ReleaseDraft;
	readonly previous?: string;
}

/** Fail unless version, upstream, stable channel and trusted update metadata agree. */
export function assertReleaseMetadata(pkg: { version?: unknown }, product: { version?: unknown }, overrides: any, repository: string): void {
	const version = pkg.version;
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || (product.version !== undefined && product.version !== version)
		|| overrides.armotusitioUpstream?.ref?.replace(/^v/, '') !== version
		|| overrides.armotusitioUpdate?.repository !== repository || overrides.quality !== 'stable'
		|| !Number.isSafeInteger(overrides.armotusitioUpdate?.revision) || overrides.armotusitioUpdate.revision < 1
		|| typeof overrides.armotusitioUpdate.publicKey !== 'string') {
		throw new Error('Release version, upstream, stable channel or trusted update metadata is inconsistent.');
	}
}

/**
 * Select the next revision from `gh api --paginate --slurp` release pages:
 * max(published revisions of this version) + 1, or 1. Drafts never count.
 */
export function planReleaseRevision(pages: unknown, version: string): ReleasePlan {
	if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) { throw new Error('Invalid paginated release response.'); }
	const releases = (pages as unknown[][]).flat() as any[];
	let maximum = 0;
	for (const release of releases) {
		if (typeof release?.tag_name !== 'string' || typeof release.draft !== 'boolean') { throw new Error('Invalid release metadata.'); }
		if (release.draft) { continue; }
		const match = /^ats-v(?<version>\d+\.\d+\.\d+)-r(?<revision>[1-9]\d*)$/.exec(release.tag_name);
		if (!match || match.groups?.version !== version) { continue; }
		if (typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at)) || !Number.isSafeInteger(Number(match.groups.revision))) {
			throw new Error('Published release has invalid revision or publication date.');
		}
		maximum = Math.max(maximum, Number(match.groups.revision));
	}
	const revision = maximum + 1;
	if (!Number.isSafeInteger(revision)) { throw new Error('Release revision overflow.'); }
	const tag = `ats-v${version}-r${revision}`;
	const matching = releases.filter(release => release.tag_name === tag);
	if (matching.length > 1) { throw new Error('Ambiguous release tag.'); }
	return { revision, tag, draft: matching[0], previous: maximum ? `ats-v${version}-r${maximum}` : undefined };
}

/** Atomically rewrite only the update revision of the release metadata. */
export async function writeReleaseRevision(root: string, overrides: any, revision: number): Promise<void> {
	overrides.armotusitioUpdate.revision = revision;
	const target = path.join(root, releaseMetadataPath);
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(overrides, null, '\t') + '\n', { flag: 'wx' });
		await rename(temporary, target);
	} finally { await rm(temporary, { force: true }); }
}
