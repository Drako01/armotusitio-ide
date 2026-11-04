/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveNativeCommand } from './native-runtime.ts';
import type { NativeProvider } from './native-providers.ts';

/** The selected host applies to this run only. Project custom agent commands keep their own precedence. */
export async function withHarnessProvider(source: NodeJS.ProcessEnv, provider: NativeProvider): Promise<NodeJS.ProcessEnv> {
	const resolved = await resolveNativeCommand(provider, ['--version'], source);
	const env: NodeJS.ProcessEnv = { ...source, HARNESS_HOST: provider };
	// Native installers and npm platform packages may be discoverable by the IDE without being on PATH.
	// Expose the same binary to the project's Python which()/subprocess calls; never run a provider to probe it.
	if (resolved.args.length === 1) {
		const keys = Object.keys(env).filter(key => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
		const entries = keys.flatMap(key => (env[key] ?? '').split(path.delimiter)).filter(Boolean);
		for (const key of keys) { delete env[key]; }
		const directories = [path.dirname(resolved.executable)];
		// Claude's Unix installer may name its real target by version. Python still needs the `claude` alias.
		const home = (process.platform === 'win32' ? source.USERPROFILE : source.HOME) || os.homedir();
		if (provider === 'claude' && path.isAbsolute(home)) { directories.push(path.join(home, '.local', 'bin')); }
		env.PATH = [...directories, ...entries].join(path.delimiter);
	}
	return env;
}
