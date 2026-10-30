/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { delegateProjectGate, queryProjectEngineStatus } from '../src/native-engine-interop.ts';
import { acquireSharedExecutionFence, type SharedExecutionFence } from '../src/native-shared-fence.ts';

async function fixture(forbid: boolean): Promise<{ root: string; cleanup(): Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engine-status-'));
	const folder = path.join(root, '.harness');
	await fs.mkdir(path.join(folder, 'manifests'), { recursive: true });
	await fs.writeFile(path.join(folder, 'manifests', 'ide-capabilities.json'),
		JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['durable-tasks'] }));
	const script = [
		'const nonce = process.argv[process.argv.indexOf("--nonce") + 1];',
		'if (process.argv[2] === "capabilities") console.log(JSON.stringify({schemaVersion:2,nonce,capabilities:["durable-tasks"]}));',
		'else if (process.argv[2] === "ide-status") console.log(JSON.stringify({schemaVersion:2,nonce,executionEnabled:' +
		(forbid ? 'true' : 'false') + ',tasks:[{id:"task_1",status:"running"}]}));'
	].join('\n');
	await fs.writeFile(path.join(folder, 'core.mjs'), script);
	return { root: await fs.realpath(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('project status transport requires consent, nonce, exact schema and never grants writer authority', async () => {
	const subject = await fixture(false);
	try {
		await assert.rejects(queryProjectEngineStatus(subject.root, false, () => true),
			/HARNESS_PROJECT_STATUS_CONSENT_REQUIRED/);
		const observation = await queryProjectEngineStatus(subject.root, true, () => true);
		assert.deepEqual(observation, {
			schemaVersion: 2, executionEnabled: false, tasks: [{ id: 'task_1', status: 'running' }]
		});
	} finally { await subject.cleanup(); }
});

test('a forged project status cannot enable external execution', async () => {
	const subject = await fixture(true);
	try {
		await assert.rejects(queryProjectEngineStatus(subject.root, true, () => true),
			/HARNESS_PROJECT_STATUS_INVALID/);
		await assert.rejects(queryProjectEngineStatus(subject.root, true, () => false),
			/HARNESS_UNTRUSTED_WORKSPACE/);
	} finally { await subject.cleanup(); }
});

/** A real project engine implementing protocol v2 `ide-gate`; `mode` selects a behavior. */
async function gateEngine(mode: 'ok' | 'fail' | 'ignore-fence' | 'slow' | 'mutate'): Promise<{ root: string; cleanup(): Promise<void> }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engine-gate-'));
	const folder = path.join(root, '.harness');
	await fs.mkdir(path.join(folder, 'manifests'), { recursive: true });
	const capabilities = ['verification-gates', 'bounded-processes'];
	await fs.writeFile(path.join(folder, 'manifests', 'ide-capabilities.json'), JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities }));
	await fs.writeFile(path.join(folder, 'manifests', 'ide-gates.json'), JSON.stringify({ schemaVersion: 1, gates: [{ id: 'lint', dependsOn: [], resources: ['cpu'] }] }));
	const script = [
		'import { createHash } from "node:crypto";',
		'import { appendFileSync } from "node:fs";',
		'const arg = name => process.argv[process.argv.indexOf(name) + 1];',
		'const nonce = arg("--nonce");',
		`const mode = ${JSON.stringify(mode)};`,
		'if (process.argv[2] === "capabilities") { console.log(JSON.stringify({ schemaVersion: 2, nonce, capabilities: ' + JSON.stringify(capabilities) + ' })); }',
		'else if (process.argv[2] === "ide-gate") {',
		'	if (mode === "slow") { setTimeout(() => {}, 60000); }',
		'	else {',
		'		if (mode === "mutate") { appendFileSync(new URL(import.meta.url), " "); }',
		'		const epoch = mode === "ignore-fence" ? 0 : Number(arg("--fence-epoch"));',
		'		const evidenceDigest = createHash("sha256").update("lint evidence").digest("hex");',
		'		console.log(JSON.stringify({ schemaVersion: 2, nonce, gate: arg("--gate"), status: mode === "fail" ? "failed" : "passed", durationMs: 5, fenceEpoch: epoch, evidenceDigest }));',
		'	}',
		'}'
	].join('\n');
	await fs.writeFile(path.join(folder, 'core.mjs'), script);
	return { root: await fs.realpath(root), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function withFence<T>(root: string, work: (fence: SharedExecutionFence) => Promise<T>): Promise<T> {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engine-gate-state-'));
	const fence = await acquireSharedExecutionFence(root, storage, 'project');
	try { return await work(fence); }
	finally {
		await fence.release();
		await fs.rm(storage, { recursive: true, force: true });
	}
}

test('protocol v2 delegates one cataloged gate under the IDE fence and returns bounded evidence', async () => {
	const subject = await gateEngine('ok');
	try {
		await withFence(subject.root, async fence => {
			await assert.rejects(delegateProjectGate(subject.root, 'lint', false, () => true, fence), /HARNESS_PROJECT_GATE_CONSENT_REQUIRED/);
			await assert.rejects(delegateProjectGate(subject.root, 'deploy', true, () => true, fence), /HARNESS_PROJECT_GATE_UNKNOWN/);
			const result = await delegateProjectGate(subject.root, 'lint', true, () => true, fence);
			assert.deepEqual(result, { schemaVersion: 2, gate: 'lint', status: 'passed', durationMs: 5, fenceEpoch: fence.epoch, evidenceDigest: result.evidenceDigest });
			assert.match(result.evidenceDigest ?? '', /^[a-f0-9]{64}$/);
		});
	} finally { await subject.cleanup(); }
});

test('delegation reports real failures and rejects engines that ignore the fence or mutate themselves', async () => {
	for (const [mode, expected] of [['fail', 'failed'], ['ignore-fence', /HARNESS_PROJECT_GATE_FENCE_IGNORED/], ['mutate', /HARNESS_PROJECT_STATUS_ENTRY_CHANGED/]] as const) {
		const subject = await gateEngine(mode);
		try {
			await withFence(subject.root, async fence => {
				if (typeof expected === 'string') {
					assert.equal((await delegateProjectGate(subject.root, 'lint', true, () => true, fence)).status, expected);
				} else {
					await assert.rejects(delegateProjectGate(subject.root, 'lint', true, () => true, fence), expected);
				}
			});
		} finally { await subject.cleanup(); }
	}
});

test('delegated gates honor cancellation and deadlines by terminating the engine process', async () => {
	const subject = await gateEngine('slow');
	try {
		await withFence(subject.root, async fence => {
			const controller = new AbortController();
			const pending = delegateProjectGate(subject.root, 'lint', true, () => true, fence, controller.signal);
			setTimeout(() => controller.abort(), 300);
			assert.deepEqual({ ...(await pending), durationMs: 0 }, { schemaVersion: 2, gate: 'lint', status: 'cancelled', durationMs: 0, fenceEpoch: fence.epoch, evidenceDigest: null });
			await assert.rejects(delegateProjectGate(subject.root, 'lint', true, () => true, fence, undefined, 1000), /HARNESS_PROJECT_GATE_TIMEOUT/);
		});
	} finally { await subject.cleanup(); }
});
