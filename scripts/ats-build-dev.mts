/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileDigest, run, withLock } from './ats-autoupdate.mts';

type Runner = (args: string[], cwd: string) => Promise<void>;
type GitRunner = (args: string[], cwd: string) => Promise<string>;

/** Invoke local Node build entry points without a shell, installer or workflow. */
async function execute(args: string[], cwd: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
		child.once('error', reject);
		child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Development build failed (${signal ?? code}).`)));
	});
}

/** Refuse development outputs assembled from different commits or pending tracked changes. */
async function snapshot(root: string, git: GitRunner): Promise<string> {
	if (await git(['branch', '--show-current'], root) !== 'main') {
		throw new Error('Switch to main before running the ArmotuSitio development build.');
	}
	const changed = await git(['status', '--porcelain', '--untracked-files=no'], root);
	if (changed) { throw new Error(`Tracked sources must be clean before building:\n${changed.slice(0, 2000)}`); }
	return git(['rev-parse', 'HEAD'], root);
}

/** Build every development lane and explicitly bundle the custom extension used by code.bat. */
export async function buildDevelopment(root = path.resolve(import.meta.dirname, '..'), node: Runner = execute, git: GitRunner = (args, cwd) => run('git', args, cwd)): Promise<void> {
	// Share the packaging/upstream lock: these commands must never write outputs concurrently.
	await withLock(path.join(root, '.build', 'ats-autoupdate'), async () => {
		const commit = await snapshot(root, git);
		const receipt = path.join(root, '.build', 'ats-autoupdate', 'dev-build-receipt.json');
		await rm(receipt, { force: true });
		await node([path.join(root, 'node_modules', '@typescript', 'native', 'bin', 'tsc'), '--project', path.join(root, 'extensions', 'armotusitio-ide', 'tsconfig.json'), '--noEmit'], root);
		await node([path.join(root, 'build', 'next', 'build-fast.ts'), '--force'], root);
		// The upstream transpile-extensions list does not contain armotusitio-ide.
		await node([path.join(root, 'extensions', 'armotusitio-ide', 'esbuild.mts')], root);
		if (await snapshot(root, git) !== commit) { throw new Error('Source changed during development compilation. Run the command again without changing commits.'); }
		const sourceLogo = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'welcomeGettingStarted', 'common', 'media', 'armotusitio-logo.png');
		const outputLogo = path.join(root, 'out', 'vs', 'workbench', 'contrib', 'welcomeGettingStarted', 'common', 'media', 'armotusitio-logo.png');
		const welcome = path.join(root, 'out', 'vs', 'workbench', 'contrib', 'welcomeGettingStarted', 'browser', 'gettingStarted.js');
		if (!(await readFile(welcome, 'utf8')).includes('armotusitio-logo.png') || await fileDigest(sourceLogo) !== await fileDigest(outputLogo)) {
			throw new Error('The development welcome page or its real logo was not updated.');
		}
		const outputs = ['extension.js', 'home.js', 'chat.js'];
		const hashes: Record<string, string> = {};
		for (const output of outputs) { hashes[output] = await fileDigest(path.join(root, 'extensions', 'armotusitio-ide', 'dist', output)); }
		await writeFile(receipt, JSON.stringify({ commit, completedAt: new Date().toISOString(), extensionOutputs: hashes }, null, 2) + '\n');
		console.log(`Development build ready at ${commit}. Close previous IDE windows, then run scripts\\code.bat.`);
	});
}

if (import.meta.main) {
	buildDevelopment().catch(error => { console.error(error.message); process.exitCode = 1; });
}
