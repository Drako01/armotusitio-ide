/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { constants } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

/** True while `pid` exists on this host (EPERM means it exists but belongs to another user). */
export function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Well-known npm layouts only; never execute .cmd, .ps1 or shell shims. */
export function windowsNpmProviderCandidates(directory: string, executable: 'codex' | 'claude'): { native?: string; script: string } {
	const moduleRoot = path.join(directory, 'node_modules');
	if (executable === 'codex') {
		return { script: path.join(moduleRoot, '@openai', 'codex', 'bin', 'codex.js') };
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
	pnpm: [['node_modules', 'pnpm', 'bin', 'pnpm.cjs'], ['node_modules', 'corepack', 'dist', 'pnpm.js']],
	yarn: [['node_modules', 'yarn', 'bin', 'yarn.js'], ['node_modules', 'corepack', 'dist', 'yarn.js']]
};

/** Stop a process and its whole tree: `taskkill /T` on Windows, the process group elsewhere (spawned `detached`). */
export function stopProcess(child: ChildProcess): void {
	if (!child.pid) { return; }
	if (process.platform === 'win32') {
		const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
		killer.on('error', () => { /* Cannot terminate unavailable process. */ });
	} else {
		try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* exited */ } }
		const timer = setTimeout(() => {
			try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* exited */ }
		}, 1500);
		timer.unref();
		child.once('close', () => clearTimeout(timer));
	}
}

export async function resolveNativeCommand(executable: string, args: string[]): Promise<{ executable: string; args: string[]; embeddedNode: boolean }> {
	if (executable === 'node') { return { executable: process.execPath, args, embeddedNode: true }; }
	const directories = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(directory => path.isAbsolute(directory));
	// Claude's native installer puts the CLI in ~/.local/bin without adding it to PATH; an IDE started with an older PATH must still find it.
	if (executable === 'claude') { directories.push(path.join(os.homedir(), '.local', 'bin')); }
	for (const directory of directories) {
		if (process.platform === 'win32' && (executable === 'codex' || executable === 'claude')) {
			// Modern Claude npm packages contain a native binary; older releases provide cli.js.
			// Never invoke Windows npm .cmd/.ps1 shims (which would require a shell).
			const candidate = windowsNpmProviderCandidates(directory, executable);
			if (candidate.native && await fs.stat(candidate.native).then(info => info.isFile()).catch(() => false)) {
				return { executable: candidate.native, args, embeddedNode: false };
			}
			if (await fs.stat(candidate.script).then(info => info.isFile()).catch(() => false)) {
				return { executable: process.execPath, args: [candidate.script, ...args], embeddedNode: true };
			}
		}
		// npm-installed CLIs are `.cmd` shims on Windows (a shell); run their Node script directly instead.
		const scripts = process.platform === 'win32' ? WINDOWS_NODE_SCRIPTS[executable] ?? [] : [];
		for (const script of scripts) {
			const cli = path.join(directory, ...script);
			if (await fs.stat(cli).then(info => info.isFile()).catch(() => false)) { return { executable: process.execPath, args: [cli, ...args], embeddedNode: true }; }
		}
		for (const name of process.platform === 'win32' && !executable.endsWith('.exe') ? [executable + '.exe', executable + '.com'] : [executable]) {
			const candidate = path.join(directory, name);
			try {
				if (!(await fs.stat(candidate)).isFile()) { continue; }
				await fs.access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
				return { executable: candidate, args, embeddedNode: false };
			} catch { /* Continue to the next explicit PATH candidate. */ }
		}
	}
	throw Error('HARNESS_EXECUTABLE_UNAVAILABLE');
}
