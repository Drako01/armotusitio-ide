/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { armotusitioManifestName, armotusitioPlatforms, armotusitioReleaseTag, armotusitioRepository, compareArmotusitioVersions, parseArmotusitioManifest } from '../src/vs/platform/update/common/armotusitioUpdate.ts';
import { fileDigest, selectUpstreamRelease, withLock } from './ats-autoupdate.mts';

// Load this standalone native module for focused tests without building the application.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const nodeSource = await readFile(new URL('../src/vs/platform/update/node/armotusitioUpdate.ts', import.meta.url), 'utf8');
const nativeJS = ts.transpileModule(nodeSource, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
	.replace('../common/armotusitioUpdate.js', new URL('../src/vs/platform/update/common/armotusitioUpdate.ts', import.meta.url).href);
const { resolveArmotusitioUpdate: resolveUpdate } = await import('data:text/javascript;base64,' + Buffer.from(nativeJS).toString('base64'));

function fixture(extraAssets = {}) {
	const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
	const manifest = parseArmotusitioManifest({
		schema: 1, repository: armotusitioRepository, channel: 'stable', revision: 2, baseVersion: '1.143.0',
		commit: 'b'.repeat(40), upstream: { ref: 'main', commit: 'e'.repeat(40) }, publishedAt: new Date().toISOString(), assets: {
			'win32-x64-user': { name: 'setup.exe', size: 42, sha256: 'a'.repeat(64) },
			'win32-x64-archive': { name: 'app.zip', size: 50, sha256: 'c'.repeat(64) }, ...extraAssets
		}
	});
	const tag = armotusitioReleaseTag(manifest);
	const prefix = `https://github.com/${armotusitioRepository}/releases/download/${tag}/`;
	const release = {
		draft: false, prerelease: false, tag_name: tag, assets: [
			{ name: armotusitioManifestName, size: 1024, browser_download_url: prefix + armotusitioManifestName },
			...Object.values(manifest.assets).map(asset => ({ name: asset.name, size: asset.size, digest: `sha256:${asset.sha256}`, state: 'uploaded', browser_download_url: prefix + asset.name }))
		]
	};
	const payload = Buffer.from(JSON.stringify(manifest));
	const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
	const trust = { repository: armotusitioRepository, publicKey: keys.publicKey, revision: 1 };
	const resolve = (platform = 'win32-x64-user', version = '1.143.0', commit = 'd'.repeat(40)) => resolveUpdate(release, trust, version, commit, platform, async () => envelope);
	return { manifest, release, envelope, trust, resolve };
}

test('select only a newer numeric stable upstream release', () => {
	assert.equal(compareArmotusitioVersions('1.100.0', '1.99.0'), 1);
	const releases = [{ tag_name: '1.144.0', draft: false, prerelease: false }, { tag_name: '1.145.0', draft: false, prerelease: true }, { tag_name: '1.146.0', draft: true, prerelease: false }];
	assert.equal(selectUpstreamRelease(releases, '1.143.0')?.tag, '1.144.0');
	assert.equal(selectUpstreamRelease(releases, '1.150.0'), undefined);
	assert.throws(() => compareArmotusitioVersions('1.143.0-insider', '1.143.0'));
});

test('a signed release resolves both installer and archive without executing either', async () => {
	const f = fixture();
	for (const platform of armotusitioPlatforms) {
		const update = await f.resolve(platform);
		assert.equal(update.version, f.manifest.commit);
		assert.equal(update.sha256hash, f.manifest.assets[platform].sha256);
	}
});

test('signed Linux assets are optional for legacy manifests and authenticated before offering a download', async () => {
	assert.equal(await fixture().resolve('linux-x64-archive'), null);
	const f = fixture({ 'linux-x64-archive': { name: 'linux.tar.gz', size: 99, sha256: 'b'.repeat(64) }, 'server-linux-arm64': { name: 'reh-arm64.tar.gz', size: 88, sha256: 'e'.repeat(64) } });
	assert.equal((await f.resolve('linux-x64-archive')).sha256hash, 'b'.repeat(64));
	assert.equal(f.manifest.assets['server-linux-arm64'].size, 88);
	assert.throws(() => fixture({ 'linux-x64-archive': { name: 'bad.exe', size: 99, sha256: 'b'.repeat(64) } }), /Invalid update asset/);
});

test('reject altered metadata and a different signing key', async () => {
	const f = fixture();
	f.envelope.payload = Buffer.from(JSON.stringify({ ...f.manifest, revision: 3 })).toString('base64');
	await assert.rejects(f.resolve(), /signature/);
	const other = fixture();
	other.trust.publicKey = f.trust.publicKey;
	await assert.rejects(other.resolve(), /signature/);
});

test('reject artifact replacement, external download URLs, and ambiguous metadata', async () => {
	const f = fixture();
	f.release.assets[1].size++;
	await assert.rejects(f.resolve(), /does not match/);
	const external = fixture();
	external.release.assets[1].browser_download_url = 'https://example.com/setup.exe';
	await assert.rejects(external.resolve(), /does not match/);
	const duplicate = fixture();
	duplicate.release.assets.push(duplicate.release.assets[0]);
	await assert.rejects(duplicate.resolve(), /metadata/);
});

test('never downgrade, reinstall the same revision, or mix unsupported platforms', async () => {
	const f = fixture();
	assert.equal(await f.resolve('win32-x64-user', '1.144.0'), null);
	assert.equal(await f.resolve('win32-arm64-user'), null);
	assert.equal(await f.resolve('win32-x64-user', '1.143.0', f.manifest.commit), null);
	f.trust.revision = 2;
	assert.equal(await f.resolve(), null);
});

test('reject drafts, prereleases, malformed paths and commits', async () => {
	const f = fixture();
	f.release.draft = true;
	await assert.rejects(f.resolve(), /release/);
	assert.throws(() => parseArmotusitioManifest({ ...f.manifest, commit: '../../run.exe' }));
	assert.throws(() => parseArmotusitioManifest({ ...f.manifest, upstream: { ref: '../unknown', commit: 'e'.repeat(40) } }));
	assert.throws(() => parseArmotusitioManifest({ ...f.manifest, assets: { ...f.manifest.assets, 'win32-x64-user': { name: '../setup.exe', sha256: 'a'.repeat(64), size: 42 } } }));
});

test('a live operation prevents a concurrent run and releases its lock', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'ats-update-test-'));
	try {
		await withLock(directory, async () => {
			await assert.rejects(withLock(directory, async () => 1), /already running/);
		});
		assert.equal(await withLock(directory, async () => 7), 7);
		const data = path.join(directory, 'artifact');
		await writeFile(data, 'signed artifact');
		assert.equal(await fileDigest(data), createHash('sha256').update('signed artifact').digest('hex'));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('the Open VSX verifier accepts signed contents and rejects changed packages and signatures', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'ats-openvsx-sign-test-'));
	try {
		const { ZipFile } = await import('yazl');
		const { sign: signPackage, verify: verifyPackage } = await import('node-ovsx-sign');
		const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
		const privatePath = path.join(directory, 'private.pem');
		const publicPath = path.join(directory, 'public.pem');
		await writeFile(privatePath, keys.privateKey, { mode: 0o600 });
		await writeFile(publicPath, keys.publicKey);
		async function createVSIX(file: string, contents: string): Promise<void> {
			const zip = new ZipFile();
			const writing = pipeline(zip.outputStream, createWriteStream(file));
			zip.addBuffer(Buffer.from(JSON.stringify({ name: 'test-icons', publisher: 'armotusitio-test', version: '1.0.0', engines: { vscode: '^1.100.0' } })), 'extension/package.json');
			zip.addBuffer(Buffer.from('<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="test-icons" Version="1.0.0" Publisher="armotusitio-test" /></Metadata></PackageManifest>'), 'extension.vsixmanifest');
			zip.addBuffer(Buffer.from(contents), 'extension/icon.svg');
			zip.end();
			await writing;
		}
		const original = path.join(directory, 'original.vsix');
		const altered = path.join(directory, 'altered.vsix');
		const signature = path.join(directory, 'signature.sigzip');
		await createVSIX(original, '<svg>original</svg>');
		await createVSIX(altered, '<svg>altered</svg>');
		await signPackage(original, privatePath, { output: signature });
		const options = { publicKey: publicPath, verifySignatureManifest: true };
		assert.equal(await verifyPackage(original, signature, false, options), true);
		await assert.rejects(verifyPackage(altered, signature, false, options));
		await writeFile(signature, 'corrupt signature');
		await assert.rejects(verifyPackage(original, signature, false, options));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('an unrelated repository, wrong tag and unconfigured trust cannot produce an update', async () => {
	const f = fixture();
	f.trust.repository = 'another/repository';
	await assert.rejects(f.resolve(), /trust/);
	const tag = fixture();
	tag.release.tag_name = 'ats-v1.143.0-r99';
	await assert.rejects(tag.resolve(), /release/);
	const unconfigured = fixture();
	unconfigured.trust.publicKey = '';
	await assert.rejects(unconfigured.resolve(), /trust/);
});

test('packaged bootstrap loads without build files; development merges its distribution configuration', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'ats-bootstrap-test-'));
	const previous = process.env.VSCODE_DEV;
	try {
		const source = await readFile(new URL('../src/bootstrap-meta.ts', import.meta.url), 'utf8');
		const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
		for (const development of [false, true]) {
			const root = path.join(directory, development ? 'dev' : 'packaged');
			await mkdir(path.join(root, 'out'), { recursive: true });
			await writeFile(path.join(root, 'package.json'), '{"version":"1.143.0"}');
			await writeFile(path.join(root, 'product.json'), JSON.stringify(development ? { nameShort: 'ArmotuSitio' } : { nameShort: 'ArmotuSitio', extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' } }));
			if (development) {
				process.env.VSCODE_DEV = '1';
				await mkdir(path.join(root, 'build', 'armotusitio'), { recursive: true });
				await writeFile(path.join(root, 'build', 'armotusitio', 'product-overrides.json'), JSON.stringify({ extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' } }));
			} else {
				delete process.env.VSCODE_DEV;
			}
			const entry = path.join(root, 'out', 'bootstrap-meta.mjs');
			await writeFile(entry, compiled);
			const { product } = await import(pathToFileURL(entry).href);
			assert.equal(product.extensionsGallery.serviceUrl, 'https://open-vsx.org/vscode/gallery');
		}
	} finally {
		if (previous === undefined) {
			delete process.env.VSCODE_DEV;
		} else {
			process.env.VSCODE_DEV = previous;
		}
		await rm(directory, { recursive: true, force: true });
	}
});
