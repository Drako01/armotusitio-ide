/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import base from '../../../product.json' with { type: 'json' };
import manifest from '../../armotusitio/official-extensions.json' with { type: 'json' };
import { officialExtensions, parseOfficialExtensions, withOfficialExtensions } from '../armotusitioOfficialExtensions.ts';
import { armotusitioProduct } from '../armotusitioProduct.ts';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { fromVsix } from '../extensions.ts';
import type File from 'vinyl';

test('six exact official release pins compose additively with upstream builtins and stable auto updates', () => {
	assert.deepEqual(officialExtensions.map(extension => [extension.name, extension.version]), [
		['armotusitio.orquestivo', '0.1.1'], ['armotusitio.probato-pr', '1.0.1'], ['armotusitio.indizivo', '0.3.0'],
		['armotusitio.saturivo', '0.2.2'], ['armotusitio.noditrivo', '0.1.1'], ['armotusitio.vestigivo', '0.1.2']
	]);
	assert.deepEqual(armotusitioProduct.builtInExtensions, [...base.builtInExtensions, ...officialExtensions]);
	assert.deepEqual(armotusitioProduct.builtInExtensions.slice(0, base.builtInExtensions.length), base.builtInExtensions);
	assert.equal(armotusitioProduct.quality, 'stable');
	assert.ok(officialExtensions.every(extension => armotusitioProduct.builtInExtensionsEnabledWithAutoUpdates.includes(extension.name)));
	assert.deepEqual(armotusitioProduct.autoUpdateBuiltinExtensionsByDefault, officialExtensions.map(extension => extension.name));
	assert.ok(base.builtInExtensionsEnabledWithAutoUpdates.every(id => armotusitioProduct.builtInExtensionsEnabledWithAutoUpdates.includes(id)));
	assert.ok(officialExtensions.every(extension => !extension.metadata.id && !extension.metadata.publisherId));
});

test('official pin validation fails closed for wrong identity, duplicate, count, version, digest or source', () => {
	const changes: Array<(value: typeof manifest) => void> = [
		value => { value.schemaVersion = 2; },
		value => { value.extensions.pop(); },
		value => { value.extensions[0].name = 'armotusitio.vestigivo-rca'; },
		value => { value.extensions[1] = { ...value.extensions[0] }; },
		value => { value.extensions[0].version = 'latest'; },
		value => { value.extensions[0].version = '1.0.0-beta'; },
		value => { value.extensions[0].sha256 = '0'.repeat(63); },
		value => { value.extensions[0].sha256 = 'Z'.repeat(64); },
		value => { value.extensions[0].downloadUrl = value.extensions[0].downloadUrl.replace('https:', 'http:'); },
		value => { value.extensions[0].downloadUrl += '?token=secret'; },
		value => { value.extensions[0].downloadUrl = value.extensions[0].downloadUrl.replace('open-vsx.org', 'open-vsx.org.example.com'); },
		value => { value.extensions[0].downloadUrl = value.extensions[1].downloadUrl; },
		value => { value.extensions[0].repo = 'https://user:secret@github.com/Drako01/orquestivo.git'; },
		value => { value.extensions[0].license = 'unknown'; }
	];
	for (const change of changes) {
		const value = structuredClone(manifest);
		change(value);
		assert.throws(() => parseOfficialExtensions(value), /ARMOTUSITIO_OFFICIAL_EXTENSIONS_INVALID/);
	}
	for (const value of [null, [], {}, { schemaVersion: 1, extensions: [null] }]) {
		assert.throws(() => parseOfficialExtensions(value), /ARMOTUSITIO_OFFICIAL_EXTENSIONS_INVALID/);
	}
});

test('upstream identity collisions fail closed rather than replacing an independently supplied extension', () => {
	assert.throws(() => withOfficialExtensions([officialExtensions[0]]), /upstream identity collision/);
	assert.throws(() => withOfficialExtensions([{ ...officialExtensions[0], name: officialExtensions[0].name.toUpperCase() }]), /upstream identity collision/);
	assert.equal(withOfficialExtensions([]).length, 6);
});

test('the existing offline VSIX packaging stream includes executable contents, license and publisher metadata', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'ats-official-vsix-'));
	try {
		const zip = new ZipFile();
		const pinned = officialExtensions[0];
		const packageJson = { name: 'orquestivo', publisher: 'armotusitio', version: pinned.version, main: './dist/index.js', engines: { vscode: '^1.99.0' } };
		zip.addBuffer(Buffer.from(JSON.stringify(packageJson)), 'extension/package.json');
		zip.addBuffer(Buffer.from('module.exports.activate = () => undefined;'), 'extension/dist/index.js');
		zip.addBuffer(Buffer.from('MIT fixture license'), 'extension/LICENSE.txt');
		const file = path.join(directory, 'extension.vsix');
		const hash = createHash('sha256');
		zip.outputStream.on('data', chunk => hash.update(chunk));
		const written = finished(zip.outputStream.pipe(createWriteStream(file)));
		zip.end();
		await written;
		const files: File[] = [];
		const output = fromVsix(file, { ...pinned, sha256: hash.digest('hex') });
		await new Promise<void>((resolve, reject) => output.on('data', (entry: File) => files.push(entry)).once('end', resolve).once('error', reject));
		assert.deepEqual(files.map(entry => entry.relative.replace(/\\/g, '/')).sort(), ['LICENSE.txt', 'dist/index.js', 'package.json']);
		const packaged = JSON.parse(files.find(entry => entry.basename === 'package.json')!.contents!.toString());
		assert.deepEqual(packaged, { ...packageJson, __metadata: pinned.metadata });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
