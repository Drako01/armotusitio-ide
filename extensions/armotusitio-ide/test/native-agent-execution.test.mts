/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildAgentInvocation, executeReviewedAgent } from '../src/native-agent-execution.ts';
import { reviewAgentDraft } from '../src/native-providers.ts';

const base = { schemaVersion: 1 as const, provider: 'codex' as const, role: 'reviewer' as const,
  projectRoot: path.resolve('native-agent-test'), instruction: 'Review API changes', readOnly: true };

test('Codex uses a bounded sandbox instead of approval bypass', () => {
  const call = buildAgentInvocation(base);
  assert.equal(call.executable, 'codex');
  assert.deepEqual(call.args, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ask-for-approval', 'never', '--ephemeral', '--json', '-']);
  assert.match(call.stdin, /Review API changes/);
  assert.ok(!call.args.some(x => x.includes('danger') || x.includes('yolo')));
  assert.ok(call.args.includes('--ephemeral'));
  assert.deepEqual(call.args.slice(-5), ['--ask-for-approval', 'never', '--ephemeral', '--json', '-']);
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
  assert.ok(writer.args.includes('Read,Glob,Grep,Edit,Write'));
  assert.ok(writer.args.includes('Bash,WebFetch,WebSearch'));
  assert.ok(!reader.args.includes('Read,Glob,Grep,Edit,Write'));
  assert.ok(!writer.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(writer.args.slice(-2), ['--output-format', 'json']);
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


test('Git read-only role fails closed on unauthorized modification', { skip: process.platform === 'win32' }, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-agent-scope-'));
  const oldPath = process.env.PATH;
  try {
    execFileSync('git', ['init', '-q', folder]);
    await fs.writeFile(path.join(folder, 'tracked.txt'), 'before');
    execFileSync('git', ['-C', folder, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', folder, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'seed']);
    const bin = path.join(folder, 'fake-bin');
    await fs.mkdir(bin);
    const cli = path.join(bin, 'codex');
    const script = '#!/usr/bin/env node\nrequire("fs").writeFileSync("tracked.txt", "after"); console.log("completed");\n';
    await fs.writeFile(cli, script, { mode: 0o755 });
    await fs.chmod(cli, 0o755);
    process.env.PATH = bin + path.delimiter + (oldPath || '');
    const draft = { ...base, projectRoot: await fs.realpath(folder) };
    const run = await executeReviewedAgent(reviewAgentDraft(draft), draft, 10000);
    const outcome = await run.outcome;
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.scopeViolation, true);
    assert.equal(outcome.scopeVerified, true);
    assert.equal(await fs.readFile(path.join(folder, 'tracked.txt'), 'utf8'), 'after');
  } finally {
    if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
    await fs.rm(folder, { recursive: true, force: true });
  }
});


test('structured Codex provider usage flows through real local subprocess transport', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-agent-usage-'));
  const oldPath = process.env.PATH;
  try {
    const cli = path.join(root, 'codex');
    const script = [
      '#!/usr/bin/env node',
      'const events = [',
      ' { type: "item.completed", item: { type: "agent_message", text: "Validated\\nHARNESS_REVIEW: PASS" } },',
      ' { type: "turn.completed", usage: { input_tokens: 90, output_tokens: 12, cached_input_tokens: 40 } }',
      '];',
      'process.stdin.resume(); process.stdin.on("end", () => { for (const e of events) console.log(JSON.stringify(e)); });'
    ].join('\n');
    await fs.writeFile(cli, script, { mode: 0o755 });
    await fs.chmod(cli, 0o755);
    process.env.PATH = root + path.delimiter + (oldPath || '');
    const current = { ...base, projectRoot: await fs.realpath(root) };
    const run = await executeReviewedAgent(reviewAgentDraft(current), current, 10000);
    const outcome = await run.outcome;
    assert.equal(outcome.status, 'passed');
    assert.equal(outcome.structuredOutput, true);
    assert.equal(outcome.output, 'Validated\nHARNESS_REVIEW: PASS');
    assert.deepEqual(outcome.usage, { inputTokens: 90, outputTokens: 12, cachedInputTokens: 40 });
  } finally {
    if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
