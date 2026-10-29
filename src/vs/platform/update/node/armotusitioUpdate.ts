/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { verify } from 'crypto';
import { armotusitioManifestName, armotusitioReleaseTag, armotusitioRepository, compareArmotusitioVersions, isUpdateRecord, parseArmotusitioManifest } from '../common/armotusitioUpdate.js';
import type { IUpdate } from '../common/update.js';

export interface ArmotusitioUpdateTrust {
	repository: string;
	publicKey: string;
	revision: number;
}

/** Authenticate the release before allowing the native updater to download an executable. */
export async function resolveArmotusitioUpdate(
	release: unknown,
	trust: ArmotusitioUpdateTrust,
	currentVersion: string,
	currentCommit: string,
	platform: string,
	requestJSON: (url: string) => Promise<unknown>
): Promise<IUpdate | null> {
	if (trust.repository !== armotusitioRepository || !trust.publicKey || !Number.isSafeInteger(trust.revision) || trust.revision < 0) {
		throw new Error('ArmotuSitio update trust is not configured.');
	}
	if (!isUpdateRecord(release) || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
		throw new Error('Invalid ArmotuSitio GitHub release.');
	}
	const prefix = `https://github.com/${armotusitioRepository}/releases/download/`;
	const metadata = release.assets.filter(asset => isUpdateRecord(asset) && asset.name === armotusitioManifestName);
	if (metadata.length !== 1 || !isUpdateRecord(metadata[0]) || typeof metadata[0].browser_download_url !== 'string'
		|| !metadata[0].browser_download_url.startsWith(prefix) || Number(metadata[0].size) > 131072) {
		throw new Error('Missing or invalid signed update metadata.');
	}
	const envelope = await requestJSON(metadata[0].browser_download_url);
	if (!isUpdateRecord(envelope) || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string'
		|| envelope.payload.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload)
		|| !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) {
		throw new Error('Invalid signed update envelope.');
	}
	const payload = Buffer.from(envelope.payload, 'base64');
	if (!verify(null, payload, trust.publicKey, Buffer.from(envelope.signature, 'base64'))) {
		throw new Error('ArmotuSitio update signature is invalid.');
	}
	const manifest = parseArmotusitioManifest(JSON.parse(payload.toString('utf8')));
	const tag = armotusitioReleaseTag(manifest);
	if (release.tag_name !== tag || metadata[0].browser_download_url !== `${prefix}${tag}/${armotusitioManifestName}`) {
		throw new Error('The update does not belong to this release.');
	}
	const versionOrder = compareArmotusitioVersions(manifest.baseVersion, currentVersion);
	if (versionOrder < 0 || (versionOrder === 0 && manifest.revision <= trust.revision) || manifest.commit === currentCommit) {
		return null;
	}
	const artifact = manifest.assets[platform];
	if (!artifact) {
		return null;
	}
	const assets = release.assets.filter(asset => isUpdateRecord(asset) && asset.name === artifact.name);
	const url = `${prefix}${tag}/${artifact.name}`;
	if (assets.length !== 1 || !isUpdateRecord(assets[0]) || assets[0].state !== 'uploaded'
		|| assets[0].browser_download_url !== url || assets[0].size !== artifact.size
		|| (assets[0].digest !== undefined && assets[0].digest !== null && assets[0].digest !== `sha256:${artifact.sha256}`)) {
		throw new Error('The signed update artifact does not match the release.');
	}
	return { url, version: manifest.commit, productVersion: `${manifest.baseVersion} (ArmotuSitio r${manifest.revision})`, sha256hash: artifact.sha256 };
}
