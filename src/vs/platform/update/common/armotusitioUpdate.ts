/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const armotusitioRepository = 'Drako01/armotusitio-ide';
export const armotusitioManifestName = 'armotusitio-update.json';
export const armotusitioPlatforms = ['win32-x64-user', 'win32-x64-archive'] as const;

export interface ArmotusitioAsset {
	name: string;
	sha256: string;
	size: number;
}

export interface ArmotusitioManifest {
	schema: 1;
	repository: string;
	channel: 'stable';
	revision: number;
	baseVersion: string;
	commit: string;
	publishedAt: string;
	upstream?: { ref: string; commit: string };
	assets: Record<string, ArmotusitioAsset>;
}

/** Narrow untrusted JSON without accepting arrays or null. */
export function isUpdateRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStableVersion(value: unknown): value is string {
	return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)
		&& value.split('.').every(part => Number.isSafeInteger(Number(part)));
}

/** Compare numeric release versions; prereleases need an explicit transition. */
export function compareArmotusitioVersions(left: string, right: string): number {
	if (![left, right].every(isStableVersion)) {
		throw new Error('Expected a stable numeric version.');
	}
	const a = left.split('.').map(Number);
	const b = right.split('.').map(Number);
	return Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** Validate signed content before using any field in paths, URLs or commands. */
export function parseArmotusitioManifest(value: unknown): ArmotusitioManifest {
	if (!isUpdateRecord(value) || value.schema !== 1 || value.repository !== armotusitioRepository || value.channel !== 'stable'
		|| !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
		|| !isStableVersion(value.baseVersion)
		|| typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)
		|| typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))
		|| Date.parse(value.publishedAt) > Date.now() + 86400000 || !isUpdateRecord(value.assets)) {
		throw new Error('Invalid ArmotuSitio update manifest.');
	}
	const assets: Record<string, ArmotusitioAsset> = {};
	const upstream = value.upstream;
	if (upstream !== undefined && (!isUpdateRecord(upstream) || typeof upstream.ref !== 'string'
		|| !/^(main|v?\d+\.\d+\.\d+)$/.test(upstream.ref) || typeof upstream.commit !== 'string' || !/^[a-f0-9]{40}$/.test(upstream.commit))) {
		throw new Error('Invalid upstream provenance.');
	}
	for (const platform of armotusitioPlatforms) {
		const asset = value.assets[platform];
		const extension = platform.endsWith('archive') ? '.zip' : '.exe';
		if (!isUpdateRecord(asset) || typeof asset.name !== 'string'
			|| !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(asset.name) || !asset.name.endsWith(extension)
			|| typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
			|| !Number.isSafeInteger(asset.size) || Number(asset.size) < 1 || Number(asset.size) > 2147483648) {
			throw new Error(`Invalid update asset: ${platform}`);
		}
		assets[platform] = { name: asset.name, sha256: asset.sha256, size: Number(asset.size) };
	}
	return {
		schema: 1, repository: armotusitioRepository, channel: 'stable', revision: Number(value.revision),
		baseVersion: value.baseVersion, commit: value.commit, publishedAt: value.publishedAt, assets,
		...(isUpdateRecord(upstream) ? { upstream: { ref: String(upstream.ref), commit: String(upstream.commit) } } : {})
	};
}

/** The release tag binds the signed revision to one immutable set of assets. */
export function armotusitioReleaseTag(manifest: Pick<ArmotusitioManifest, 'baseVersion' | 'revision'>): string {
	return `ats-v${manifest.baseVersion}-r${manifest.revision}`;
}
