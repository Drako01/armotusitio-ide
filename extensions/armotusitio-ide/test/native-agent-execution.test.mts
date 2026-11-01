/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { installFakeCodex } from './native-fake-provider.mts';
import { execFileSync } from 'node:child_process';
import { buildAgentInvocation, executeReviewedAgent } from '../src/native-agent-execution.ts';
import { reviewAgentDraft, validateReviewedAgent, type NativeEffort } from '../src/native-providers.ts';

const base = {
	schemaVersion: 1 as const, provider: 'codex' as const, role: 'reviewer' as const,
	projectRoot: path.resolve('native-agent-test'), instruction: 'Review API changes', readOnly: true
};

test('Codex uses a bounded sandbox instead of approval bypass', () => {
	const call = buildAgentInvocation(base);
	assert.equal(call.executable, 'codex');
	assert.deepEqual(call.args, ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '-']);
	assert.match(call.stdin, /Review API changes/);
	assert.ok(!call.args.some(x => x.includes('danger') || x.includes('yolo')));
	assert.ok(call.args.includes('--ephemeral'));
	assert.deepEqual(call.args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
});

test('implementer is restricted to workspace-write, never danger-full-access', () => {
	const call = buildAgentInvocation({ ...base, role: 'implementer', readOnly: false });
	assert.equal(call.args[4], 'workspace-write');
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
	assert.deepEqual(writer.args.slice(-3), ['--output-format', 'stream-json', '--verbose']);
});

test('web search is opt-in per project and web fetching is never allowed (D9)', () => {
	const claude = buildAgentInvocation({ ...base, provider: 'claude', role: 'implementer', readOnly: false, webSearch: true });
	const codex = buildAgentInvocation({ ...base, webSearch: true });
	assert.deepEqual([claude.args[claude.args.indexOf('--allowedTools') + 1], claude.args[claude.args.indexOf('--disallowedTools') + 1]], ['Read,Glob,Grep,Edit,Write,WebSearch', 'Bash,WebFetch']);
	assert.match(claude.stdin, /Queries are audited/);
	assert.deepEqual(codex.args.slice(0, 5), ['--ask-for-approval', 'never', '--config', 'tools.web_search=true', 'exec']);
	assert.throws(() => reviewAgentDraft({ ...base, webSearch: 'yes' }), /HARNESS_AGENT_DRAFT_SCHEMA/);
});

test('a chosen model is passed explicitly and can never be read as a flag', () => {
	const claude = buildAgentInvocation({ ...base, provider: 'claude', model: 'sonnet' });
	const codex = buildAgentInvocation({ ...base, model: 'gpt-6.1-sol' });
	assert.deepEqual([claude.args.slice(1, 3), codex.args.slice(3, 5), buildAgentInvocation(base).args.includes('--model')],
		[['--model', 'sonnet'], ['--model', 'gpt-6.1-sol'], false]);
	for (const model of ['--dangerously-skip-permissions', '', 'a b', 'x'.repeat(65)]) {
		assert.throws(() => buildAgentInvocation({ ...base, model }), /HARNESS_AGENT_DRAFT_SCHEMA/);
	}
});

