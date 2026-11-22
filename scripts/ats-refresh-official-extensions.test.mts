/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareStableVersions, engineSupports, officialVsixUrl, refreshOfficialExtensions, selectUpdate } from './ats-refresh-official-extensions.mts';

const pinned = {
	name: 'armotusitio.orquestivo', version: '0.2.0', sha256: 'a'.repeat(64),
	downloadUrl: officialVsixUrl('armotusitio.orquestivo', '0.2.0'), repo: 'https://github.com/Drako01/orquestivo.git', license: 'MIT'
};
const registry = { namespace: 'armotusitio', name: 'orquestivo', version: '0.3.0', files: {
	download: officialVsixUrl('armotusitio.orquestivo', '0.3.0'),
	manifest: 'https://open-vsx.org/api/armotusitio/orquestivo/0.3.0/file/package.json'
} };
const manifest = { publisher: 'armotusitio', name: 'orquestivo', version: '0.3.0', license: 'MIT', engines: { vscode: '^1.144.0' } };

test('stable semantic version selection and engine constraints are conservative', () => {
	assert.equal(compareStableVersions('0.3.0', '0.2.9'), 1);
	assert.equal(compareStableVersions('0.3.0', '0.3.0'), 0);
	assert.equal(engineSupports('^1.144.0', '1.147.0'), true);
	assert.equal(engineSupports('^1.148.0', '1.147.0'), false);
	assert.equal(engineSupports('>=1.140.0 <2.0.0', '1.147.0'), true);
	assert.equal(engineSupports('^1.144.0 || ^2.0.0', '1.147.0'), false);
	assert.equal(selectUpdate(pinned, registry, manifest, '1.147.0').version, '0.3.0');
	assert.equal(selectUpdate(pinned, { ...registry, preRelease: true }, manifest, '1.147.0'), null);
	assert.equal(selectUpdate(pinned, { ...registry, version: '0.2.0' }, manifest, '1.147.0'), null);
	assert.equal(selectUpdate(pinned, registry, { ...manifest, engines: { vscode: '^1.148.0' } }, '1.147.0'), null);
	assert.throws(() => selectUpdate(pinned, { ...registry, namespace: 'attacker' }, manifest, '1.147.0'), /identity/);
	assert.throws(() => selectUpdate(pinned, { ...registry, files: { ...registry.files, download: 'https://example.com/extension.vsix' } }, manifest, '1.147.0'), /URL/);
});

function withUrl(url, response) { Object.defineProperty(response, 'url', { value: url }); return response; }
function jsonResponse(url, value) { return withUrl(url, new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })); }

async function fixture(fn) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'ats-ext-refresh-'));
	const manifestPath = path.join(root, 'official.json'), productPath = path.join(root, 'product.json');
	await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, extensions: [pinned] }, null, '\t') + '\n');
	await writeFile(productPath, JSON.stringify({ version: '1.147.0' }));
	try { await fn({ manifestPath, productPath }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('refresh verifies registry identity, package manifest and downloaded VSIX digest', async () => {
	await fixture(async ({ manifestPath, productPath }) => {
		const vsix = Buffer.from('504b0304f00d', 'hex');
		const digest = createHash('sha256').update(vsix).digest('hex');
		const fetchImpl = async url => {
			if (url === 'https://open-vsx.org/api/armotusitio/orquestivo') { return jsonResponse(url, registry); }
			if (url === registry.files.manifest) { return jsonResponse(url, manifest); }
			if (url === registry.files.download) { return withUrl(url, new Response(vsix, { status: 200 })); }
			throw new Error('Unexpected URL: ' + url);
		};
		assert.equal(await refreshOfficialExtensions({ manifestPath, productPath, fetchImpl }), 1);
		const after = JSON.parse(await readFile(manifestPath, 'utf8')).extensions[0];
		assert.deepEqual({ version: after.version, sha256: after.sha256, downloadUrl: after.downloadUrl }, { version: '0.3.0', sha256: digest, downloadUrl: registry.files.download });
		assert.equal(await refreshOfficialExtensions({ manifestPath, productPath, fetchImpl }), 0);
	});
});

test('network, archive and identity failures never partially rewrite pinned manifest', async () => {
	await fixture(async ({ manifestPath, productPath }) => {
		const original = await readFile(manifestPath, 'utf8');
		const fetchImpl = async url => {
			if (url.endsWith('/orquestivo')) { return jsonResponse(url, registry); }
			if (url === registry.files.manifest) { return jsonResponse(url, manifest); }
			return withUrl(url, new Response('not a zip', { status: 200 }));
		};
		await assert.rejects(refreshOfficialExtensions({ manifestPath, productPath, fetchImpl }), /VSIX header/);
		assert.equal(await readFile(manifestPath, 'utf8'), original);
	});
});
