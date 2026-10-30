/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { parseSmokeArgs, classifySmokeFailure } from '../../../scripts/ats-harness-real-provider-smoke.mts';

test('real provider smoke cannot run without precise opt-in arguments', () => {
	for (const args of [
		[], ['--provider', 'codex'], ['--provider', 'claude'],
		['--provider', 'codex', '--yes'], ['--provider', 'other', '--acknowledge-real-model-call'],
		['--provider', 'codex', '--acknowledge-real-model-call', '--run-again']
	]) {
		assert.throws(() => parseSmokeArgs(args), /HARNESS_REAL_SMOKE_EXPLICIT_APPROVAL_REQUIRED/);
	}
	assert.deepEqual(parseSmokeArgs(['--provider', 'codex', '--acknowledge-real-model-call']), { provider: 'codex', approved: true });
	assert.deepEqual(parseSmokeArgs(['--provider', 'claude', '--acknowledge-real-model-call']), { provider: 'claude', approved: true });
});

test('real provider smoke defaults to help without contacting a provider', () => {
	const script = path.resolve(import.meta.dirname, '../../../scripts/ats-harness-real-provider-smoke.mts');
	const help = execFileSync(process.execPath, [script, '--help'], {
		encoding: 'utf8', timeout: 10000, windowsHide: true
	});
	assert.match(help, /exactly one read-only model request/);
	assert.match(help, /NOT certify an operating-system sandbox/);
});

test('smoke errors are classified without emitting raw provider output', () => {
	assert.equal(classifySmokeFailure("error: unexpected argument '--ask-for-approval' found", 2), 'cli-arguments');
	assert.equal(classifySmokeFailure('Please log in to continue', 1), 'authentication');
	assert.equal(classifySmokeFailure('Rate limit exceeded', 1), 'quota');
	assert.equal(classifySmokeFailure('some arbitrary message with private content', 1), 'provider-failed');
	assert.equal(classifySmokeFailure('HARNESS_REVIEW: FAIL', 0), 'review-not-approved');
});
