/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { installFakeCodex } from './native-fake-provider.mts';
import * as os from 'node:os';
import { NativeAgentWorkflow, proposedWorkflow, workflowDigest } from '../src/native-agent-workflow.ts';

test('one corrective cycle is bounded and requires independent reviewer reapproval', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-corrective-'));
	const originalPath = process.env.PATH;
	const traceFile = path.join(os.tmpdir(), 'ats-corrective-trace-' + path.basename(root) + '.txt');
	try {
		const bin = path.join(root, 'bin');
		await fs.mkdir(bin);
		const script = [
			'#!/usr/bin/env node',
			'let input = "";',
			'process.stdin.on("data", chunk => input += chunk);',
			'process.stdin.on("end", () => {',
			' const fs = require("node:fs");',
			' const phase = input.includes("Re-evaluate all changes") ? "review-again" : input.includes("One authorized corrective attempt") ? "repair" : input.includes("Read-only audit") ? "review-first" : input.includes("Implement only") ? "implement" : "plan";',
			' fs.appendFileSync(' + JSON.stringify(traceFile) + ', phase + "\\n");',
			' console.log(phase === "review-first" ? "HARNESS_REVIEW: FAIL" : phase === "review-again" ? "HARNESS_REVIEW: PASS" : "stage passed");',
			'});'
		].join('\n');
		await installFakeCodex(bin, script);
		process.env.PATH = bin + path.delimiter + (originalPath || '');
		const canonical = await fs.realpath(root);
		const plan = proposedWorkflow('codex', 'Fix a safe local fixture');
		const workflow = new NativeAgentWorkflow(canonical, path.join(root, 'state'));
		const run = await workflow.start(plan, workflowDigest(canonical, plan), () => true);
		const result = await run.result;
		assert.equal(result.status, 'passed');
		assert.deepEqual(result.steps.map(step => step.status), ['passed', 'passed', 'failed', 'passed', 'passed']);
		assert.equal(await fs.readFile(traceFile, 'utf8'), 'plan\nimplement\nreview-first\nrepair\nreview-again\n');
		assert.equal((await workflow.history())[0].steps.length, 5);
	} finally {
		if (originalPath === undefined) { delete process.env.PATH; } else { process.env.PATH = originalPath; }
		await fs.rm(traceFile, { force: true });
		await fs.rm(root, { recursive: true, force: true });
	}
});
