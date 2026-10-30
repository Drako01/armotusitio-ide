/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileDigest, run } from './ats-autoupdate.mts';
import { armotusitioManifestName, armotusitioReleaseTag, armotusitioRepository, parseArmotusitioManifest } from '../src/vs/platform/update/common/armotusitioUpdate.ts';

/** Audit existing signed artifacts without signing, fetching Git refs or changing a release. */
export async function auditRelease(root: string, publicKey: string, execute: typeof run = run): Promise<void> {
	const directory = path.join(root, '.build/releases');
	let envelope;
	try { envelope = JSON.parse(await readFile(path.join(directory, armotusitioManifestName), 'utf8')); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { console.log('SKIP existing artifacts: no signed manifest. Only preflight and isolated orchestration can be checked.'); return; }
		throw error;
	}
	const bytes = Buffer.from(envelope.payload, 'base64');
	if (!verify(null, bytes, publicKey, Buffer.from(envelope.signature, 'base64'))) { throw new Error('Existing manifest signature is invalid.'); }
	const manifest = parseArmotusitioManifest(JSON.parse(bytes.toString('utf8')));
	await execute('git', ['merge-base', '--is-ancestor', manifest.commit, 'HEAD'], root);
	const files = [...Object.values(manifest.assets)];
	const sums = await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8');
	for (const asset of files) {
		if ((await stat(path.join(directory, asset.name))).size !== asset.size || await fileDigest(path.join(directory, asset.name)) !== asset.sha256) { throw new Error(`Existing artifact differs from its signature: ${asset.name}`); }
		if (!sums.split(/\r?\n/).includes(`${asset.sha256}  ${asset.name}`)) { throw new Error(`Checksum list differs: ${asset.name}`); }
	}
	const tag = armotusitioReleaseTag(manifest);
	const pages = JSON.parse(await execute('gh', ['api', '--paginate', '--slurp', `repos/${armotusitioRepository}/releases?per_page=100`], root));
	if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) { throw new Error('Invalid release listing.'); }
	const releases = pages.flat().filter(release => release.tag_name === tag);
	if (releases.length > 1) { throw new Error('Ambiguous existing release.'); }
	if (releases.length === 1) {
		const release = releases[0];
		if (release.target_commitish !== manifest.commit || !Array.isArray(release.assets)) { throw new Error('Existing remote release identity differs from the signed artifacts.'); }
		for (const asset of [...files, ...await Promise.all([armotusitioManifestName, 'SHA256SUMS.txt'].map(async name => ({ name, size: (await stat(path.join(directory, name))).size, sha256: await fileDigest(path.join(directory, name)) })))]) {
			const matches = release.assets.filter((entry: { name: string }) => entry.name === asset.name);
			if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== asset.size || matches[0].digest !== `sha256:${asset.sha256}`) { throw new Error(`Existing remote asset differs or is missing: ${asset.name}`); }
		}
		console.log(`PASS existing remote ${release.draft ? 'draft' : 'published release'}: ${tag}; all assets match.`);
	} else { console.log(`SKIP remote artifact comparison: ${tag} has not been created.`); }
	console.log(`PASS existing signed artifacts: ${tag}, source ${manifest.commit}. These are not a build of the current main.`);
}

/** Execute the actual recipe with isolated git/GitHub/build/signing fixtures. */
export async function dryRun(root: string, publicKey: string): Promise<void> {
	await auditRelease(root, publicKey);
	await new Promise<void>((resolve, reject) => {
		const tests = ['ats-release-script.test.mts', 'ats-release-state.test.mts', 'ats-build-all.test.mts', 'ats-release-retry.test.mts', 'ats-release-check.test.mts'];
		const child = spawn(process.execPath, ['--test', ...tests.map(file => path.join(root, 'scripts', file))], { cwd: root, stdio: 'inherit', windowsHide: true });
		child.once('error', reject);
		child.once('close', code => code === 0 ? resolve() : reject(new Error(`Isolated release orchestration failed (${code}).`)));
	});
	console.log('PASS dry-run: real preflight and isolated end-to-end orchestration. No production build, signing, tag, PR or publication was performed.');
}
