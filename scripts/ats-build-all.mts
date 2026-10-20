/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { run, withLock } from './ats-autoupdate.mts';

const capture = promisify(execFile);
type Runner = (file: string, args: string[], root: string, env?: NodeJS.ProcessEnv) => Promise<void>;
type Dependencies = {
	run: Runner;
	git: (args: string[], root: string) => Promise<string>;
	assertClosed: (application: string) => Promise<void>;
};

/** Run one stage with inherited output and stop the recipe on failure. */
async function execute(file: string, args: string[], cwd: string, env = process.env): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(file, args, { cwd, env, stdio: 'inherit', windowsHide: true });
		child.once('error', reject);
		child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Stage failed (${signal ?? code}): ${path.basename(file)}`)));
	});
}

/** Detect executables from the packaged folder without terminating user processes. */
export async function assertPackagedClosed(application: string): Promise<void> {
	const command = `$ErrorActionPreference='Stop'; $root=[IO.Path]::GetFullPath($env:ATS_BUILD_APP_DIR).TrimEnd('\\')+'\\'; $ids=@(Get-Process | ForEach-Object {try {if($_.Path -and $_.Path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){$_.Id}}catch{}}); ConvertTo-Json -InputObject $ids -Compress`;
	const { stdout } = await capture('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000, env: { ...process.env, ATS_BUILD_APP_DIR: application } });
	const ids = JSON.parse(stdout.trim());
	if (!Array.isArray(ids)) { throw new Error('Could not check packaged IDE processes.'); }
	if (ids.length) { throw new Error(`Close the packaged IDE before building (PID: ${ids.join(', ')}). No process was terminated.`); }
}

/** Replace the requested ZIP only after Compress-Archive succeeds. */
export async function archiveApplication(application: string, destination: string, root: string, runner: Runner = execute): Promise<void> {
	await mkdir(path.dirname(destination), { recursive: true });
	const temporary = path.join(path.dirname(destination), `.ArmotuSitio-IDE-${randomUUID()}.tmp.zip`);
	try {
		await runner('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:ATS_BUILD_APP_DIR -DestinationPath $env:ATS_BUILD_ZIP_FILE -Force`], root, { ...process.env, ATS_BUILD_APP_DIR: application, ATS_BUILD_ZIP_FILE: temporary });
		if ((await stat(temporary)).size === 0) { throw new Error('The ZIP is empty.'); }
		await rename(temporary, destination);
	} finally { await rm(temporary, { force: true }); }
}

/** Package Windows, archive the complete application and refresh code.bat outputs, in that order. */
export async function buildAll(root = path.resolve(import.meta.dirname, '..'), dependencies: Partial<Dependencies> = {}): Promise<void> {
	const deps: Dependencies = { run: execute, git: (args, cwd) => run('git', args, cwd), assertClosed: assertPackagedClosed, ...dependencies };
	await withLock(path.join(root, '.build', 'ats-build-all'), async () => {
		const source = async () => {
			if (await deps.git(['branch', '--show-current'], root) !== 'main' || await deps.git(['status', '--porcelain', '--untracked-files=no'], root)) { throw new Error('Run this recipe from main with clean tracked sources.'); }
			return deps.git(['rev-parse', 'HEAD'], root);
		};
		const commit = await source();
		const application = path.resolve(root, '..', 'VSCode-win32-x64');
		const zip = path.join(root, '.build', 'releases', 'ArmotuSitio-IDE-win32-x64.zip');
		await deps.assertClosed(application);
		console.log('[1/3] Windows application and installer');
		await deps.run(process.execPath, [path.join(root, 'scripts', 'ats-package-windows.mts')], root);
		const receipt = JSON.parse(await readFile(path.join(root, '.build', 'ats-autoupdate', 'build-receipt.json'), 'utf8'));
		if (receipt.commit !== commit || await source() !== commit) { throw new Error('Packaging did not validate the selected commit.'); }
		console.log('[2/3] ZIP');
		await withLock(path.join(root, '.build', 'ats-autoupdate'), async () => {
			await archiveApplication(application, zip, root, deps.run);
			if (await source() !== commit) { throw new Error('Source changed while creating the ZIP.'); }
		});
		console.log('[3/3] Complete development build');
		await deps.run(process.execPath, [path.join(root, 'scripts', 'ats-build-dev.mts')], root);
		if (await source() !== commit) { throw new Error('Source changed during the development build.'); }
		console.log(`Ready at ${commit}\nInstaller: ${path.join(root, '.build', 'win32-x64', 'user-setup', 'VSCodeSetup.exe')}\nZIP: ${zip}\nDevelopment: scripts\\code.bat --new-window`);
	});
}

if (import.meta.main) {
	if (process.platform !== 'win32' || process.arch !== 'x64') { console.error('This recipe requires Windows x64.'); process.exitCode = 1; }
	else { buildAll().catch(error => { console.error(error.message); process.exitCode = 1; }); }
}
