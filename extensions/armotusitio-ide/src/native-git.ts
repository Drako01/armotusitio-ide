/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Read-only git invocation with a scrubbed environment, bounded output and a timeout. */
import { spawn } from 'node:child_process';
import { resolveNativeCommand } from './native-runtime.ts';

const MAX_CAPTURE = 12 * 1024 * 1024;
const CAPTURE_TIMEOUT = 25_000;

export async function gitOutput(root: string, args: string[]): Promise<Buffer> {
	const command = await resolveNativeCommand('git', args);
	return await new Promise<Buffer>((resolve, reject) => {
		const child = spawn(command.executable, command.args, {
			cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
			env: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GIT_OPTIONAL_LOCKS: '0' }
		});
		const chunks: Buffer[] = [];
		let bytes = 0, failed = false;
		const timer = setTimeout(() => { failed = true; child.kill(); }, CAPTURE_TIMEOUT);
		timer.unref();
		child.stdout?.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_CAPTURE) { failed = true; child.kill(); return; }
			chunks.push(chunk);
		});
		child.stderr?.resume();
		child.once('error', () => { clearTimeout(timer); reject(Error('HARNESS_SCOPE_GIT_UNAVAILABLE')); });
		child.once('close', code => {
			clearTimeout(timer);
			if (failed || code !== 0) { reject(Error('HARNESS_SCOPE_GIT_FAILED')); }
			else { resolve(Buffer.concat(chunks)); }
		});
	});
}
