/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { armotusitioRepository } from '../src/vs/platform/update/common/armotusitioUpdate.ts';
import { repositoryRoot, run } from './ats-autoupdate.mts';
import { assertReleaseMetadata, planReleaseRevision, releaseMetadataPath, type ReleasePlan } from './ats-release-revision.mts';

/** CI publishes reviewed sources only; revision changes must land through a protected PR first. */
export type ReleaseAction = 'publish';

/** A draft for the selected tag can only be resumed from the commit it was created for. */
export function releaseAction(plan: ReleasePlan, metadataRevision: number, head: string): ReleaseAction {
	if (plan.draft && plan.draft.target_commitish !== head) {
		throw new Error(`Draft ${plan.tag} targets another commit. Inspect and delete that draft before retrying; it was not changed.`);
	}
	if (metadataRevision !== plan.revision) {
		throw new Error(`Release ${plan.tag} requires reviewed revision ${plan.revision} in ${releaseMetadataPath}. Prepare a metadata-only PR, pass ATS gate and merge it before retrying; CI does not change sources.`);
	}
	return 'publish';
}

const git = (...args: string[]) => run('git', args);
const json = async (file: string) => JSON.parse(await readFile(path.join(repositoryRoot, file), 'utf8'));

/**
 * Runs in the release workflow on a checkout of current main. Validates the reviewed revision and
 * writes its immutable `tag` and `commit` to GITHUB_OUTPUT for the build jobs without changing sources.
 * A rehearsal builds the checked-out PR commit as is: it never commits, pushes or publishes.
 */
async function prepare(rehearsal: boolean): Promise<void> {
	if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== armotusitioRepository || !process.env.GITHUB_OUTPUT) {
		throw new Error('This step runs only in the ArmotuSitio Release workflow.');
	}
	const head = await git('rev-parse', 'HEAD');
	if (await git('status', '--porcelain', '--untracked-files=no')
		|| (!rehearsal && (await git('branch', '--show-current') !== 'main' || head !== await git('rev-parse', 'origin/main')))) {
		throw new Error('Release preparation requires a clean checkout of current main.');
	}
	const [pkg, product, overrides] = await Promise.all([json('package.json'), json('product.json'), json(releaseMetadataPath)]);
	assertReleaseMetadata(pkg, product, overrides, armotusitioRepository);
	const plan = planReleaseRevision(JSON.parse(await run('gh', ['api', '--paginate', '--slurp', `repos/${armotusitioRepository}/releases?per_page=100`])), pkg.version);
	// Rehearsals must also build the revision they announce, rather than labelling stale metadata as the next tag.
	releaseAction(plan, overrides.armotusitioUpdate.revision, head);
	await appendFile(process.env.GITHUB_OUTPUT, `tag=${plan.tag}\ncommit=${head}\n`);
	console.log(`${rehearsal ? 'Rehearsal of' : 'Release'} ${plan.tag} from ${head}${plan.previous ? ` (previous ${plan.previous})` : ''}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, ...flags] = process.argv.slice(2);
	if (command !== 'prepare' || flags.some(flag => flag !== '--rehearsal')) {
		console.error('Usage: node scripts/ats-release-ci.mts prepare [--rehearsal]');
		process.exitCode = 1;
	} else {
		prepare(flags.includes('--rehearsal')).catch(error => {
			console.error(error instanceof Error ? error.message : 'Release preparation failed.');
			process.exitCode = 1;
		});
	}
}
