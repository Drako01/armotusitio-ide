/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import manifest from '../armotusitio/official-extensions.json' with { type: 'json' };
import type { IExtensionDefinition } from './builtInExtensions.ts';

const expectedNames = new Set(['orquestivo', 'probato-pr', 'indizivo', 'saturivo', 'noditrivo', 'vestigivo'].map(name => `armotusitio.${name}`));

function invalid(detail: string): never {
	throw new Error(`ARMOTUSITIO_OFFICIAL_EXTENSIONS_INVALID: ${detail}`);
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate release pins before any network access. Registry IDs are names, not fabricated Marketplace UUIDs. */
export function parseOfficialExtensions(value: unknown): IExtensionDefinition[] {
	if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.extensions) || value.extensions.length !== expectedNames.size) {
		invalid('manifest schema or extension count');
	}
	const seen = new Set<string>();
	return value.extensions.map((entry: unknown) => {
		if (!record(entry) || typeof entry.name !== 'string' || !expectedNames.has(entry.name) || seen.has(entry.name)) {
			invalid('extension identity or duplicate');
		}
		const { name, version, sha256, downloadUrl, repo, license } = entry;
		if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || license !== 'MIT') {
			invalid(`release pin for ${name}`);
		}
		const shortName = name.slice('armotusitio.'.length);
		const expectedUrl = `https://open-vsx.org/api/armotusitio/${shortName}/${version}/file/${name}-${version}.vsix`;
		if (downloadUrl !== expectedUrl || typeof repo !== 'string' || (repo !== '' && !/^https:\/\/github\.com\/Drako01\/[a-z0-9-]+(?:\.git)?$/.test(repo))) {
			invalid(`source for ${name}`);
		}
		seen.add(name);
		return { name, version, sha256, downloadUrl, repo, metadata: { publisherDisplayName: 'ArmotuSitio' } };
	});
}

/** Pinned universal VSIXs use the existing builtin extension extraction/packaging pipeline on every desktop target. */
export const officialExtensions = parseOfficialExtensions(manifest);

/** Add official extensions without changing upstream artifact sources or replacing upstream builtins. */
export function withOfficialExtensions(upstream: readonly IExtensionDefinition[]): IExtensionDefinition[] {
	const identities = new Set(upstream.map(extension => extension.name.toLowerCase()));
	for (const extension of officialExtensions) {
		if (identities.has(extension.name)) { invalid(`upstream identity collision: ${extension.name}`); }
	}
	return [...upstream, ...officialExtensions];
}
