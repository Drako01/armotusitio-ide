/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
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
  assert.equal(call.args[2], 'workspace-write');
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

test('approved agent runs a fake CLI without shell or provider network', { skip: process.platform === 'win32' }, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-agent-e2e-'));
  const originalPath = process.env.PATH;
  try {
    const cli = path.join(folder, 'codex');
    await fs.writeFile(cli, '#!/usr/bin/env node\nlet input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { console.log("SAFE_AGENT", process.argv.slice(2).join(" "), input.includes("Review API changes")); });\n', { mode: 0o755 });
    await fs.chmod(cli, 0o755);
    process.env.PATH = folder + path.delimiter + (originalPath || '');
    const current = { ...base, projectRoot: await fs.realpath(folder) };
    const execution = await executeReviewedAgent(reviewAgentDraft(current), current, 10000);
    const result = await execution.outcome;
    assert.equal(result.status, 'passed');
    assert.match(result.output, /SAFE_AGENT exec --sandbox read-only/);
    assert.match(result.output, /true/);
  } finally {
    if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
    await fs.rm(folder, { recursive: true, force: true });
  }
});
