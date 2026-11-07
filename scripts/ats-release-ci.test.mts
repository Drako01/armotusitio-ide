/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { releaseAction } from './ats-release-ci.mts';
import { planReleaseRevision } from './ats-release-revision.mts';

const published = (tag: string) => ({ tag_name: tag, draft: false, published_at: '2026-11-01T10:00:00Z' });
const head = 'a'.repeat(40);

test('release CI commits the next revision once, then publishes and resumes only its own draft', () => {
	const plan = planReleaseRevision([[published('ats-v1.145.2-r1'), published('ats-v1.145.0-r3')]], '1.145.2');
	const resumable = planReleaseRevision([[published('ats-v1.145.2-r1'), { tag_name: 'ats-v1.145.2-r2', draft: true, target_commitish: head }]], '1.145.2');
	const foreign = planReleaseRevision([[{ tag_name: 'ats-v1.145.2-r1', draft: true, target_commitish: 'b'.repeat(40) }]], '1.145.2');
	assert.deepEqual({
		tag: plan.tag,
		stale: releaseAction(plan, 1, head),
		current: releaseAction(plan, 2, head),
		resume: releaseAction(resumable, 2, head),
		firstOfVersion: planReleaseRevision([[published('ats-v1.144.1-r7')]], '1.145.2').tag,
	}, { tag: 'ats-v1.145.2-r2', stale: 'prepare-metadata', current: 'publish', resume: 'publish', firstOfVersion: 'ats-v1.145.2-r1' });
	assert.throws(() => releaseAction(foreign, 1, head), /targets another commit/);
});
