/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const repository = 'Drako01/armotusitio-ide';

/** Preserve Store ordering across base patches and release revisions; Store reserves the fourth component. */
export function storeVersion(tag: string): string {
	const match = /^ats-v(\d+)\.(\d+)\.(\d+)-r([1-9]\d*)$/.exec(tag);
	if (!match) { throw new Error('Expected stable release tag ats-vMAJOR.MINOR.PATCH-rREVISION.'); }
	const [major, minor, patch, revision] = match.slice(1).map(Number);
	const build = patch * 1000 + revision;
	if (![major, minor, patch, revision, build].every(Number.isSafeInteger) || major < 1 || major > 65535 || minor > 65535 || revision >= 1000 || build > 65535) {
		throw new Error('Release version exceeds the Store version mapping.');
	}
	return `${major}.${minor}.${build}.0`;
}

/** Only consume the exact Windows ZIP of a stable published release, with GitHub's asset digest. */
export function planStoreRelease(value: unknown, tag: string): { version: string; name: string; url: string; sha256: string; size: number } {
	const version = storeVersion(tag);
	const release = value as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string; digest: string; size: number }[] };
	if (!release || release.tag_name !== tag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) { throw new Error('Expected the selected published stable release.'); }
	const name = `ArmotuSitio-IDE-${tag.slice(5)}-win32-x64.zip`;
	const matches = release.assets.filter(asset => asset?.name === name);
	if (matches.length !== 1) { throw new Error('Missing or ambiguous Windows release ZIP.'); }
	const asset = matches[0];
	const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
	if (asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 2 * 1024 ** 3) {
		throw new Error('Invalid release asset URL, size or SHA256 digest.');
	}
	return { version, name, url, sha256: asset.digest.slice(7), size: asset.size };
}

async function main(tag: string): Promise<void> {
	storeVersion(tag);
	const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
	if (!response.ok) { throw new Error(`Release lookup failed: HTTP ${response.status}`); }
	const plan = planStoreRelease(await response.json(), tag);
	const directory = path.resolve(import.meta.dirname, '../.build/msix/downloads');
	await mkdir(directory, { recursive: true });
	const archive = path.join(directory, plan.name);
	const download = await fetch(plan.url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
	if (!download.ok || !download.body) { throw new Error(`Release download failed: HTTP ${download.status}`); }
	const hash = createHash('sha256');
	let size = 0;
	const reader = download.body.getReader();
	async function* checked() {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) { break; }
				size += value.byteLength;
				if (size > plan.size) { throw new Error('Release download exceeds expected size.'); }
				hash.update(value);
				yield value;
			}
		} finally { await reader.cancel(); reader.releaseLock(); }
	}
	await pipeline(checked(), createWriteStream(archive, { flags: 'wx' }));
	if (size !== plan.size || hash.digest('hex') !== plan.sha256) { throw new Error('Release download integrity check failed.'); }
	await promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'ats-package-msix.ps1'), '-Archive', archive, '-ExpectedSha256', plan.sha256, '-Version', plan.version], { windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 128 * 1024 * 1024 });
	await writeFile(path.resolve(directory, '../ci-release.json'), JSON.stringify({ tag, ...plan }, null, 2) + '\n');
	console.log(`MSIX ready for ${tag}: ${plan.version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [tag, ...extra] = process.argv.slice(2);
	if (!tag || extra.length) { throw new Error('Usage: ats-store-release.mts <published-release-tag>'); }
	await main(tag);
}
