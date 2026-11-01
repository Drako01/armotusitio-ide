/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { reviewAgentDraft, validateReviewedAgent, validateHandoffPlan, inspectAgentWorkspace, localVerificationPlan } from '../src/native-providers.ts';

const draft = { schemaVersion: 1 as const, provider: 'codex' as const, role: 'reviewer' as const, projectRoot: '/tmp/workspace', instruction: 'Review the implementation', readOnly: true };

test('provider review never creates a CLI invocation', () => {
	const review = reviewAgentDraft(draft);
	assert.deepEqual(review.argv, []);
	validateReviewedAgent(review, draft);
	assert.throws(() => validateReviewedAgent(review, { ...draft, instruction: 'Changed' }), /HARNESS_AGENT_REVIEW_CHANGED/);
});

test('draft rejects unsupported provider and unbounded instruction', () => {
	assert.throws(() => reviewAgentDraft({ ...draft, provider: 'shell' }), /HARNESS_AGENT_DRAFT_SCHEMA/);
	assert.throws(() => reviewAgentDraft({ ...draft, instruction: 'x'.repeat(321 * 1024) }), /HARNESS_AGENT_DRAFT_SCHEMA/);
});

test('draft bounds the turn budget and only lets a Claude implementer resume a well-formed session', () => {
	const session = '8b725e4b-cd27-430d-beca-a8a5e83257b3';
	const writer = { ...draft, provider: 'claude' as const, role: 'implementer' as const, readOnly: false };
	assert.doesNotThrow(() => reviewAgentDraft({ ...writer, maxTurns: 150, resumeSession: session }));
	for (const invalid of [{ maxTurns: 0 }, { maxTurns: 151 }, { maxTurns: 1.5 }, { resumeSession: 'last' }, { resumeSession: '--dangerously-skip-permissions' }]) {
		assert.throws(() => reviewAgentDraft({ ...writer, ...invalid }), /HARNESS_AGENT_DRAFT_SCHEMA/);
	}
	assert.throws(() => reviewAgentDraft({ ...writer, provider: 'codex', resumeSession: session }), /HARNESS_AGENT_DRAFT_SCHEMA/);
	assert.throws(() => reviewAgentDraft({ ...draft, provider: 'claude', resumeSession: session }), /HARNESS_AGENT_DRAFT_SCHEMA/);
});

test('multi-agent dependencies reject cycles and missing handoffs', () => {
	const plan = { schemaVersion: 1 as const, handoffs: [
		{ id: 'plan', role: 'planner' as const, provider: 'claude' as const, dependsOn: [], instruction: 'Plan only' },
		{ id: 'review', role: 'reviewer' as const, provider: 'codex' as const, dependsOn: ['plan'], instruction: 'Review' },
	] };
	assert.equal(validateHandoffPlan(plan).handoffs.length, 2);
	assert.throws(() => validateHandoffPlan({ ...plan, handoffs: [{ ...plan.handoffs[0], dependsOn: ['review'] }, plan.handoffs[1]] }), /HARNESS_HANDOFF_CYCLE/);
	assert.throws(() => validateHandoffPlan({ ...plan, handoffs: [{ ...plan.handoffs[0], dependsOn: ['missing'] }] }), /HARNESS_HANDOFF_DEPENDENCY/);
});

test('inventory excludes hidden files and links', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-providers-'));
	try {
		await fs.writeFile(path.join(root, 'README.md'), 'readable');
		await fs.writeFile(path.join(root, '.env'), 'secret');
		await fs.symlink(path.join(root, 'README.md'), path.join(root, 'alias'));
		assert.deepEqual((await inspectAgentWorkspace(root)).topLevel, ['README.md']);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verification plans must satisfy native validation', () => {
	assert.deepEqual(localVerificationPlan([{ executable: 'npm', args: ['test'] }]).gates[0].args, ['test']);
	assert.throws(() => localVerificationPlan([{ executable: 'sh;rm', args: [] }]), /HARNESS/);
});
