/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { run, withLock } from './ats-autoupdate.mts';

/** Stream local Docker output; do not inject host credentials or reuse host native modules. */
async function execute(args: string[], cwd: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn('docker', args, { cwd, stdio: 'inherit', windowsHide: true });
		child.once('error', reject);
		child.once('close', code => code === 0 ? resolve() : reject(new Error(`Docker build stage failed (${code}).`)));
	});
}

/** Build from a Git archive of one immutable commit in separate Linux architecture volumes. */
export async function archiveLinuxSources(root: string, commit: string, destination: string): Promise<void> {
	// Windows checkout settings must never introduce CRLF into Linux package scripts.
	await run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar.gz', '--output', destination, commit], root);
}

/** Build Linux artifacts without sharing native modules across architectures. */
export async function buildLinux(architectures = ['x64', 'arm64'], root = path.resolve(import.meta.dirname, '..')): Promise<void> {
	if (!architectures.length || architectures.some(arch => !['x64', 'arm64'].includes(arch))) { throw new Error('Expected Linux x64 and/or arm64.'); }
	await withLock(path.join(root, '.build', 'ats-linux'), async () => {
		if (await run('git', ['status', '--porcelain', '--untracked-files=no'], root)) { throw new Error('Linux builds require clean tracked sources.'); }
		const commit = await run('git', ['rev-parse', 'HEAD'], root);
		const nodeVersion = (await readFile(path.join(root, '.nvmrc'), 'utf8')).trim();
		if (!/^[a-f0-9]{40}$/.test(commit) || !/^\d+\.\d+\.\d+$/.test(nodeVersion)) { throw new Error('Invalid build identity.'); }
		const directory = path.join(root, '.build', 'ats-linux', commit);
		const output = path.join(root, '.build', 'releases');
		await mkdir(directory, { recursive: true }); await mkdir(output, { recursive: true });
		const source = path.join(directory, 'source.tar.gz');
		await archiveLinuxSources(root, commit, source);
		for (const arch of architectures) {
			const platform = arch === 'x64' ? 'linux/amd64' : 'linux/arm64';
			const image = `armotusitio-build:ubuntu22-node${nodeVersion}-${arch}`;
			await execute(['build', '--platform', platform, '--build-arg', `NODE_VERSION=${nodeVersion}`, '-f', 'build/armotusitio/Dockerfile.linux', '-t', image, 'build/armotusitio'], root);
			const cache = path.join(root, '.build', 'cache', 'linux', arch);
			if (process.env.ATS_LINUX_BIND_CACHE === '1') { await mkdir(cache, { recursive: true }); }
			await execute(['run', '--rm', '--platform', platform,
				'--mount', `type=bind,source=${source},target=/input/source.tar.gz,readonly`,
				'--mount', `type=bind,source=${output},target=/output`,
				'--mount', `type=volume,source=ats-linux-${arch}-${commit.slice(0, 16)},target=/work`,
				'--mount', process.env.ATS_LINUX_BIND_CACHE === '1' ? `type=bind,source=${cache},target=/cache` : `type=volume,source=ats-linux-cache-${arch},target=/cache`,
				'-e', `BUILD_SOURCEVERSION=${commit}`, '-e', `ATS_LINUX_ARCH=${arch}`, image], root);
			const receipt = JSON.parse(await readFile(path.join(output, `linux-${arch}-receipt.json`), 'utf8'));
			if (receipt.commit !== commit || receipt.arch !== arch || receipt.quality !== 'stable' || receipt.serverHelp !== true) { throw new Error(`Linux ${arch} receipt does not match this build.`); }
		}
		if (await run('git', ['rev-parse', 'HEAD'], root) !== commit || await run('git', ['status', '--porcelain', '--untracked-files=no'], root)) { throw new Error('Sources changed during Linux packaging.'); }
	});
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const architectures = args.length === 0 ? ['x64', 'arm64'] : args.length === 2 && args[0] === '--arch' ? [args[1]] : [];
	buildLinux(architectures).catch(error => { console.error(error.message); process.exitCode = 1; });
}
