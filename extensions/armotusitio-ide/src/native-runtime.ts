/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { constants } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { readWindowsToolchainEnvironment } from './native-windows-environment.ts';

export interface NativeRuntimeHost {
	execPath: string;
	electron: boolean;
	/** A trusted OS environment fallback, never a project's configuration. */
	registeredEnvironment?(): Promise<NodeJS.ProcessEnv>;
}
const CURRENT_HOST: NativeRuntimeHost = { execPath: process.execPath, electron: !!process.versions.electron, registeredEnvironment: readWindowsToolchainEnvironment };
let preferredNode: string | undefined;

/** Only the extension host supplies this user-level preference; projects cannot choose a runtime. */
export function usePreferredNodeRuntime(value: unknown): void {
	preferredNode = typeof value === 'string' && value ? value : undefined;
}

/** Windows environment names are case-insensitive, including when supplied as a plain serialized object. */
function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	if (process.platform !== 'win32') { return env[name]; }
	const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
	return (environmentValue(env, 'PATH') || '').split(path.delimiter).map(directory => directory.trim().replace(/^"(.*)"$/, '$1')).filter(directory => path.isAbsolute(directory));
}

/** Canonical executable paths avoid passing a toolchain junction back to a sandboxed child. */
async function executableFile(candidate: string): Promise<string | undefined> {
	try {
		const canonical = await fs.realpath(candidate);
		if (!(await fs.stat(canonical)).isFile()) { return undefined; }
		await fs.access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
		return canonical;
	} catch { return undefined; }
}

/**
 * A real Node executable can also run package scripts' child `node` commands. Electron's embedded runtime alone cannot:
 * it is a fallback for direct scripts, not evidence that `node` is present on the child process's PATH.
 */
export async function resolveNodeRuntime(env: NodeJS.ProcessEnv = process.env, host: NativeRuntimeHost = CURRENT_HOST): Promise<{ executable: string; embeddedNode: boolean }> {
	if (preferredNode) {
		const executable = path.isAbsolute(preferredNode) && /^(?:node|node\.exe)$/i.test(path.basename(preferredNode)) ? await executableFile(preferredNode) : undefined;
		if (!executable) { throw Error('HARNESS_NODE_EXECUTABLE_UNAVAILABLE'); }
		return { executable, embeddedNode: false };
	}
	const directories = pathDirectories(env);
	if (process.platform === 'win32') {
		const nvm = environmentValue(env, 'NVM_SYMLINK');
		if (nvm && path.isAbsolute(nvm)) { directories.push(nvm); }
	}
	for (const directory of directories) {
		const executable = await executableFile(path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'));
		if (executable) { return { executable, embeddedNode: false }; }
	}
	if (!host.electron) {
		const executable = await executableFile(host.execPath);
		if (executable) { return { executable, embeddedNode: false }; }
	}
	if (process.platform === 'win32' && host.registeredEnvironment) {
		const registered = await host.registeredEnvironment().catch(() => ({}));
		const values = { ...registered, ...env };
		const expand = (value: string): string => {
			for (let attempt = 0; attempt < 6; attempt++) {
				const next = value.replace(/%([^%]+)%/g, (match, name: string) => environmentValue(values, name) ?? match);
				if (next === value) { break; }
				value = next;
			}
			return value;
		};
		const recovered = pathDirectories({ PATH: expand(environmentValue(registered, 'PATH') ?? '') });
		const nvm = expand(environmentValue(registered, 'NVM_SYMLINK') ?? '');
		if (path.isAbsolute(nvm)) { recovered.push(nvm); }
		for (const directory of recovered) {
			const executable = await executableFile(path.join(directory, 'node.exe'));
			if (executable) { return { executable, embeddedNode: false }; }
		}
	}
	return { executable: host.execPath, embeddedNode: true };
}

/** True while `pid` exists on this host (EPERM means it exists but belongs to another user). */
export function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Codex's platform packages: its npm wrapper (`codex.js`) only forwards to this binary. */
const CODEX_WINDOWS_TARGETS: Record<string, { pkg: string; triple: string }> = {
	x64: { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
	arm64: { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
};

/** Well-known npm layouts only; never execute .cmd, .ps1 or shell shims. */
export function windowsNpmProviderCandidates(directory: string, executable: 'codex' | 'claude'): { native?: string; script: string } {
	const moduleRoot = path.join(directory, 'node_modules');
	if (executable === 'codex') {
		const codexRoot = path.join(moduleRoot, '@openai', 'codex');
		const target = CODEX_WINDOWS_TARGETS[process.arch];
		// The wrapper spawns the binary without hiding its console, so running it from a console-less process makes Windows
		// open a visible window for every probe. Starting the binary ourselves, hidden, avoids that.
		return {
			...(target ? { native: path.join(codexRoot, 'node_modules', '@openai', target.pkg, 'vendor', target.triple, 'bin', 'codex.exe') } : {}),
			script: path.join(codexRoot, 'bin', 'codex.js')
		};
	}
	return {
		native: path.join(moduleRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
		script: path.join(moduleRoot, '@anthropic-ai', 'claude-code', 'cli.js')
	};
}

/** Resolve tools without starting them or involving a shell. Node uses the extension host runtime. */
/** Node entry scripts behind the Windows shims of npm, npx, pnpm and yarn (global npm install or corepack). */
const WINDOWS_NODE_SCRIPTS: Record<string, string[][]> = {
	npm: [['node_modules', 'npm', 'bin', 'npm-cli.js']],
	npx: [['node_modules', 'npm', 'bin', 'npx-cli.js']],
	pnpm: [['node_modules', 'pnpm', 'bin', 'pnpm.cjs'], ['node_modules', 'pnpm', 'bin', 'pnpm.mjs'], ['node_modules', 'corepack', 'dist', 'pnpm.js']],
	yarn: [['node_modules', 'yarn', 'bin', 'yarn.js'], ['node_modules', 'corepack', 'dist', 'yarn.js']]
};
/** pnpm 12's npm shims target a bundled native binary rather than the older JavaScript entry. */
const WINDOWS_NATIVE_TOOLS: Record<string, string[]> = { pnpm: ['node_modules', 'pnpm', 'pnpm.exe'], pnpx: ['node_modules', 'pnpm', 'pnpx.exe'] };

/** Stop a process and its whole tree: `taskkill /T` on Windows, the process group elsewhere (spawned `detached`). */
/** Report failure of the direct owned handle without throwing from a cancellation callback. */
export function terminateOwnedProcess(child: Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill'> & { pid?: number }, diagnostic: (code: string) => void): void {
	if (child.exitCode !== null || child.signalCode !== null) { return; }
	let failed = false;
	try { failed = !child.kill(); } catch { failed = true; }
	if (failed && (!child.pid || processAlive(child.pid))) {
		try { diagnostic('HARNESS_PROCESS_TERMINATION_FAILED'); }
		catch { process.emitWarning('HARNESS_PROCESS_DIAGNOSTIC_FAILED', { code: 'HARNESS_PROCESS_DIAGNOSTIC_FAILED' }); }
	}
}

export function stopProcess(child: ChildProcess, diagnostic: (code: string) => void = code => process.emitWarning(code, { code })): void {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) { return; }
	if (process.platform === 'win32') {
		const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
		// Restricted hosts may deny taskkill. The owned process handle can still be terminated directly.
		let reported = false;
		const report = (): void => {
			if (reported) { return; }
			reported = true;
			try { diagnostic('HARNESS_PROCESS_TERMINATION_FAILED'); }
			catch { process.emitWarning('HARNESS_PROCESS_DIAGNOSTIC_FAILED', { code: 'HARNESS_PROCESS_DIAGNOSTIC_FAILED' }); }
		};
		const fallback = (): void => terminateOwnedProcess(child, report);
		const timer = setTimeout(fallback, 500);
		timer.unref();
		child.once('close', () => clearTimeout(timer));
		killer.once('error', fallback);
		killer.once('close', code => { if (code !== 0) { fallback(); } });
	} else {
		try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* exited */ } }
		const timer = setTimeout(() => {
			try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* exited */ }
		}, 1500);
		timer.unref();
		child.once('close', () => clearTimeout(timer));
	}
}

