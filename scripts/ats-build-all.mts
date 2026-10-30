/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { releaseStages } from './ats-release-state.mts';
import { fileDigest, run, withLock } from './ats-autoupdate.mts';

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
export async function buildAll(root = path.resolve(import.meta.dirname, '..'), dependencies: Partial<Dependencies> = {}, includeLinux = true, resume = false): Promise<void> {
	const deps: Dependencies = { run: execute, git: (args, cwd) => run('git', args, cwd), assertClosed: assertPackagedClosed, ...dependencies };
	await withLock(path.join(root, '.build', 'ats-build-all'), async () => {
		const source = async () => {
			if (await deps.git(['branch', '--show-current'], root) !== 'main' || await deps.git(['status', '--porcelain', '--untracked-files=no'], root)) { throw new Error('Run this recipe from main with clean tracked sources.'); }
			return deps.git(['rev-parse', 'HEAD'], root);
		};
		const commit = await source();
		const cached = resume ? await releaseStages(path.join(root, '.build', 'ats-build-all'), JSON.stringify([commit, process.version, process.platform, process.arch])) : undefined;
		const stage = async (name: string, outputs: string[], work: () => Promise<void>) => {
			if (cached) { await cached(name, outputs, work); } else { await work(); }
			if (await source() !== commit) { throw new Error('Source changed during the release build.'); }
		};
		const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
		if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) { throw new Error('Invalid release version in package.json.'); }
		const application = path.resolve(root, '..', 'ArmotuSitio-IDE-win32-x64');
		const releases = path.join(root, '.build', 'releases');
		const installer = path.join(releases, `ArmotuSitio-IDE-Setup-${version}-x64.exe`);
		const zip = path.join(releases, `ArmotuSitio-IDE-${version}-win32-x64.zip`);
		await deps.assertClosed(application);
		const stages = includeLinux ? 4 : 3;
		console.log(`[1/${stages}] Windows application and installer`);
		await stage('windows', [application, path.join(root, '.build/win32-x64/user-setup/VSCodeSetup.exe'), path.join(root, '.build/ats-autoupdate/build-receipt.json')], async () => {
			await deps.run(process.execPath, [path.join(root, 'scripts', 'ats-package-windows.mts')], root);
		});
		const receipt = JSON.parse(await readFile(path.join(root, '.build', 'ats-autoupdate', 'build-receipt.json'), 'utf8'));
		if (receipt.commit !== commit || await source() !== commit) { throw new Error('Packaging did not validate the selected commit.'); }
		console.log(`[2/${stages}] Versioned installer and ZIP`);
		await stage('windows-archives', [installer, zip, path.join(root, '.build/ats-autoupdate/build-receipt.json')], async () => withLock(path.join(root, '.build', 'ats-autoupdate'), async () => {
			const product = JSON.parse(await readFile(path.join(application, 'resources', 'app', 'product.json'), 'utf8'));
			if (product.version !== version || product.commit !== commit) { throw new Error('Packaged application does not match the release version and commit.'); }
			await mkdir(releases, { recursive: true });
			const temporary = path.join(releases, `.ArmotuSitio-IDE-${randomUUID()}.tmp.exe`);
			try {
				await copyFile(path.join(root, '.build', 'win32-x64', 'user-setup', 'VSCodeSetup.exe'), temporary);
				if ((await stat(temporary)).size === 0 || await fileDigest(temporary) !== receipt.installerSha256) { throw new Error('Installer does not match the packaging receipt.'); }
				await rename(temporary, installer);
			} finally { await rm(temporary, { force: true }); }
			await archiveApplication(application, zip, root, deps.run);
			if (await source() !== commit) { throw new Error('Source changed while creating the ZIP.'); }
		}));
		console.log(`[3/${stages}] Complete development build`);
		await stage('development', [path.join(root, 'out'), path.join(root, 'extensions/armotusitio-ide/dist'), path.join(root, '.build/ats-autoupdate/dev-build-receipt.json')], async () => {
			await deps.run(process.execPath, [path.join(root, 'scripts', 'ats-build-dev.mts')], root);
		});
		if (await source() !== commit) { throw new Error('Source changed during the development build.'); }
		if (includeLinux) {
			console.log('[4/4] Linux x64 desktop and Linux x64/arm64 remote servers');
			await deps.run(process.execPath, [path.join(root, 'scripts', 'ats-build-linux.mts'), ...(resume ? ['--resume'] : [])], root);
			if (await source() !== commit) { throw new Error('Source changed during Linux packaging.'); }
		}
		console.log(`Ready at ${commit}\nApplication: ${application}\nInstaller: ${installer}\nZIP: ${zip}\nDevelopment: scripts\\code.bat --new-window`);
	});
}

if (import.meta.main) {
	if (process.platform !== 'win32' || process.arch !== 'x64') { console.error('This recipe requires Windows x64.'); process.exitCode = 1; }
	else if (process.argv.slice(2).some(arg => !['--windows-only', '--resume'].includes(arg))) { console.error('Expected --windows-only and/or --resume.'); process.exitCode = 1; }
	else { buildAll(undefined, {}, !process.argv.includes('--windows-only'), process.argv.includes('--resume')).catch(error => { console.error(error.message); process.exitCode = 1; }); }
}
