/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as semver from 'semver';
import vfs from 'vinyl-fs';
import type File from 'vinyl';
import product from '../../package.json' with { type: 'json' };
import { officialExtensions } from '../lib/armotusitioOfficialExtensions.ts';
import { fromVsix } from '../lib/extensions.ts';

interface PackagedManifest {
	name: string;
	publisher: string;
	version: string;
	main?: string;
	browser?: string;
	engines?: { vscode?: string };
	__metadata?: { publisherDisplayName?: string };
}

/** Exercise the native VSIX extractor offline; only supplied, pinned archives are accepted. */
export async function verifyOfficialArchives(archiveDirectory: string, outputDirectory: string): Promise<void> {
	await mkdir(outputDirectory, { recursive: true });
	for (const pin of officialExtensions) {
		const archive = path.join(archiveDirectory, `${pin.name.slice('armotusitio.'.length)}-${pin.version}.vsix`);
		const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
		if (checksum !== pin.sha256) { throw new Error(`OFFICIAL_VSIX_CHECKSUM_MISMATCH: ${pin.name}`); }
		const files: File[] = [];
		const extracted = fromVsix(archive, pin);
		extracted.on('data', (file: File) => files.push(file));
		const packaged = extracted.pipe(vfs.dest(path.join(outputDirectory, pin.name)));
		await new Promise<void>((resolve, reject) => {
			extracted.once('error', reject);
			packaged.once('error', reject).once('finish', resolve);
		});
		const manifestFile = files.find(file => file.relative.replace(/\\/g, '/') === 'package.json');
		if (!manifestFile?.contents) { throw new Error(`OFFICIAL_VSIX_MANIFEST_MISSING: ${pin.name}`); }
		const manifest = JSON.parse(manifestFile.contents.toString()) as PackagedManifest;
		const paths = new Set(files.map(file => file.relative.replace(/\\/g, '/')));
		const entrypoint = manifest.main ?? manifest.browser;
		if (`${manifest.publisher}.${manifest.name}` !== pin.name || manifest.version !== pin.version ||
			!manifest.engines?.vscode || !semver.satisfies(product.version, manifest.engines.vscode) ||
			!entrypoint || path.isAbsolute(entrypoint) || entrypoint.split(/[\\/]/).includes('..') || !paths.has(entrypoint.replace(/^\.\//, '')) ||
			manifest.__metadata?.publisherDisplayName !== pin.metadata.publisherDisplayName || ![...paths].some(file => /^(?:license|licence)(?:\.|$)/i.test(file))) {
			throw new Error(`OFFICIAL_VSIX_PACKAGE_INVALID: ${pin.name}`);
		}
		process.stdout.write(`${pin.name}@${pin.version}: PASS sha256=${checksum} files=${files.length} main=${entrypoint}\n`);
	}
}

if (import.meta.main) {
	const directory = process.argv[2];
	if (!directory || process.argv.length > 3) { throw new Error('Usage: node build/armotusitio/check-official-extensions.ts <directory-with-seven-pinned-vsix-files>'); }
	await verifyOfficialArchives(path.resolve(directory), path.resolve(import.meta.dirname, '../../.build/official-extensions-verification'));
}
