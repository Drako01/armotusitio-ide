/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { proposeProjectConfig, writeProjectConfig, loadProjectConfig, validateProjectConfig, generatedConfigDigest, removeGeneratedProjectConfig } from '../src/native-project.ts';

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-native-project-'));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

test('Node proposal has no side effects, uses declared npm script', async () => fixture(async root => {
	await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', deploy: 'bad' } }));
	const proposal = await proposeProjectConfig(root);
	assert.equal(proposal.config.profile, 'node');
	assert.deepEqual(proposal.config.plan.gates[0].args, ['run', 'test']);
	assert.equal(await loadProjectConfig(root), undefined);
}));

test('Go and PHP profile detection without running tools', async () => fixture(async root => {
	await fs.writeFile(path.join(root, 'go.mod'), 'module example.org/project\n');
	assert.equal((await proposeProjectConfig(root)).config.profile, 'go');
	await fs.rm(path.join(root, 'go.mod'));
	await fs.writeFile(path.join(root, 'composer.json'), '{}');
	assert.deepEqual((await proposeProjectConfig(root)).config.plan.gates[0].args, ['-v']);
}));

test('exclusive config creation and existing config preserved', async () => fixture(async root => {
	const proposal = await proposeProjectConfig(root);
	await writeProjectConfig(root, proposal.config);
	assert.deepEqual(await loadProjectConfig(root), proposal.config);
	await assert.rejects(writeProjectConfig(root, proposal.config), error => (error as NodeJS.ErrnoException).code === 'EEXIST');
	assert.equal((await proposeProjectConfig(root)).existing, true);
}));

test('reject incompatible schema and unsafe symlink manifest', async () => fixture(async root => {
	assert.throws(() => validateProjectConfig({ schemaVersion: 2 }), /HARNESS_CONFIG_SCHEMA/);
	const external = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-external-'));
	try {
		await fs.writeFile(path.join(external, 'data.json'), '{}');
		await fs.symlink(path.join(external, 'data.json'), path.join(root, '.ats-harness.json'));
		await assert.rejects(loadProjectConfig(root), /HARNESS_PROJECT_FILE_UNSAFE/);
	} finally {
		await fs.rm(external, { recursive: true, force: true });
	}
}));


test('configuration generation yields to any project Harness marker', async () => fixture(async root => {
	const proposal = await proposeProjectConfig(root);
	await fs.mkdir(path.join(root, 'harness'));
	await assert.rejects(writeProjectConfig(root, proposal.config), /HARNESS_PROJECT_AUTHORITY/);
	assert.equal(await loadProjectConfig(root), undefined);
}));

test('remove only the generated unchanged configuration, preserve foreign files', async () => fixture(async root => {
	const config = (await proposeProjectConfig(root)).config;
	await writeProjectConfig(root, config);
	const digest = generatedConfigDigest(config);
	await fs.writeFile(path.join(root, 'foreign.txt'), 'keep');
	await fs.appendFile(path.join(root, '.ats-harness.json'), ' ');
	await assert.rejects(removeGeneratedProjectConfig(root, digest), /HARNESS_CONFIG_CHANGED/);
	await fs.writeFile(path.join(root, '.ats-harness.json'), JSON.stringify(config, null, 2) + '\n');
	await removeGeneratedProjectConfig(root, digest);
	assert.deepEqual({ config: await loadProjectConfig(root), foreign: await fs.readFile(path.join(root, 'foreign.txt'), 'utf8') }, { config: undefined, foreign: 'keep' });
}));