export async function resolveNativeCommand(executable: string, args: string[], env: NodeJS.ProcessEnv = process.env, host: NativeRuntimeHost = CURRENT_HOST): Promise<{ executable: string; args: string[]; embeddedNode: boolean }> {
	if (executable === 'node' || (process.platform === 'win32' && executable.toLowerCase() === 'node.exe')) { return { ...await resolveNodeRuntime(env, host), args }; }
	const directories = pathDirectories(env);
	// Claude's native installer puts the CLI in ~/.local/bin without adding it to PATH; an IDE started with an older PATH must still find it.
	if (executable === 'claude') {
		const home = environmentValue(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') || os.homedir();
		if (path.isAbsolute(home)) { directories.push(path.join(home, '.local', 'bin')); }
	}
	for (const directory of directories) {
		const nativeTool = process.platform === 'win32' ? WINDOWS_NATIVE_TOOLS[executable] : undefined;
		if (nativeTool) {
			const canonical = await executableFile(path.join(directory, ...nativeTool));
			if (canonical) { return { executable: canonical, args, embeddedNode: false }; }
		}
		if (process.platform === 'win32' && (executable === 'codex' || executable === 'claude')) {
			// Modern Claude npm packages contain a native binary; older releases provide cli.js.
			// Never invoke Windows npm .cmd/.ps1 shims (which would require a shell).
			const candidate = windowsNpmProviderCandidates(directory, executable);
			if (candidate.native && await fs.stat(candidate.native).then(info => info.isFile()).catch(() => false)) {
				return { executable: candidate.native, args, embeddedNode: false };
			}
			if (await fs.stat(candidate.script).then(info => info.isFile()).catch(() => false)) {
				return { ...await resolveNodeRuntime(env, host), args: [candidate.script, ...args] };
			}
		}
		// npm-installed CLIs are `.cmd` shims on Windows (a shell); run their Node script directly instead.
		const scripts = process.platform === 'win32' ? WINDOWS_NODE_SCRIPTS[executable] ?? [] : [];
		for (const script of scripts) {
			const cli = path.join(directory, ...script);
			if (await fs.stat(cli).then(info => info.isFile()).catch(() => false)) { return { ...await resolveNodeRuntime(env, host), args: [cli, ...args] }; }
		}
		for (const name of process.platform === 'win32' && !executable.endsWith('.exe') ? [executable + '.exe', executable + '.com'] : [executable]) {
			const candidate = path.join(directory, name);
			const canonical = await executableFile(candidate);
			if (canonical) { return { executable: canonical, args, embeddedNode: false }; }
		}
	}
	throw Error('HARNESS_EXECUTABLE_UNAVAILABLE');
}
