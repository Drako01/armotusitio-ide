/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Git-backed read-only scope attestation. Detection, not an OS sandbox or automatic rollback. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gitOutput } from './native-git.ts';
import { sensitiveScopeDigest } from './native-sensitive-scope.ts';

const SENSITIVE = ['.env', '.env.local', '.env.production', '.env.development', '.netrc', 'credentials.json'];

async function fingerprintFile(file: string): Promise<string> {
	let stat;
	try { stat = await fs.lstat(file); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return 'missing'; }
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink()) { return stat.isDirectory() ? 'directory' : 'special'; }
	if (stat.size > 1024 * 1024) { return 'oversized:' + stat.size; }
	return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

const gitHash = async (root: string, args: string[]): Promise<string> => createHash('sha256').update(await gitOutput(root, args)).digest('hex');

export interface ScopeSnapshot {
	source: 'git' | 'none';
	digest: string;
	/** Folders the sensitive-file scan could not fully analyze; surfaced to the user, never silently dropped. */
	unscanned: string[];
}

export async function captureAgentScope(root: string): Promise<ScopeSnapshot> {
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_SCOPE_ROOT_CHANGED'); }
	const hash = createHash('sha256');
	const marker = await fs.lstat(path.join(root, '.git')).then(() => true).catch(error => {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; }
		throw error;
	});
	for (const name of SENSITIVE) { hash.update(name + ':' + await fingerprintFile(path.join(root, name))); }
	const sensitive = await sensitiveScopeDigest(root);
	hash.update(sensitive.digest);
	const { unscanned } = sensitive;
	if (!marker) { return { source: 'none', digest: hash.digest('hex'), unscanned }; }
	hash.update(await gitHash(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']));
	hash.update(await gitHash(root, ['diff', '--no-ext-diff', '--binary', 'HEAD']));
	return { source: 'git', digest: hash.digest('hex'), unscanned };
}

export function scopeChanged(before: ScopeSnapshot, after: ScopeSnapshot): boolean {
	return before.source !== after.source || before.digest !== after.digest;
}
