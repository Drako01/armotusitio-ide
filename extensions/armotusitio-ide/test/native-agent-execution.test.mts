/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildAgentInvocation, executeReviewedAgent } from '../src/native-agent-execution.ts';
import { reviewAgentDraft } from '../src/native-providers.ts';

const base = { schemaVersion: 1 as const, provider: 'codex' as const, role: 'reviewer' as const,
  projectRoot: path.resolve('native-agent-test'), instruction: 'Review API changes', readOnly: true };

test('Codex uses a bounded sandbox instead of approval bypass', () => {
  const call = buildAgentInvocation(base);
  assert.equal(call.executable, 'codex');
  assert.deepEqual(call.args, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-']);
  assert.match(call.stdin, /Review API changes/);
  assert.ok(!call.args.some(x => x.includes('danger') || x.includes('yolo')));
});

test('implementer is restricted to workspace-write, never danger-full-access', () => {
  const call = buildAgentInvocation({ ...base, role: 'implementer', readOnly: false });
  assert.equal(call.args[3], 'workspace-write');
  assert.throws(() => buildAgentInvocation({ ...base, role: 'reviewer', readOnly: false }), /HARNESS_READ_ONLY_ROLE_REQUIRED/);
  assert.throws(() => buildAgentInvocation({ ...base, role: 'implementer', readOnly: true }), /HARNESS_IMPLEMENTER_MODE_MISMATCH/);
});

test('Claude uses plan for readers and fail-closed dontAsk for writers', () => {
  const reader = buildAgentInvocation({ ...base, provider: 'claude' });
  const writer = buildAgentInvocation({ ...base, provider: 'claude', role: 'implementer', readOnly: false });
  assert.equal(reader.args[2], 'plan');
  assert.equal(writer.args[2], 'dontAsk');
  assert.ok(!writer.args.includes('--dangerously-skip-permissions'));
});

test('a changed review or invalid duration never starts an agent', async () => {
  const review = reviewAgentDraft(base);
  await assert.rejects(executeReviewedAgent(review, { ...base, instruction: 'Other task' }), /HARNESS_AGENT_REVIEW_CHANGED/);
  await assert.rejects(executeReviewedAgent(review, base, -5), /HARNESS_AGENT_TIMEOUT_INVALID/);
});
