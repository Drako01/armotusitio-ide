/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { fileDigest, run, withLock } from './ats-autoupdate.mts';

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

/**
 * One work volume per architecture: the container refreshes its sources from the archive and reinstalls
 * dependencies only when their fingerprint changes. Logs are written next to the archive of the commit.
 */
export function linuxRunArgs(arch: string, commit: string, paths: { source: string; output: string; logs: string; cache?: string }, image: string): string[] {
	const platform = arch === 'x64' ? 'linux/amd64' : 'linux/arm64';
	return ['run', '--rm', '--platform', platform,
		'--mount', `type=bind,source=${paths.source},target=/input/source.tar.gz,readonly`,
		'--mount', `type=bind,source=${paths.output},target=/output`,
		'--mount', `type=bind,source=${paths.logs},target=/logs`,
		'--mount', `type=volume,source=ats-linux-${arch}-${commit.slice(0, 16)},target=/work`,
		'--mount', paths.cache ? `type=bind,source=${paths.cache},target=/cache` : `type=volume,source=ats-linux-cache-${arch},target=/cache`,
		'-e', `BUILD_SOURCEVERSION=${commit}`, '-e', `ATS_LINUX_ARCH=${arch}`, image];
}

/** Reuse only complete, hash-verified receipts for the requested immutable source. */
export async function reusableLinux(output: string, commit: string, version: string, arch: string): Promise<boolean> {
	try {
		const receipt = JSON.parse(await readFile(path.join(output, `linux-${arch}-receipt.json`), 'utf8'));
		if (receipt.commit !== commit || receipt.version !== version || receipt.arch !== arch || receipt.quality !== 'stable' || receipt.serverHelp !== true) { return false; }
		const required = arch === 'x64' ? ['linux-x64-archive', 'linux-x64-deb', 'linux-x64-rpm', 'server-linux-x64'] : ['server-linux-arm64'];
		for (const platform of required) {
			const asset = receipt.assets?.[platform];
			if (!asset || typeof asset.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(asset.name) || !Number.isSafeInteger(asset.size) || asset.size < 1 || !/^[a-f0-9]{64}$/.test(asset.sha256)) { return false; }
			const file = path.join(output, asset.name);
			if ((await stat(file)).size !== asset.size || await fileDigest(file) !== asset.sha256) { return false; }
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) { return false; }
		throw error;
	}
}

/** Build Linux artifacts without sharing native modules across architectures. */
export async function buildLinux(architectures = ['x64', 'arm64'], root = path.resolve(import.meta.dirname, '..'), resume = false): Promise<void> {
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
		const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
		for (const arch of architectures) {
			if (resume && await reusableLinux(output, commit, version, arch)) { console.log(`Reusing verified Linux ${arch} artifacts at ${commit}`); continue; }
			const platform = arch === 'x64' ? 'linux/amd64' : 'linux/arm64';
			const image = `armotusitio-build:ubuntu22-node${nodeVersion}-${arch}`;
			await execute(['build', '--platform', platform, '--build-arg', `NODE_VERSION=${nodeVersion}`, '-f', 'build/armotusitio/Dockerfile.linux', '-t', image, 'build/armotusitio'], root);
			const cache = process.env.ATS_LINUX_BIND_CACHE === '1' ? path.join(root, '.build', 'cache', 'linux', arch) : undefined;
			if (cache) { await mkdir(cache, { recursive: true }); }
			await execute(linuxRunArgs(arch, commit, { source, output, logs: directory, cache }, image), root);
			console.log(`Linux ${arch} build log: ${path.join(directory, `linux-${arch}.log`)}`);
			const receipt = JSON.parse(await readFile(path.join(output, `linux-${arch}-receipt.json`), 'utf8'));
			if (receipt.commit !== commit || receipt.arch !== arch || receipt.quality !== 'stable' || receipt.serverHelp !== true) { throw new Error(`Linux ${arch} receipt does not match this build.`); }
		}
		if (await run('git', ['rev-parse', 'HEAD'], root) !== commit || await run('git', ['status', '--porcelain', '--untracked-files=no'], root)) { throw new Error('Sources changed during Linux packaging.'); }
	});
}

if (import.meta.main) {
	const flags = process.argv.slice(2);
	const args = flags.filter(arg => arg !== '--resume');
	const architectures = args.length === 0 ? ['x64', 'arm64'] : args.length === 2 && args[0] === '--arch' ? [args[1]] : [];
	buildLinux(architectures, undefined, flags.includes('--resume')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
