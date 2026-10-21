/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { readFile, readdir, mkdir, copyFile, stat, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { armotusitioProduct as product } from '../build/lib/armotusitioProduct.ts';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

/** Validate immutable product identity before archiving or publishing any Linux output. */
export function validateIdentity(value: unknown, commit: string, version: string): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid Linux/REH product metadata.'); }
	const actual = value as Record<string, unknown>;
	if (!/^[a-f0-9]{40}$/.test(commit) || actual.commit !== commit || actual.version !== version || actual.quality !== product.quality
		|| actual.serverApplicationName !== product.serverApplicationName || actual.serverDataFolderName !== product.serverDataFolderName
		|| actual.release !== product.release || actual.serverDownloadUrlTemplate !== product.serverDownloadUrlTemplate) { throw new Error('Linux/REH product identity does not match the client build.'); }
}

/** Hash large assets without buffering them in memory. */
async function digest(file: string): Promise<string> {
	const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) { hash.update(chunk); } return hash.digest('hex');
}

/** Produce WSL's single-root tarballs and distribution packages with an auditable receipt. */
export async function linuxArtifacts(arch: string, output: string): Promise<void> {
	if (process.platform !== 'linux' || !['x64', 'arm64'].includes(arch) || process.arch !== arch) { throw new Error('Linux artifacts require the matching native architecture (or Docker emulation).'); }
	const commit = process.env.BUILD_SOURCEVERSION || '';
	const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
	const server = path.resolve(root, '..', `vscode-reh-linux-${arch}`);
	const metadata = JSON.parse(await readFile(path.join(server, 'product.json'), 'utf8'));
	validateIdentity(metadata, commit, version);
	const remoteNode = /^target="([^"]+)"/m.exec(await readFile(path.join(root, 'remote', '.npmrc'), 'utf8'))?.[1];
	const node = (await execute(path.join(server, 'node'), ['--version'])).stdout.trim();
	if (node !== `v${remoteNode}`) { throw new Error('REH Node runtime mismatch.'); }
	await execute(path.join(server, 'bin', product.serverApplicationName), ['--help'], { timeout: 30000 });
	await mkdir(output, { recursive: true });
	const assets: Record<string, { name: string; size: number; sha256: string }> = {};
	async function register(platform: string, name: string): Promise<void> {
		const file = path.join(output, name); assets[platform] = { name, size: (await stat(file)).size, sha256: await digest(file) };
	}
	async function archive(directory: string, name: string): Promise<void> {
		const temporary = path.join(output, `${name}.tmp`);
		await execute('tar', ['-czf', temporary, '-C', path.dirname(directory), path.basename(directory)], { timeout: 600000 });
		const listing = (await execute('tar', ['-tzf', temporary], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
		if (!listing.length || listing.some(entry => !entry.startsWith(path.basename(directory) + '/') || entry.split('/').includes('..'))) { throw new Error('Invalid archive layout.'); }
		if (directory === server && !listing.includes(`${path.basename(directory)}/bin/${product.serverApplicationName}`)) { throw new Error('REH launcher is missing.'); }
		await rename(temporary, path.join(output, name));
	}
	const rehName = `ArmotuSitio-IDE-REH-linux-${arch}-${commit}.tar.gz`;
	await archive(server, rehName); await register(`server-linux-${arch}`, rehName);
	if (arch === 'x64') {
		const application = path.resolve(root, '..', 'VSCode-linux-x64');
		validateIdentity(JSON.parse(await readFile(path.join(application, 'resources', 'app', 'product.json'), 'utf8')), commit, version);
		const profile = await mkdtemp(path.join(tmpdir(), 'ats-linux-version-'));
		let clientVersion: string;
		try {
			clientVersion = (await execute(path.join(application, 'bin', product.applicationName), ['--version', `--user-data-dir=${profile}`], { timeout: 30000, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } })).stdout;
		} finally { await rm(profile, { recursive: true, force: true }); }
		if (!clientVersion.includes(version) || !clientVersion.includes(commit)) { throw new Error('Linux client CLI identity mismatch.'); }
		const stem = `ArmotuSitio-IDE-${version}-r${product.release}`;
		await archive(application, `${stem}-linux-x64.tar.gz`); await register('linux-x64-archive', `${stem}-linux-x64.tar.gz`);
		async function find(directory: string, extension: string): Promise<string[]> {
			const result: string[] = [];
			for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) { result.push(...await find(file, extension)); } else if (entry.name.endsWith(extension)) { result.push(file); } }
			return result;
		}
		for (const [kind, folder, extension] of [['deb', '.build/linux/deb/amd64/deb', '.deb'], ['rpm', '.build/linux/rpm/x86_64', '.rpm']]) {
			const files = await find(path.join(root, folder), extension);
			if (files.length !== 1) { throw new Error(`Expected exactly one ${kind} package.`); }
			const name = `${stem}-linux-x64${extension}`; await copyFile(files[0], path.join(output, name)); await register(`linux-x64-${kind}`, name);
		}
	}
	await writeFile(path.join(output, `linux-${arch}-receipt.json`), JSON.stringify({ commit, version, arch, quality: metadata.quality, serverApplicationName: product.serverApplicationName, node, serverHelp: true, assets }, null, 2) + '\n');
}

if (import.meta.main) { linuxArtifacts(process.argv[2], path.resolve(process.argv[3] || '.build/releases')).catch(error => { console.error(error.message); process.exitCode = 1; }); }
