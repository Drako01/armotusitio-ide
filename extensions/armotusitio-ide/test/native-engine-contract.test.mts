/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeEngine, probeProjectHandshake, compareHybridCapabilities, verifiedNativeCapabilities } from '../src/native-engine-contract.ts';

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

test('project capability handshake is explicit, nonce-bound and never grants execution authority', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engine-handshake-'));
	try {
		const canonical = await fs.realpath(root);
		await fs.mkdir(path.join(root, '.harness', 'manifests'), { recursive: true });
		await fs.writeFile(path.join(root, '.harness', 'manifests', 'ide-capabilities.json'),
			JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['parallel-gates'] }));
		await fs.writeFile(path.join(root, '.harness', 'core.mjs'), [
			'import { argv } from "node:process";',
			'console.log(JSON.stringify({ schemaVersion: 2, nonce: argv[argv.indexOf("--nonce") + 1], capabilities: ["parallel-gates"] }));'
		].join('\n'));
		await assert.rejects(probeProjectHandshake(canonical, () => false), /HARNESS_UNTRUSTED_WORKSPACE/);
		const response = await probeProjectHandshake(canonical, () => true);
		assert.deepEqual(response, { protocol: 2, reported: ['parallel-gates'] });
		const descriptor = await describeEngine(canonical);
		assert.equal(descriptor.executionEnabled, false);
		assert.deepEqual(descriptor.supported, []);
		await fs.writeFile(path.join(root, '.harness', 'core.mjs'), 'console.log(JSON.stringify({schemaVersion:2,nonce:"forged",capabilities:["parallel-gates"]}));');
		await assert.rejects(probeProjectHandshake(canonical, () => true), /HARNESS_HANDSHAKE_INVALID/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('handshake rejects undeclared response fields even with a valid nonce', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-handshake-fields-'));
	try {
		const canonical = await fs.realpath(root);
		await fs.mkdir(path.join(root, '.harness', 'manifests'), { recursive: true });
		await fs.writeFile(path.join(root, '.harness', 'manifests', 'ide-capabilities.json'),
			JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['parallel-gates'] }));
		await fs.writeFile(path.join(root, '.harness', 'core.mjs'),
			'console.log(JSON.stringify({schemaVersion:2,nonce:process.argv[process.argv.indexOf("--nonce")+1],capabilities:["parallel-gates"],executionGranted:true}));');
		await assert.rejects(probeProjectHandshake(canonical, () => true), /HARNESS_HANDSHAKE_INVALID/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('handshake rejects project entry modified while its own process executes', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-handshake-entry-change-'));
	try {
		const canonical = await fs.realpath(root);
		await fs.mkdir(path.join(root, '.harness', 'manifests'), { recursive: true });
		await fs.writeFile(path.join(root, '.harness', 'manifests', 'ide-capabilities.json'),
			JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['parallel-gates'] }));
		const entry = path.join(root, '.harness', 'core.mjs');
		await fs.writeFile(entry, [
			'import { appendFileSync } from "node:fs";',
			'appendFileSync(".harness/core.mjs", "\\n// modified");',
			'console.log(JSON.stringify({ schemaVersion: 2, nonce: process.argv[process.argv.indexOf("--nonce") + 1], capabilities: ["parallel-gates"] }));'
		].join('\n'));
		await assert.rejects(probeProjectHandshake(canonical, () => true), /HARNESS_HANDSHAKE_ENTRY_CHANGED/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('hybrid capability comparison is read-only and cannot grant execution authority', () => {
	const native = verifiedNativeCapabilities();
	const result = compareHybridCapabilities(native, ['parallel-gates', 'os-sandbox']);
	assert.ok(result.overlap.includes('parallel-gates'));
	assert.deepEqual(result.projectOnly, ['os-sandbox']);
	assert.equal(result.executionGranted, false);
	assert.ok(result.nativeOnly.includes('agent-handoffs'));
	assert.throws(() => compareHybridCapabilities(native, ['unsupported'] as never), /HARNESS_HYBRID_CAPABILITY_INVALID/);
	assert.throws(() => compareHybridCapabilities(native, ['parallel-gates', 'parallel-gates']), /HARNESS_HYBRID_CAPABILITY_INVALID/);
});

test('capability discovery rejects unknown fields and linked manifest parents', async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-capability-manifest-'));
	try {
		const canonical = await fs.realpath(root);
		const manifests = path.join(root, '.harness', 'manifests');
		await fs.mkdir(manifests, { recursive: true });
		const file = path.join(manifests, 'ide-capabilities.json');
		await fs.writeFile(file, JSON.stringify({
			schemaVersion: 2, engine: 'project', capabilities: [], privileged: true
		}));
		await assert.rejects(describeEngine(canonical), /HARNESS_CAPABILITIES_INVALID/);
		await fs.rm(path.join(root, '.harness'), { recursive: true });
		const external = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-capability-escape-'));
		try {
			await fs.mkdir(path.join(external, 'manifests'));
			await fs.writeFile(path.join(external, 'manifests', 'ide-capabilities.json'),
				JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: [] }));
			try {
				await fs.symlink(external, path.join(root, '.harness'), process.platform === 'win32' ? 'junction' : 'dir');
			} catch (error) {
				if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) {
					t.skip('Directory link creation requires OS privileges');
					return;
				}
				throw error;
			}
			await assert.rejects(describeEngine(canonical), /HARNESS_CAPABILITIES_UNSAFE/);
		} finally { await fs.rm(external, { recursive: true, force: true }); }
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('external handshake refuses a manifest changed by the project runner', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-handshake-manifest-change-'));
	try {
		const canonical = await fs.realpath(root);
		const manifests = path.join(root, '.harness', 'manifests');
		await fs.mkdir(manifests, { recursive: true });
		await fs.writeFile(path.join(manifests, 'ide-capabilities.json'),
			JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['parallel-gates'] }));
		await fs.writeFile(path.join(root, '.harness', 'core.mjs'), [
			'import { writeFileSync } from "node:fs";',
			'writeFileSync(".harness/manifests/ide-capabilities.json", JSON.stringify({ schemaVersion: 2, engine: "project", capabilities: [] }));',
			'console.log(JSON.stringify({ schemaVersion: 2, nonce: process.argv[process.argv.indexOf("--nonce") + 1], capabilities: ["parallel-gates"] }));'
		].join('\n'));
		await assert.rejects(probeProjectHandshake(canonical, () => true),
			/HARNESS_HANDSHAKE_CAPABILITIES_CHANGED/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a Harness entered through harness/scripts/ide.mjs declares its capabilities in harness/manifests', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engine-layout-'));
	try {
		const canonical = await fs.realpath(root);
		await fs.mkdir(path.join(root, '.harness'));
		await fs.mkdir(path.join(root, 'harness', 'manifests'), { recursive: true });
		await fs.mkdir(path.join(root, 'harness', 'scripts'));
		await fs.writeFile(path.join(root, 'harness', 'scripts', 'ide.mjs'), '');
		await fs.writeFile(path.join(root, 'harness', 'manifests', 'ide-capabilities.json'),
			JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: ['durable-tasks', 'writer-lease'] }));
		assert.deepEqual((await describeEngine(canonical)).projectDeclared, ['durable-tasks', 'writer-lease']);
		await fs.mkdir(path.join(root, '.harness', 'manifests'));
		await fs.writeFile(path.join(root, '.harness', 'manifests', 'ide-capabilities.json'), JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities: [] }));
		assert.deepEqual((await describeEngine(canonical)).projectDeclared, ['durable-tasks', 'writer-lease']);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
