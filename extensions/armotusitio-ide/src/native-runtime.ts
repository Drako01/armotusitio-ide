/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';

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
export async function resolveNativeCommand(executable: string, args: string[]): Promise<{ executable: string; args: string[]; embeddedNode: boolean }> {
	if (executable === 'node') { return { executable: process.execPath, args, embeddedNode: true }; }
	const directories = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(directory => path.isAbsolute(directory));
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
		if (process.platform === 'win32' && executable === 'npm') {
			const cli = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
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
