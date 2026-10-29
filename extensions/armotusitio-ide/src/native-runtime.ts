/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';

/** Resolve tools without starting them or involving a shell. Node uses the extension host runtime. */
export async function resolveNativeCommand(executable: string, args: string[]): Promise<{ executable: string; args: string[]; embeddedNode: boolean }> {
	if (executable === 'node') { return { executable: process.execPath, args, embeddedNode: true }; }
	const directories = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(directory => path.isAbsolute(directory));
	for (const directory of directories) {
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
