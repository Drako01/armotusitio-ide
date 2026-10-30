/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Opt-in Linux OS sandbox for OFFLINE verification gates only.
 * Never silently degrade to an unsandboxed command on unsupported hosts.
 * Model providers need a separate network/authenticated broker; this cannot isolate them.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface OfflineSandboxInvocation {
	executable: string;
	args: string[];
	cwd: string;
}
const RUNTIME_DIRS = ['/usr', '/bin', '/lib', '/lib64', '/usr/local'];
const EXEC_ROOTS = ['/usr/bin/', '/bin/', '/usr/local/bin/'];

export function buildOfflineSandboxArguments(
	root: string, executable: string, args: readonly string[], platform = process.platform
): string[] {
	if (platform !== 'linux') { throw Error('HARNESS_OS_SANDBOX_UNAVAILABLE'); }
	if (!path.isAbsolute(root) || !path.isAbsolute(executable) ||
		!EXEC_ROOTS.some(prefix => executable.startsWith(prefix)) ||
		!Array.isArray(args) || args.length > 64 ||
		!args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'))) {
		throw Error('HARNESS_OS_SANDBOX_COMMAND_INVALID');
	}
	return [
		'--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
		'--tmpfs', '/',
		...RUNTIME_DIRS.flatMap(dir => ['--ro-bind-try', dir, dir]),
		'--dir', '/workspace', '--dir', '/tmp',
		'--dev', '/dev', '--proc', '/proc',
		'--ro-bind', root, '/workspace',
		'--chdir', '/workspace',
		'--setenv', 'HOME', '/tmp',
		'--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
		'--', executable, ...args
	];
}

/** Resolve a fixed system-owned executable, never a PATH-supplied shim. */
export async function offlineSandboxInvocation(
	canonicalRoot: string, executable: string, args: readonly string[]
): Promise<OfflineSandboxInvocation> {
	if (process.platform !== 'linux') { throw Error('HARNESS_OS_SANDBOX_UNAVAILABLE'); }
	const canonical = await fs.realpath(canonicalRoot);
	if (canonical !== canonicalRoot || !(await fs.stat(canonical)).isDirectory()) {
		throw Error('HARNESS_OS_SANDBOX_ROOT_INVALID');
	}
	const target = await fs.realpath(executable);
	const commandStat = await fs.lstat(executable);
	if (target !== executable || !commandStat.isFile() || commandStat.isSymbolicLink()) {
		throw Error('HARNESS_OS_SANDBOX_COMMAND_INVALID');
	}
	let wrapper: string | undefined;
	for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
		const stat = await fs.lstat(candidate).catch(() => undefined);
		if (stat?.isFile() && !stat.isSymbolicLink() && await fs.realpath(candidate) === candidate) {
			wrapper = candidate;
			break;
		}
	}
	if (!wrapper) { throw Error('HARNESS_OS_SANDBOX_UNAVAILABLE'); }
	return {
		executable: wrapper,
		args: buildOfflineSandboxArguments(canonical, target, args),
		cwd: canonical
	};
}
