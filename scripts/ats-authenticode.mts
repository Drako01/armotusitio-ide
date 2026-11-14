/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
/** Public identity is mandatory even when only verifying; never accept any trusted publisher. */
export function signingConfiguration(env: NodeJS.ProcessEnv = process.env, signing = true): void {
	const required = ['ATS_WINDOWS_PUBLISHER'];
	if (signing) { required.push('ATS_SIGNTOOL', 'ATS_SIGNING_DLIB', 'ATS_SIGNING_ENDPOINT', 'ATS_SIGNING_ACCOUNT', 'ATS_SIGNING_PROFILE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'); }
	for (const key of required) {
		if (!env[key]?.trim()) { throw new Error(`Missing ${key}; configure Windows Authenticode before releasing.`); }
	}
	if (signing && !/^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/.test(env.ATS_SIGNING_ENDPOINT!)) { throw new Error('Invalid Artifact Signing endpoint.'); }
}

/** Refuse links rather than signing files outside the selected build. */
export async function signingTargets(target: string): Promise<string[]> {
	const info = await lstat(target);
	if (info.isSymbolicLink()) { throw new Error('Authenticode target cannot be a symbolic link.'); }
	if (info.isFile()) {
		if (!/\.(exe|dll|node)$/i.test(target)) { throw new Error('Unsupported Authenticode file.'); }
		return [path.resolve(target)];
	}
	if (!info.isDirectory()) { throw new Error('Invalid Authenticode target.'); }
	const files: string[] = [];
	for (const entry of await readdir(target, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) { throw new Error('Authenticode tree cannot contain symbolic links.'); }
		if (entry.isDirectory() || /\.(exe|dll|node)$/i.test(entry.name)) { files.push(...await signingTargets(path.join(target, entry.name))); }
	}
	return files.sort();
}

export async function authenticode(mode: 'sign' | 'verify', target: string): Promise<void> {
	signingConfiguration(process.env, mode === 'sign');
	if (process.platform !== 'win32') { throw new Error('Windows Authenticode verification requires Windows.'); }
	const files = await signingTargets(target);
	if (!files.length) { throw new Error('No Authenticode targets found.'); }
	for (const file of files) {
		await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'ats-authenticode.ps1'), '-Mode', mode, '-Target', file], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [mode, target, ...extra] = process.argv.slice(2);
	if ((mode !== 'sign' && mode !== 'verify') || !target || extra.length) { throw new Error('Usage: ats-authenticode.mts sign|verify <file-or-directory>'); }
	await authenticode(mode, target);
}
