/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Bounded, symlink-safe sensitive-file integrity scan. Never persists file contents. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_DIRECTORIES = 6000;
const MAX_SENSITIVE_FILES = 2000;
const MAX_SECRET_BYTES = 1024 * 1024;
const MAX_DEPTH = 14;
const SKIP_DIRS = new Set([
	'.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.cache',
	'.venv', 'venv', 'vendor', 'target', '.artifacts', '.idea', '.vscode-test', '__pycache__'
]);
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.aws|\.dockerconfigjson|credentials(?:\.[a-z0-9_-]+)?\.json|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i;

export interface SensitiveScan {
	digest: string;
	entries: number;
}

export async function sensitiveScopeDigest(root: string): Promise<SensitiveScan> {
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_SENSITIVE_ROOT_CHANGED'); }
	const digest = createHash('sha256');
	const queue: Array<{ dir: string; relative: string; depth: number }> = [{ dir: canonical, relative: '', depth: 0 }];
	let directories = 0, files = 0;
	while (queue.length) {
		const next = queue.shift()!;
		if (++directories > MAX_DIRECTORIES) { throw Error('HARNESS_SENSITIVE_SCAN_LIMIT'); }
		const entries = (await fs.readdir(next.dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const relative = next.relative ? next.relative + '/' + entry.name : entry.name;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) { continue; }
				if (next.depth >= MAX_DEPTH) { throw Error('HARNESS_SENSITIVE_SCAN_DEPTH'); }
				queue.push({ dir: path.join(next.dir, entry.name), relative, depth: next.depth + 1 });
				continue;
			}
			if (!SECRET_NAME.test(entry.name)) { continue; }
			if (++files > MAX_SENSITIVE_FILES) { throw Error('HARNESS_SENSITIVE_FILES_LIMIT'); }
			digest.update(relative + '\0');
			// Symlinks are not traversed. Their presence and link target are fingerprinted.
			const fullPath = path.join(next.dir, entry.name);
			const stat = await fs.lstat(fullPath);
			if (stat.isSymbolicLink()) {
				digest.update('symlink:' + await fs.readlink(fullPath));
			} else if (stat.isFile()) {
				if (stat.size > MAX_SECRET_BYTES) { throw Error('HARNESS_SENSITIVE_FILE_TOO_LARGE'); }
				const bytes = await fs.readFile(fullPath);
				digest.update(createHash('sha256').update(bytes).digest());
			} else {
				digest.update('special:' + stat.mode);
			}
		}
	}
	return { digest: digest.digest('hex'), entries: files };
}
