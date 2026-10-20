/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

/** Run a local build step without invoking a shell or GitHub Actions. */
function execute(args: string[], cwd = root): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
		child.once('error', reject);
		child.once('close', (code, signal) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Local build failed (${signal ?? code}): ${args.join(' ')}`));
			}
		});
	});
}

async function main(): Promise<void> {
	if (process.platform !== 'win32' || process.arch !== 'x64') {
		throw new Error('This packaging command requires Windows x64.');
	}
	const copilot = path.join(root, 'extensions', 'copilot');
	await execute([path.join(copilot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(copilot, 'script', 'postinstall.ts')], copilot);
	const gulp = ['--experimental-strip-types', '--max-old-space-size=8192', path.join(root, 'node_modules', 'gulp', 'bin', 'gulp.js')];
	await execute([...gulp, 'vscode-win32-x64']);
	await execute([...gulp, 'vscode-win32-x64-user-setup']);
}

main().catch(error => {
	console.error(error.message);
	process.exitCode = 1;
});
