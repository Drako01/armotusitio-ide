/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const version = '7.1.0';
const digest = '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f';
const downloadUrl = `https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-${version}-x64.exe`;

/** Verify the pinned official compiler before allowing it to package an installer. */
async function verifyCompiler(compiler: string): Promise<void> {
	const { stdout } = await execute(compiler, ['--version'], { windowsHide: true, timeout: 15000 });
	if (stdout.trim() !== version) {
		throw new Error(`Expected Inno Setup ${version}; refusing to build with a compiler without verified long-path support.`);
	}
}

/** Cache Inno Setup 7 in portable mode, without installing it globally or changing file associations. */
export async function ensureInnoSetup(repository: string): Promise<string> {
	if (process.platform !== 'win32' || process.arch !== 'x64') { throw new Error('The pinned Inno Setup compiler requires Windows x64.'); }
	const directory = path.join(repository, '.build', 'tools', `inno-setup-${version}`);
	const compiler = path.join(directory, 'ISCC.exe');
	const marker = path.join(directory, 'verified-download.sha256');
	if (await readFile(marker, 'utf8').catch(() => '') === digest) {
		await verifyCompiler(compiler);
		return compiler;
	}
	await mkdir(path.dirname(directory), { recursive: true });
	const installer = path.join(path.dirname(directory), `inno-setup-${randomUUID()}.exe`);
	try {
		console.log(`Preparing portable Inno Setup ${version} with long-path support...`);
		const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(300000) });
		if (!response.ok) { throw new Error(`Inno Setup download failed (${response.status}).`); }
		const data = Buffer.from(await response.arrayBuffer());
		if (createHash('sha256').update(data).digest('hex') !== digest) { throw new Error('Inno Setup download failed SHA-256 verification. Nothing was executed.'); }
		await writeFile(installer, data, { flag: 'wx' });
		await execute(installer, ['/PORTABLE=1', '/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${directory}`], { windowsHide: true, timeout: 180000 });
		await verifyCompiler(compiler);
		await writeFile(marker, digest);
		return compiler;
	} finally { await rm(installer, { force: true }); }
}
