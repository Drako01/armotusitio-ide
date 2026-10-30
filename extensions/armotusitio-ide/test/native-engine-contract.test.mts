/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeEngine } from '../src/native-engine-contract.ts';

test('native engine declares implemented features only', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engine-contract-'));
	try {
		const descriptor = await describeEngine(await fs.realpath(root));
		assert.equal(descriptor.schemaVersion, 2);
		assert.equal(descriptor.engine, 'ide-native');
		assert.ok(descriptor.supported.includes('agent-handoffs'));
		assert.ok(descriptor.unavailable.includes('os-sandbox'));
		assert.ok(descriptor.unavailable.includes('cost-accounting'));
		assert.equal(descriptor.executionEnabled, true);
		await fs.mkdir(path.join(root, '.harness'));
		const project = await describeEngine(await fs.realpath(root));
		assert.equal(project.engine, 'project');
		assert.equal(project.requiresExternalHandshake, true);
		assert.deepEqual(project.supported, []);
		assert.deepEqual(project.projectDeclared, []);
		await fs.mkdir(path.join(root, '.harness', 'manifests'));
		const manifestPath = path.join(root, '.harness', 'manifests', 'ide-capabilities.json');
		await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['agent-handoffs', 'parallel-gates'] }));
		const advertised = await describeEngine(await fs.realpath(root));
		assert.deepEqual(advertised.projectDeclared, ['agent-handoffs', 'parallel-gates']);
		assert.deepEqual(advertised.supported, []);
		assert.equal(advertised.executionEnabled, false);
		await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['unknown-capability'] }));
		await assert.rejects(describeEngine(await fs.realpath(root)), /HARNESS_CAPABILITIES_INVALID/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
