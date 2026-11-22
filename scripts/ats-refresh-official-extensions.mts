/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const manifestDefault = new URL('../build/armotusitio/official-extensions.json', import.meta.url);
const productDefault = new URL('../package.json', import.meta.url);
const registryRoot = 'https://open-vsx.org/api/armotusitio/';
const maxMetadataBytes = 512 * 1024;
const maxVsixBytes = 64 * 1024 * 1024;

function parts(version) {
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) { return null; }
	return version.split('.').map(BigInt);
}

/** Strict stable releases only; never select prerelease or an unparseable version. */
export function compareStableVersions(a, b) {
	const left = parts(a), right = parts(b);
	if (!left || !right) { throw new Error('Invalid stable extension version'); }
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) { return left[i] > right[i] ? 1 : -1; }
	}
	return 0;
}

/** Conservatively handle common engines.vscode semver ranges; unknown syntax never passes. */
export function engineSupports(range, ideVersion) {
	if (typeof range !== 'string' || !parts(ideVersion)) { return false; }
	const terms = range.trim().split(/\s+/);
	if (!terms.length || terms.some(term => !/^(\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+$/.test(term))) { return false; }
	return terms.every(term => {
		const match = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(term);
		const operator = match[1] || '=';
		const version = match[2];
		const comparison = compareStableVersions(ideVersion, version);
		if (operator === '^') { return comparison >= 0 && parts(ideVersion)[0] === parts(version)[0]; }
		if (operator === '~') { return comparison >= 0 && parts(ideVersion).slice(0, 2).every((value, index) => value === parts(version)[index]); }
		if (operator === '>=') { return comparison >= 0; }
		if (operator === '>') { return comparison > 0; }
		if (operator === '<=') { return comparison <= 0; }
		if (operator === '<') { return comparison < 0; }
		return comparison === 0;
	});
}

export function officialVsixUrl(name, version) {
	if (!/^armotusitio\.[a-z0-9-]+$/.test(name) || !parts(version)) { throw new Error('Invalid official extension identity or version'); }
	const shortName = name.slice('armotusitio.'.length);
	return registryRoot + shortName + '/' + version + '/file/' + name + '-' + version + '.vsix';
}

/** Return null for a non-newer or incompatible version; invalid registry identity fails closed. */
export function selectUpdate(pinned, metadata, manifest, ideVersion) {
	const shortName = pinned.name.slice('armotusitio.'.length);
	const namespace = typeof metadata.namespace === 'string' ? metadata.namespace : metadata.namespace?.name;
	if (namespace !== 'armotusitio' || metadata.name !== shortName) { throw new Error('Open VSX extension identity mismatch: ' + pinned.name); }
	if (!parts(metadata.version) || metadata.preRelease === true || compareStableVersions(metadata.version, pinned.version) <= 0) { return null; }
	if (manifest.publisher !== 'armotusitio' || manifest.name !== shortName || manifest.version !== metadata.version || manifest.license !== 'MIT') {
		throw new Error('Open VSX extension manifest identity or license mismatch: ' + pinned.name);
	}
	if (!engineSupports(manifest.engines?.vscode, ideVersion)) { return null; }
	const downloadUrl = officialVsixUrl(pinned.name, metadata.version);
	if (metadata.files?.download !== downloadUrl) { throw new Error('Unexpected Open VSX VSIX URL: ' + pinned.name); }
	return { ...pinned, version: metadata.version, downloadUrl };
}

function requireRegistryUrl(value, expected) {
	if (value !== expected) { throw new Error('Unexpected Open VSX metadata URL'); }
	return value;
}

async function responseFor(url, fetchImpl) {
	const response = await fetchImpl(url, { signal: AbortSignal.timeout(25_000) });
	if (!response.ok || !response.url.startsWith('https://')) { throw new Error('Open VSX download failed (' + response.status + '): ' + url); }
	return response;
}

async function fetchJson(url, fetchImpl) {
	const response = await responseFor(url, fetchImpl);
	const length = Number(response.headers.get('content-length') || 0);
	if (length > maxMetadataBytes) { throw new Error('Open VSX metadata too large'); }
	const data = await response.text();
	if (Buffer.byteLength(data) > maxMetadataBytes) { throw new Error('Open VSX metadata too large'); }
	return JSON.parse(data);
}

async function hashVsix(url, fetchImpl) {
	const response = await responseFor(url, fetchImpl);
	const length = Number(response.headers.get('content-length') || 0);
	if (length > maxVsixBytes || !response.body) { throw new Error('Invalid VSIX download'); }
	const hash = createHash('sha256');
	let total = 0;
	let signature = Buffer.alloc(0);
	for await (const chunk of response.body) {
		const bytes = Buffer.from(chunk);
		total += bytes.length;
		if (total > maxVsixBytes) { throw new Error('VSIX exceeds size limit'); }
		if (signature.length < 4) { signature = Buffer.concat([signature, bytes]).subarray(0, 4); }
		hash.update(bytes);
	}
	if (signature.length !== 4 || signature.toString('hex') !== '504b0304') { throw new Error('Invalid VSIX header'); }
	return hash.digest('hex');
}

/** Only rewrite a locked manifest after every candidate has passed all checks. */
export async function refreshOfficialExtensions({ manifestPath = manifestDefault, productPath = productDefault, fetchImpl = fetch } = {}) {
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	const product = JSON.parse(await readFile(productPath, 'utf8'));
	if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.extensions) || !parts(product.version)) { throw new Error('Invalid official manifest or IDE version'); }
	let updated = 0;
	const entries = [];
	for (const pinned of manifest.extensions) {
		const shortName = pinned.name.slice('armotusitio.'.length);
		const url = registryRoot + shortName;
		const metadata = await fetchJson(url, fetchImpl);
		const namespace = typeof metadata.namespace === 'string' ? metadata.namespace : metadata.namespace?.name;
		if (namespace !== 'armotusitio' || metadata.name !== shortName) { throw new Error('Open VSX identity mismatch: ' + pinned.name); }
		if (!parts(metadata.version) || metadata.preRelease === true || compareStableVersions(metadata.version, pinned.version) <= 0) { entries.push(pinned); continue; }
		const manifestUrl = requireRegistryUrl(metadata.files?.manifest, url + '/' + metadata.version + '/file/package.json');
		const remoteManifest = await fetchJson(manifestUrl, fetchImpl);
		const candidate = selectUpdate(pinned, metadata, remoteManifest, product.version);
		if (!candidate) { console.log('Skipped incompatible version: ' + pinned.name + '@' + metadata.version); entries.push(pinned); continue; }
		const sha256 = await hashVsix(candidate.downloadUrl, fetchImpl);
		entries.push({ ...candidate, sha256 });
		updated++;
		console.log(pinned.name + ': ' + pinned.version + ' -> ' + candidate.version);
	}
	if (updated) { await writeFile(manifestPath, JSON.stringify({ ...manifest, extensions: entries }, null, '\t') + '\n'); }
	return updated;
}

if (import.meta.main) {
	refreshOfficialExtensions().then(count => console.log('Updated official extensions: ' + count)).catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