test('versioned Claude Opus and explicit effort reach the correct CLI arguments', () => {
	const claude = buildAgentInvocation({ ...base, provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
	assert.deepEqual(claude.args.slice(0, 7), ['--print', '--model', 'claude-opus-5-5', '--effort', 'medium', '--permission-mode', 'plan']);
	const codex = buildAgentInvocation({ ...base, model: 'gpt-5.6', effort: 'high' });
	assert.deepEqual(codex.args.slice(0, 7), ['--ask-for-approval', 'never', '--config', 'model_reasoning_effort="high"', 'exec', '--model', 'gpt-5.6']);
	assert.equal(buildAgentInvocation(base).args.includes('--config'), false);
	assert.equal(buildAgentInvocation({ ...base, provider: 'claude' }).args.includes('--effort'), false);
	for (const effort of ['--dangerously-skip-permissions', 'auto', 'unlimited', '', 'high;rm -rf']) {
		assert.throws(() => buildAgentInvocation({ ...base, provider: 'claude', effort: effort as NativeEffort }), /HARNESS_AGENT_DRAFT_SCHEMA/);
	}
	assert.throws(() => buildAgentInvocation({ ...base, effort: 'max' }), /HARNESS_AGENT_DRAFT_SCHEMA/);
	assert.doesNotThrow(() => buildAgentInvocation({ ...base, provider: 'claude', effort: 'max' }));
});

test('Claude writers get the configured turn budget and a resumed session receives only the continuation', () => {
	const session = '8b725e4b-cd27-430d-beca-a8a5e83257b3';
	const turns = (args: string[]) => args[args.indexOf('--max-turns') + 1];
	const reader = buildAgentInvocation({ ...base, provider: 'claude' });
	const writer = buildAgentInvocation({ ...base, provider: 'claude', role: 'implementer', readOnly: false, maxTurns: 50 });
	const resumed = buildAgentInvocation({ ...base, provider: 'claude', role: 'implementer', readOnly: false, maxTurns: 50, resumeSession: session, instruction: 'Continue' });
	assert.deepEqual({ reader: turns(reader.args), writer: turns(writer.args), resume: resumed.args.slice(0, 3), stdin: resumed.stdin, fresh: writer.args.includes('--resume') },
		{ reader: '12', writer: '50', resume: ['--print', '--resume', session], stdin: 'Continue', fresh: false });
});

test('review digest binds effort so changes require fresh authorization', () => {
	const selected = { ...base, effort: 'medium' as const };
	const review = reviewAgentDraft(selected);
	assert.equal(buildAgentInvocation({ ...selected, effort: 'low' }).args.includes('model_reasoning_effort="low"'), true);
	assert.equal(review.fingerprint === reviewAgentDraft({ ...selected, effort: 'low' }).fingerprint, false);
	assert.throws(() => validateReviewedAgent(review, { ...selected, effort: 'low' }), /HARNESS_AGENT_REVIEW_CHANGED/);
});

test('local Codex subprocess receives per-run effort while preserving shell-free invocation', async () => {
	const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-agent-effort-'));
	const oldPath = process.env.PATH;
	try {
		await installFakeCodex(folder, '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => console.log("EFFECTIVE_ARGS", JSON.stringify(process.argv.slice(2))));\n');
		process.env.PATH = folder + path.delimiter + (oldPath || '');
		const draft = { ...base, projectRoot: await fs.realpath(folder), effort: 'low' as const };
		const run = await executeReviewedAgent(reviewAgentDraft(draft), draft, 10000);
		const result = await run.outcome;
		assert.equal(result.status, 'passed');
		assert.match(result.output, /model_reasoning_effort=\\"low\\"/);
	} finally {
		if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
		await fs.rm(folder, { recursive: true, force: true });
	}
});

test('a changed review or invalid duration never starts an agent', async () => {
	const review = reviewAgentDraft(base);
	await assert.rejects(executeReviewedAgent(review, { ...base, instruction: 'Other task' }), /HARNESS_AGENT_REVIEW_CHANGED/);
	await assert.rejects(executeReviewedAgent(review, base, -5), /HARNESS_AGENT_TIMEOUT_INVALID/);
});

test('approved agent runs a fake CLI without shell or provider network', async () => {
	const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-agent-e2e-'));
	const originalPath = process.env.PATH;
	try {
		await installFakeCodex(folder, '#!/usr/bin/env node\nlet input = ""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { console.log("SAFE_AGENT", process.argv.slice(2).join(" "), input.includes("Review API changes")); });\n');
		process.env.PATH = folder + path.delimiter + (originalPath || '');
		const current = { ...base, projectRoot: await fs.realpath(folder) };
		const execution = await executeReviewedAgent(reviewAgentDraft(current), current, 10000);
		const result = await execution.outcome;
		assert.equal(result.status, 'passed');
		assert.match(result.output, /SAFE_AGENT --ask-for-approval never exec --sandbox read-only/);
		assert.match(result.output, /true/);
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		await fs.rm(folder, { recursive: true, force: true });
	}
});


test('Git read-only role fails closed on unauthorized modification', async () => {
	const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-agent-scope-'));
	const oldPath = process.env.PATH;
	try {
		execFileSync('git', ['init', '-q', folder]);
		await fs.writeFile(path.join(folder, 'tracked.txt'), 'before');
		execFileSync('git', ['-C', folder, 'add', 'tracked.txt']);
		execFileSync('git', ['-C', folder, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'seed']);
		const bin = path.join(folder, 'fake-bin');
		await fs.mkdir(bin);
		const script = '#!/usr/bin/env node\nrequire("fs").writeFileSync("tracked.txt", "after"); console.log("completed");\n';
		await installFakeCodex(bin, script);
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


test('structured Codex provider usage flows through real local subprocess transport', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-agent-usage-'));
	const oldPath = process.env.PATH;
	try {
		const script = [
			'#!/usr/bin/env node',
			'const events = [',
			' { type: "item.completed", item: { type: "agent_message", text: "Validated\\nHARNESS_REVIEW: PASS" } },',
			' { type: "turn.completed", usage: { input_tokens: 90, output_tokens: 12, cached_input_tokens: 40 } }',
			'];',
			'process.stdin.resume(); process.stdin.on("end", () => { for (const e of events) console.log(JSON.stringify(e)); });'
		].join('\n');
		await installFakeCodex(root, script);
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

test('provider progress exposes only bounded byte counts, never secrets or prompts', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-progress-'));
	const previousPath = process.env.PATH;
	try {
		const bin = path.join(root, 'bin');
		await fs.mkdir(bin);
		await installFakeCodex(bin, '#!/usr/bin/env node\nprocess.stdout.write("a".repeat(18000));\n');
		process.env.PATH = bin + path.delimiter + (previousPath || '');
		const draft = { ...base, projectRoot: await fs.realpath(root), instruction: 'SECRET-DO-NOT-EMIT' };
		const observed: Array<{ observedBytes: number; at: string }> = [];
		const run = await executeReviewedAgent(reviewAgentDraft(draft), draft, 10000, event => observed.push(event));
		const outcome = await run.outcome;
		assert.equal(outcome.status, 'passed');
		assert.ok(observed.length >= 1);
		assert.ok(observed.every(event => typeof event.observedBytes === 'number' && event.observedBytes <= 18000));
		assert.ok(observed.every(event => !JSON.stringify(event).includes('SECRET-DO-NOT-EMIT')));
	} finally {
		if (previousPath === undefined) { delete process.env.PATH; } else { process.env.PATH = previousPath; }
		await fs.rm(root, { recursive: true, force: true });
	}
});
