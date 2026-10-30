/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Opt-in OS sandbox for OFFLINE verification gates only: Linux uses bubblewrap
 * namespaces, macOS uses the Seatbelt `sandbox-exec` kernel policy. Windows has
 * no equivalent unprivileged CLI primitive, so it always fails closed.
 * Never silently degrade to an unsandboxed command on unsupported hosts.
 * Model providers need a separate network/authenticated broker; this cannot isolate them.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** `linux-offline-readonly` keeps its Linux-only meaning; `offline-readonly` selects the host backend. */
export type OfflineSandboxPolicy = 'linux-offline-readonly' | 'offline-readonly';
export const OFFLINE_SANDBOX_POLICIES: readonly OfflineSandboxPolicy[] = ['linux-offline-readonly', 'offline-readonly'];
export interface OfflineSandboxInvocation {
	executable: string;
	args: string[];
	cwd: string;
	/** Complete replacement environment, when the backend cannot clear it itself. */
	env?: Record<string, string>;
	/** Private writable directory that the caller removes after the process exits. */
	scratch?: string;
}
const RUNTIME_DIRS = ['/usr', '/bin', '/lib', '/lib64', '/usr/local'];
const EXEC_ROOTS = ['/usr/bin/', '/bin/', '/usr/local/bin/'];
const DARWIN_EXEC_ROOTS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/libexec', '/usr/local/bin', '/opt/homebrew/bin'];
const DARWIN_READ_ROOTS = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/private/etc', '/private/var/db/dyld',
	'/private/var/db/timezone', '/dev', '/opt/homebrew', '/Library/Developer/CommandLineTools'];

function validCommand(root: string, executable: string, args: readonly string[], roots: readonly string[]): boolean {
	return path.isAbsolute(root) && path.isAbsolute(executable) &&
		roots.some(prefix => executable.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) &&
		Array.isArray(args) && args.length <= 64 &&
		args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'));
}

/** SBPL string literal; control characters could break out of the policy. */
function sbpl(value: string): string {
	if (!path.isAbsolute(value) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
		throw Error('HARNESS_OS_SANDBOX_COMMAND_INVALID');
	}
	return '"' + value.replace(/[\\"]/g, match => '\\' + match) + '"';
}

/**
 * Seatbelt policy: deny by default, no network, read-only workspace plus system
 * runtime, writes only to a private scratch directory, exec only from system bins.
 */
export function buildDarwinSandboxProfile(root: string, scratch: string): string {
	const subpaths = (paths: readonly string[]): string => paths.map(item => '(subpath ' + sbpl(item) + ')').join(' ');
	return [
		'(version 1)',
		'(deny default)',
		'(allow process-fork)',
		'(allow process-exec ' + subpaths(DARWIN_EXEC_ROOTS) + ')',
		'(allow signal (target same-sandbox))',
		'(allow sysctl-read)',
		'(allow mach-lookup)',
		'(allow file-read-metadata)',
		'(allow file-read* (literal "/") ' + subpaths([...DARWIN_READ_ROOTS, root, scratch]) + ')',
		'(allow file-write* (literal "/dev/null") (literal "/dev/zero") (subpath ' + sbpl(scratch) + '))',
		'(deny network*)'
	].join('\n');
}

export function buildDarwinSandboxArguments(
	root: string, scratch: string, executable: string, args: readonly string[], platform = process.platform
): string[] {
	if (platform !== 'darwin') { throw Error('HARNESS_OS_SANDBOX_UNAVAILABLE'); }
	if (!validCommand(root, executable, args, DARWIN_EXEC_ROOTS)) { throw Error('HARNESS_OS_SANDBOX_COMMAND_INVALID'); }
	return ['-p', buildDarwinSandboxProfile(root, scratch), '--', executable, ...args];
}

export function buildOfflineSandboxArguments(
	root: string, executable: string, args: readonly string[], platform = process.platform
): string[] {
	if (platform !== 'linux') { throw Error('HARNESS_OS_SANDBOX_UNAVAILABLE'); }
	if (!validCommand(root, executable, args, EXEC_ROOTS)) { throw Error('HARNESS_OS_SANDBOX_COMMAND_INVALID'); }
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

async function systemFile(candidates: readonly string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		const stat = await fs.lstat(candidate).catch(() => undefined);
		if (stat?.isFile() && !stat.isSymbolicLink() && await fs.realpath(candidate) === candidate) { return candidate; }
	}
	return undefined;
}

/** Resolve a fixed system-owned executable, never a PATH-supplied shim. */
export async function offlineSandboxInvocation(
	canonicalRoot: string, executable: string, args: readonly string[],
	policy: OfflineSandboxPolicy = 'linux-offline-readonly', platform = process.platform
): Promise<OfflineSandboxInvocation> {
	if (!OFFLINE_SANDBOX_POLICIES.includes(policy)) { throw Error('HARNESS_INVALID_SANDBOX_POLICY'); }
	const seatbelt = platform === 'darwin' && policy === 'offline-readonly';
	if (platform !== 'linux' && !seatbelt) { throw Error('HARNESS_OS_SANDBOX_UNAVAILABLE'); }
	const canonical = await fs.realpath(canonicalRoot);
	if (canonical !== canonicalRoot || !(await fs.stat(canonical)).isDirectory()) {
		throw Error('HARNESS_OS_SANDBOX_ROOT_INVALID');
	}
	const target = await fs.realpath(executable);
	const commandStat = await fs.lstat(executable);
	if (target !== executable || !commandStat.isFile() || commandStat.isSymbolicLink()) {
		throw Error('HARNESS_OS_SANDBOX_COMMAND_INVALID');
	}
	if (!seatbelt) {
		const wrapper = await systemFile(['/usr/bin/bwrap', '/bin/bwrap']);
		if (!wrapper) { throw Error('HARNESS_OS_SANDBOX_UNAVAILABLE'); }
		return { executable: wrapper, args: buildOfflineSandboxArguments(canonical, target, args, platform), cwd: canonical };
	}
	const wrapper = await systemFile(['/usr/bin/sandbox-exec']);
	if (!wrapper) { throw Error('HARNESS_OS_SANDBOX_UNAVAILABLE'); }
	const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sandbox-')));
	try {
		return {
			executable: wrapper, cwd: canonical, scratch,
			args: buildDarwinSandboxArguments(canonical, scratch, target, args, platform),
			env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: scratch, TMPDIR: scratch, LANG: 'C' }
		};
	} catch (error) {
		await fs.rm(scratch, { recursive: true, force: true });
		throw error;
	}
}
