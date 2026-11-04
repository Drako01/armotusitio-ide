/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { execFile } from 'node:child_process';
import * as path from 'node:path';

const KEYS = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'];
const NAMES = ['Path', 'NVM_SYMLINK', 'NVM_HOME'];
let cached: { expires: number; value: Promise<NodeJS.ProcessEnv> } | undefined;

/** Read only the registered toolchain locations; a GUI process may predate a Node installation or nvm switch. */
export function readWindowsToolchainEnvironment(): Promise<NodeJS.ProcessEnv> {
	if (process.platform !== 'win32') { return Promise.resolve({}); }
	if (cached && Date.now() < cached.expires) { return cached.value; }
	const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
	const read = (key: string, name: string): Promise<string | undefined> => new Promise(resolve => {
		execFile(executable, ['query', key, '/v', name], { windowsHide: true, timeout: 2000, maxBuffer: 128 * 1024 }, (error, stdout) => {
			if (error) { resolve(undefined); return; }
			const line = stdout.split(/\r?\n/).find(line => line.trim().toLowerCase().startsWith(name.toLowerCase() + ' '));
			resolve(line?.trim().replace(/^\S+\s+REG_(?:EXPAND_)?SZ\s+/i, ''));
		});
	});
	const value = Promise.all(KEYS.map(async key => {
		const values = await Promise.all(NAMES.map(name => read(key, name)));
		return Object.fromEntries(NAMES.map((name, index) => [name, values[index]]));
	})).then(([machine, user]) => ({
		PATH: [machine.Path, user.Path].filter(Boolean).join(';'),
		NVM_SYMLINK: user.NVM_SYMLINK || machine.NVM_SYMLINK,
		NVM_HOME: user.NVM_HOME || machine.NVM_HOME
	}));
	cached = { expires: Date.now() + 30_000, value };
	return value;
}
