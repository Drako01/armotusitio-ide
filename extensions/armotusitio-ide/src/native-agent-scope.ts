/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Git-backed read-only scope attestation. Detection, not an OS sandbox or automatic rollback. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveNativeCommand } from './native-runtime.ts';
import { sensitiveScopeDigest } from './native-sensitive-scope.ts';

const MAX_CAPTURE = 12 * 1024 * 1024;
const CAPTURE_TIMEOUT = 25_000;
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

async function gitHash(root: string, args: string[]): Promise<string> {
	const command = await resolveNativeCommand('git', args);
	const hash = createHash('sha256');
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(command.executable, command.args, {
			cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
			env: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GIT_OPTIONAL_LOCKS: '0' }
		});
		let bytes = 0, failed = false, stderr = '';
		const timer = setTimeout(() => { failed = true; child.kill(); }, CAPTURE_TIMEOUT);
		timer.unref();
		child.stdout?.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_CAPTURE) { failed = true; child.kill(); return; }
			hash.update(chunk);
		});
		child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, 512); });
		child.once('error', () => { clearTimeout(timer); reject(Error('HARNESS_SCOPE_GIT_UNAVAILABLE')); });
		child.once('close', code => {
			clearTimeout(timer);
			if (failed || code !== 0) { reject(Error('HARNESS_SCOPE_GIT_FAILED')); }
			else { resolve(hash.digest('hex')); }
		});
	});
}
export interface ScopeSnapshot {
	source: 'git' | 'none'
	digest: string
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
	hash.update((await sensitiveScopeDigest(root)).digest);
	if (!marker) { return { source: 'none', digest: hash.digest('hex') }; }
	hash.update(await gitHash(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']));
	hash.update(await gitHash(root, ['diff', '--no-ext-diff', '--binary', 'HEAD']));
	return { source: 'git', digest: hash.digest('hex') };
}

export function scopeChanged(before: ScopeSnapshot, after: ScopeSnapshot): boolean {
	return before.source !== after.source || before.digest !== after.digest;
}
