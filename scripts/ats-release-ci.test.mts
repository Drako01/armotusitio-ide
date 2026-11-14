/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { releaseAction } from './ats-release-ci.mts';
import { planReleaseRevision } from './ats-release-revision.mts';

const published = (tag: string) => ({ tag_name: tag, draft: false, published_at: '2026-11-01T10:00:00Z' });
const head = 'a'.repeat(40);

test('release CI only publishes reviewed metadata and resumes its own immutable draft', () => {
	const plan = planReleaseRevision([[published('ats-v1.145.2-r1'), published('ats-v1.145.0-r3')]], '1.145.2');
	const resumable = planReleaseRevision([[published('ats-v1.145.2-r1'), { tag_name: 'ats-v1.145.2-r2', draft: true, target_commitish: head }]], '1.145.2');
	const foreign = planReleaseRevision([[{ tag_name: 'ats-v1.145.2-r1', draft: true, target_commitish: 'b'.repeat(40) }]], '1.145.2');
	assert.deepEqual({
		tag: plan.tag,
		current: releaseAction(plan, 2, head),
		resume: releaseAction(resumable, 2, head),
		firstOfVersion: planReleaseRevision([[published('ats-v1.144.1-r7')]], '1.145.2').tag,
	}, { tag: 'ats-v1.145.2-r2', current: 'publish', resume: 'publish', firstOfVersion: 'ats-v1.145.2-r1' });
	assert.throws(() => releaseAction(plan, 1, head), /metadata-only PR/);
	assert.throws(() => releaseAction(plan, 3, head), /metadata-only PR/);
	assert.throws(() => releaseAction(foreign, 1, head), /targets another commit/);
});

test('a newly published tag invalidates an earlier preparation instead of reusing its revision', () => {
	const plan = planReleaseRevision([[published('ats-v1.145.2-r1'), published('ats-v1.145.2-r2')]], '1.145.2');
	assert.throws(() => releaseAction(plan, 2, head), /requires reviewed revision 3/);
});

test('protected-main release prepare has no source mutation and uses a read-only workflow token', async () => {
	const script = await readFile(new URL('./ats-release-ci.mts', import.meta.url), 'utf8');
	const workflow = await readFile(new URL('../.github/workflows/ats-release.yml', import.meta.url), 'utf8');
	assert.doesNotMatch(script, /git\(['"](?:push|commit|add)|writeReleaseRevision/);
	assert.match(workflow.split('  linux:')[0], /permissions:\s+contents: read/);
	assert.doesNotMatch(workflow.split('  linux:')[0], /contents: write/);
});

test('optional Authenticode is all-or-nothing and Store submission is opt-in, pinned and isolated', async () => {
	const workflow = (await readFile(new URL('../.github/workflows/ats-release.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
	const prepare = workflow.split('  linux:')[0];
	assert.match(prepare, /Partial Authenticode configuration/);
	assert.doesNotMatch(prepare, /Require Windows publisher configuration/);
	for (const step of ['Require signing credentials before building', 'Install pinned Authenticode tools']) {
		assert.match(workflow, new RegExp(`- name: ${step}\\n\\s+if: vars\\.ATS_WINDOWS_PUBLISHER != ''`));
	}
	const submit = workflow.split('  store-submit:')[1];
	assert.ok(submit, 'store-submit job is missing');
	assert.match(submit, /needs: store-msix/);
	assert.match(submit, /vars\.ATS_STORE_PRODUCT_ID != '' && \(needs\.store-msix\.result == 'success'\n\s+\|\| \(github\.event_name == 'workflow_dispatch' && inputs\.store_check_only\)\)/);
	assert.match(prepare, /inputs\.store_release_tag == '' && !inputs\.store_check_only/, 'a credential check must never build a release');
	for (const step of ['actions/download-artifact', 'Verify the MSIX against its packaging receipt', 'Submit the MSIX to Microsoft Store certification']) {
		assert.match(submit, new RegExp(`${step.replaceAll('/', '\\/')}[^\\n]*\\n\\s+if: env\\.STORE_CHECK_ONLY != 'true'`), `${step} must be skipped in check-only mode`);
	}
	assert.match(submit, /environment: microsoft-store/);
	assert.match(submit, /permissions:\s+contents: read/);
	assert.doesNotMatch(submit, /contents: write/);
	assert.match(submit, /microsoft\/microsoft-store-apppublisher@[a-f0-9]{40} /);
	assert.ok(submit.indexOf('packageSha256') < submit.indexOf('msstore publish'), 'MSIX integrity must be checked before submission');
	const reconfigure = submit.indexOf('msstore reconfigure');
	for (const command of ['msstore settings', 'msstore publish', 'msstore apps get', 'msstore submission status']) {
		assert.ok(reconfigure !== -1 && reconfigure < submit.indexOf(command), `${command} fails with "SellerId is not set" before reconfigure`);
	}
	assert.doesNotMatch(submit, /\$\{\{ secrets\.[A-Z_]+ \}\}.*msstore/, 'secrets reach msstore only through env');
});
