/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { armotusitioProduct as product } from '../build/lib/armotusitioProduct.ts';
import { validateIdentity } from './ats-linux-artifacts.mts';
import { exclusiveReleaseWorkflow } from './ats-autoupdate.mts';

test('WSL template and server identity bind the release revision and full client commit', () => {
	const commit = 'a'.repeat(40);
	const values: Record<string, string> = { version: '1.143.0', commit, release: product.release, quality: 'stable', os: 'linux', arch: 'arm64' };
	const url = product.serverDownloadUrlTemplate.replace(/\$\{(\w+)\}/g, (_, key) => values[key]);
	assert.equal(url, `https://github.com/Drako01/armotusitio-ide/releases/download/ats-v1.143.0-r${product.release}/ArmotuSitio-IDE-REH-linux-arm64-${commit}.tar.gz`);
	assert.ok(!url.includes('${'));
	validateIdentity({ ...product, commit, version: '1.143.0' }, commit, '1.143.0');
	for (const field of ['commit', 'version', 'quality', 'release', 'serverApplicationName', 'serverDataFolderName', 'serverDownloadUrlTemplate']) {
		assert.throws(() => validateIdentity({ ...product, commit, version: '1.143.0', [field]: 'mismatch' }, commit, '1.143.0'));
	}
});

test('future release CI cannot publish from a branch, another repository, or alongside an active old workflow', () => {
	const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Drako01/armotusitio-ide', GITHUB_WORKFLOW: 'ArmotuSitio Release', GITHUB_REF: 'refs/tags/ats-v1.143.0-r2' };
	const workflows = { total_count: 2, workflows: [{ state: 'active', path: '.github/workflows/ats-release.yml' }, { state: 'disabled_manually', path: '.github/workflows/old.yml' }] };
	assert.equal(exclusiveReleaseWorkflow(env, workflows), true);
	for (const changed of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_WORKFLOW: 'Other' }, { GITHUB_REF: 'refs/heads/main' }]) { assert.equal(exclusiveReleaseWorkflow({ ...env, ...changed }, workflows), false); }
	assert.equal(exclusiveReleaseWorkflow(env, { ...workflows, total_count: 101 }), false);
	assert.equal(exclusiveReleaseWorkflow(env, { total_count: 2, workflows: workflows.workflows.map(entry => ({ ...entry, state: 'active' })) }), false);
});
