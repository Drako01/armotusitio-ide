/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { queryProjectEngineStatus } from '../src/native-engine-interop.ts';

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
