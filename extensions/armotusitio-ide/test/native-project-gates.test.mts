/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readProjectGateCatalog, validateProjectGateCatalog, planProjectGateWaves } from '../src/native-project-gates.ts';

test('project gates are discovered as bounded read-only metadata and pin a digest', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-project-gates-'));
	try {
		const canonical = await fs.realpath(root);
		assert.equal(await readProjectGateCatalog(canonical), undefined);
		const folder = path.join(root, '.harness', 'manifests');
		await fs.mkdir(folder, { recursive: true });
		const file = path.join(folder, 'ide-gates.json');
		const plan = { schemaVersion: 1, gates: [
			{ id: 'lint', dependsOn: [], resources: ['cpu'] },
			{ id: 'tests', dependsOn: ['lint'], resources: ['db'] }
		] };
		await fs.writeFile(file, JSON.stringify(plan));
		const catalog = await readProjectGateCatalog(canonical);
		assert.ok(catalog);
		assert.deepEqual(catalog.gates.map(gate => gate.id), ['lint', 'tests']);
		assert.equal(catalog.executionEnabled, false);
		assert.equal(JSON.stringify(catalog).includes('executable'), false);
		await validateProjectGateCatalog(canonical, catalog.digest);
		await fs.writeFile(file, JSON.stringify({ ...plan, gates: [plan.gates[0]] }));
		await assert.rejects(validateProjectGateCatalog(canonical, catalog.digest), /HARNESS_GATE_CATALOG_CHANGED/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('gate catalog rejects command injection, dangling dependencies and DAG cycles', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-gate-invalid-'));
	try {
		const canonical = await fs.realpath(root);
		const dir = path.join(root, '.harness', 'manifests');
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, 'ide-gates.json');
		const write = async (gates: unknown[]) => fs.writeFile(file, JSON.stringify({ schemaVersion: 1, gates }));
		await write([{ id: 'lint', dependsOn: [], resources: [], command: 'curl example.com' }]);
		await assert.rejects(readProjectGateCatalog(canonical), /HARNESS_GATE_CATALOG_INVALID/);
		await write([{ id: 'lint', dependsOn: ['missing'], resources: [] }]);
		await assert.rejects(readProjectGateCatalog(canonical), /HARNESS_GATE_CATALOG_DEPENDENCY/);
		await write([{ id: 'lint', dependsOn: ['tests'], resources: [] },
			{ id: 'tests', dependsOn: ['lint'], resources: [] }]);
		await assert.rejects(readProjectGateCatalog(canonical), /HARNESS_GATE_CATALOG_CYCLE/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('gate catalog rejects linked manifest parents and preserves external files', async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-gate-linked-'));
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-gate-external-'));
	try {
		await fs.mkdir(path.join(root, '.harness'));
		await fs.writeFile(path.join(outside, 'ide-gates.json'),
			JSON.stringify({ schemaVersion: 1, gates: [] }));
		try {
			await fs.symlink(outside, path.join(root, '.harness', 'manifests'),
				process.platform === 'win32' ? 'junction' : 'dir');
		} catch (error) {
			if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) {
				t.skip('Creating directory links requires OS privileges');
				return;
			}
			throw error;
		}
		await assert.rejects(readProjectGateCatalog(await fs.realpath(root)), /HARNESS_GATE_CATALOG_UNSAFE/);
		assert.ok((await fs.readFile(path.join(outside, 'ide-gates.json'), 'utf8')).includes('schemaVersion'));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	}
});

test('read-only gate scheduler honors dependencies, resource conflicts and capacity', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-gate-waves-'));
	try {
		const canonical = await fs.realpath(root);
		const manifests = path.join(root, '.harness', 'manifests');
		await fs.mkdir(manifests, { recursive: true });
		await fs.writeFile(path.join(manifests, 'ide-gates.json'), JSON.stringify({
			schemaVersion: 1, gates: [
				{ id: 'lint', dependsOn: [], resources: ['cpu'] },
				{ id: 'audit', dependsOn: [], resources: ['cpu'] },
				{ id: 'check', dependsOn: [], resources: ['network'] },
				{ id: 'tests', dependsOn: ['lint'], resources: ['db'] }
			]
		}));
		const catalog = await readProjectGateCatalog(canonical);
		assert.ok(catalog);
		assert.deepEqual(planProjectGateWaves(catalog, 2), [['lint', 'check'], ['audit', 'tests']]);
		assert.deepEqual(planProjectGateWaves(catalog, 1), [['lint'], ['audit'], ['check'], ['tests']]);
		assert.throws(() => planProjectGateWaves(catalog, 0), /HARNESS_GATE_CAPACITY_INVALID/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('gate planner refuses forged in-memory resources and undeclared dependencies', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-gate-forgery-'));
	try {
		const canonical = await fs.realpath(root);
		const folder = path.join(root, '.harness', 'manifests');
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(path.join(folder, 'ide-gates.json'), JSON.stringify({
			schemaVersion: 1, gates: [{ id: 'lint', dependsOn: [], resources: [] }]
		}));
		const valid = await readProjectGateCatalog(canonical);
		assert.ok(valid);
		assert.throws(() => planProjectGateWaves({
			...valid, gates: [{ id: 'lint', dependsOn: ['ghost'], resources: [] }]
		}), /HARNESS_GATE_CATALOG_DEPENDENCY/);
		assert.throws(() => planProjectGateWaves({
			...valid, gates: [{ id: 'lint', dependsOn: [], resources: ['cpu; rm -rf'] }]
		}), /HARNESS_GATE_CATALOG_INVALID/);
		assert.throws(() => planProjectGateWaves({
			...valid, digest: 'not-a-digest'
		}), /HARNESS_GATE_CATALOG_INVALID/);
		assert.throws(() => planProjectGateWaves({
			...valid, ...Object.fromEntries([['executionGranted', true]])
		}), /HARNESS_GATE_CATALOG_INVALID/);
		assert.throws(() => planProjectGateWaves({
			...valid, gates: [{ id: 'lint', dependsOn: [], resources: [], command: 'node evil.js' }] as never
		}), /HARNESS_GATE_CATALOG_INVALID/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
