/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Install a synthetic Codex executable without shell shims or real-provider network traffic. */
export async function installFakeCodex(bin: string, source: string): Promise<void> {
	if (process.platform === 'win32') {
		// resolveNativeCommand deliberately runs the npm package entry with embedded Node.
		const entry = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
		await fs.mkdir(path.dirname(entry), { recursive: true });
		await fs.writeFile(entry, source);
		return;
	}
	await fs.mkdir(bin, { recursive: true });
	const executable = path.join(bin, 'codex');
	await fs.writeFile(executable, source, { mode: 0o755 });
	await fs.chmod(executable, 0o755);
}
