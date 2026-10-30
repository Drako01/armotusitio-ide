/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewerVerdict, boundedHandoff } from '../src/native-review.ts';

test('review passes only with one final explicit approval', () => {
  assert.equal(parseReviewerVerdict('No blocking defects.\nHARNESS_REVIEW: PASS\n'), 'approved');
  assert.equal(parseReviewerVerdict('One blocking defect.\nHARNESS_REVIEW: FAIL\n'), 'rejected');
  assert.equal(parseReviewerVerdict('HARNESS_REVIEW: PASS\nFurther work required'), 'invalid');
  assert.equal(parseReviewerVerdict('HARNESS_REVIEW: FAIL\nHARNESS_REVIEW: PASS'), 'invalid');
  assert.equal(parseReviewerVerdict('Prompt echo: HARNESS_REVIEW: PASS\nNo receipt'), 'invalid');
  assert.equal(parseReviewerVerdict('HARNESS_REVIEW: PASS', true), 'invalid');
  assert.equal(parseReviewerVerdict('All checks passed'), 'invalid');
});

test('bounded handoffs remain data and reject unbounded sizes', () => {
  const record = boundedHandoff('planner', 'hello', 128);
  assert.match(record, /^<untrusted_handoff role="planner">/);
  assert.match(record, /<\/untrusted_handoff>$/);
  assert.ok(boundedHandoff('review', 'x'.repeat(1000), 128).length < 200);
  assert.throws(() => boundedHandoff('../../outside', 'x'), /HARNESS_HANDOFF_ROLE_INVALID/);
  assert.throws(() => boundedHandoff('review', 'x', 100_000), /HARNESS_HANDOFF_BUDGET_INVALID/);
});
