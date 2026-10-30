/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeAgentWorkflow, workflowDigest } from '../src/native-agent-workflow.ts';
import assert from 'node:assert/strict';
import { planAgentWaves, executeAgentDAG, validateDAGReviewCoverage } from '../src/native-agent-dag.ts';
import type { HandoffPlan } from '../src/native-providers.ts';

const plan: HandoffPlan = {
	schemaVersion: 1,
	handoffs: [
		{ id: 'inspect_a', role: 'planner', provider: 'codex', dependsOn: [], instruction: 'Inspect A' },
		{ id: 'inspect_b', role: 'planner', provider: 'claude', dependsOn: [], instruction: 'Inspect B' },
		{ id: 'write', role: 'implementer', provider: 'codex', dependsOn: ['inspect_a', 'inspect_b'], instruction: 'Implement' },
		{ id: 'review', role: 'reviewer', provider: 'claude', dependsOn: ['write'], instruction: 'Review' }
	]
};

test('DAG permits concurrent readers but always isolates writers', () => {
	assert.deepEqual(planAgentWaves(plan), [
		{ ids: ['inspect_a', 'inspect_b'], readOnly: true },
		{ ids: ['write'], readOnly: false },
		{ ids: ['review'], readOnly: true }
	]);
	assert.throws(() => planAgentWaves(plan, 0), /HARNESS_DAG_CONCURRENCY_INVALID/);
	assert.throws(() => planAgentWaves(plan, 100), /HARNESS_DAG_CONCURRENCY_INVALID/);
});

test('DAG does not execute dependent work when one upstream reader fails', async () => {
	const started: string[] = [];
	const result = await executeAgentDAG(plan, async handoff => {
		started.push(handoff.id);
		return handoff.id === 'inspect_b' ? 'failed' : 'passed';
	});
	assert.deepEqual(started.sort(), ['inspect_a', 'inspect_b']);
	assert.equal(result.some(item => item.id === 'write'), false);
});

test('DAG preserves write exclusivity and permits subsequent review', async () => {
	let running = 0;
	let maxRunning = 0;
	let writing = false;
	const result = await executeAgentDAG(plan, async handoff => {
		running++;
		maxRunning = Math.max(maxRunning, running);
		assert.equal(handoff.role === 'implementer' ? running === 1 : !writing, true);
		if (handoff.role === 'implementer') { writing = true; }
		await new Promise(resolve => setTimeout(resolve, 4));
		if (handoff.role === 'implementer') { writing = false; }
		running--;
		return 'passed';
	});
	assert.equal(maxRunning, 2);
	assert.deepEqual(result.map(item => item.status), ['passed', 'passed', 'passed', 'passed']);
});

test('workflow launches two independent read-only providers before exclusive implementer', { skip: process.platform === 'win32' }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-dag-integration-'));
	const oldPath = process.env.PATH;
	const traceFile = path.join(os.tmpdir(), 'ats-dag-trace-' + path.basename(root) + '.txt');
	try {
		const canonical = await fs.realpath(root);
		const bin = path.join(root, 'bin');
		await fs.mkdir(bin);
		const executable = path.join(bin, 'codex');
		const source = [
			'#!/usr/bin/env node',
			'let input = "";',
			'process.stdin.on("data", chunk => input += chunk);',
			'process.stdin.on("end", () => {',
			' const fs = require("node:fs");',
			' const role = input.includes("This is a read-only assignment") ? (input.includes("DAG_READER_A") ? "reader_a" : input.includes("DAG_READER_B") ? "reader_b" : "review") : "writer";',
			' fs.appendFileSync(' + JSON.stringify(traceFile) + ', "start " + role + "\\n");',
			' setTimeout(() => { fs.appendFileSync("trace.txt", "end " + role + "\\n"); console.log(role === "review" ? "HARNESS_REVIEW: PASS" : "done"); }, role.startsWith("reader") ? 80 : 5);',
			'});'
		].join('\n');
		await fs.writeFile(executable, source, { mode: 0o755 });
		await fs.chmod(executable, 0o755);
		process.env.PATH = bin + path.delimiter + (oldPath || '');
		const graph: HandoffPlan = {
			schemaVersion: 1, handoffs: [
				{ id: 'reader_a', role: 'planner', provider: 'codex', dependsOn: [], instruction: 'DAG_READER_A inspect source' },
				{ id: 'reader_b', role: 'planner', provider: 'codex', dependsOn: [], instruction: 'DAG_READER_B inspect tests' },
				{ id: 'writer', role: 'implementer', provider: 'codex', dependsOn: ['reader_a', 'reader_b'], instruction: 'DAG_WRITE implement' },
				{ id: 'review', role: 'reviewer', provider: 'codex', dependsOn: ['writer'], instruction: 'Read-only review; print HARNESS_REVIEW: PASS' }
			]
		};
		const workflow = new NativeAgentWorkflow(canonical, path.join(root, 'private'));
		const run = await workflow.start(graph, workflowDigest(canonical, graph), () => true);
		const result = await run.result;
		assert.equal(result.status, 'passed');
		const trace = (await fs.readFile(traceFile, 'utf8')).trim().split('\n');
		assert.ok(trace.indexOf('start reader_b') < trace.indexOf('end reader_a'));
		assert.ok(trace.indexOf('start reader_a') < trace.indexOf('end reader_b'));
		assert.ok(trace.indexOf('start writer') > trace.indexOf('end reader_a'));
		assert.ok(trace.indexOf('start writer') > trace.indexOf('end reader_b'));
		assert.equal((await workflow.history())[0].events?.at(-1)?.kind, 'workflow-finished');
	} finally {
		if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
		await fs.rm(traceFile, { force: true });
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('DAG blocks unreviewed writes before launching agents', () => {
	validateDAGReviewCoverage(plan);
	const unsafe: HandoffPlan = {
		schemaVersion: 1, handoffs: [
			{ id: 'read_a', role: 'planner', provider: 'codex', dependsOn: [], instruction: 'Read A' },
			{ id: 'read_b', role: 'planner', provider: 'claude', dependsOn: [], instruction: 'Read B' },
			{ id: 'unreviewed_writer', role: 'implementer', provider: 'codex', dependsOn: ['read_a', 'read_b'], instruction: 'Write' }
		]
	};
	assert.throws(() => validateDAGReviewCoverage(unsafe), /HARNESS_DAG_REVIEW_REQUIRED/);
});
