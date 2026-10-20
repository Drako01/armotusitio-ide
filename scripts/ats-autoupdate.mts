/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { armotusitioManifestName, armotusitioPlatforms, armotusitioReleaseTag, armotusitioRepository, compareArmotusitioVersions, isUpdateRecord, parseArmotusitioManifest, type ArmotusitioAsset } from '../src/vs/platform/update/common/armotusitioUpdate.ts';

const execute = promisify(execFile);
export const repositoryRoot = path.resolve(import.meta.dirname, '..');
const stateRoot = path.join(repositoryRoot, '.build', 'ats-autoupdate');
const overridesPath = path.join(repositoryRoot, 'build', 'armotusitio', 'product-overrides.json');
const github = `https://api.github.com/repos/${armotusitioRepository}`;
const privateKeyPath = process.env.ATS_IDE_SIGNING_KEY ? path.resolve(process.env.ATS_IDE_SIGNING_KEY) : path.join(stateRoot, 'signing', 'private.pem');

/** Run argument arrays without a shell; gh keeps credentials outside the repository. */
export async function run(command: string, args: string[], cwd = repositoryRoot, timeout = 120000): Promise<string> {
	const result = await execute(command, args, { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
	return result.stdout.trim();
}

async function jsonFile(file: string): Promise<any> {
	return JSON.parse(await readFile(file, 'utf8'));
}

/** Persist a complete state file, never partially written JSON. */
async function saveJSON(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	const indentation = file.endsWith(path.join('armotusitio', 'product-overrides.json')) ? '\t' : 2;
	await writeFile(temporary, JSON.stringify(value, null, indentation) + '\n', { flag: 'wx' });
	await rename(temporary, file);
}

/** Refuse concurrent runs; only reclaim a lock whose owner no longer exists. */
export async function withLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
	await mkdir(directory, { recursive: true });
	const file = path.join(directory, 'run.lock');
	const owner = { pid: process.pid, id: randomUUID(), startedAt: new Date().toISOString() };
	let handle;
	try {
		handle = await open(file, 'wx');
	} catch (error) {
		if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
			throw error;
		}
		const recoveryPath = path.join(directory, 'recovery.lock');
		const recovery = await open(recoveryPath, 'wx');
		try {
			const previous = await jsonFile(file);
			if (!Number.isInteger(previous.pid) || previous.pid <= 0) {
				throw new Error('Invalid update lock; inspect it before removing it.');
			}
			try {
				process.kill(previous.pid, 0);
				throw new Error(`An update operation is already running (PID ${previous.pid}).`);
			} catch (status) {
				if (!(status instanceof Error) || !('code' in status) || status.code !== 'ESRCH') {
					throw status;
				}
			}
			await rm(file);
			handle = await open(file, 'wx');
		} finally {
			await recovery.close();
			await rm(recoveryPath);
		}
	}
	await handle.writeFile(JSON.stringify(owner));
	try {
		return await work();
	} finally {
		await handle.close();
		if ((await jsonFile(file)).id === owner.id) {
			await rm(file);
		}
	}
}

/** Bound public API requests and honor an ETag cached from the same URL. */
export async function fetchJSON(url: string, etag?: string): Promise<{ value?: any; etag?: string; unchanged: boolean }> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { 'User-Agent': 'ArmotuSitio-IDE-Upstream', 'Accept': 'application/vnd.github+json', ...(etag ? { 'If-None-Match': etag } : {}) },
				signal: AbortSignal.timeout(15000)
			});
			if (response.status === 304) {
				return { unchanged: true, etag };
			}
			if (!response.ok) {
				throw Object.assign(new Error(`HTTP ${response.status} while requesting ${new URL(url).hostname}`), { retryable: response.status === 429 || response.status >= 500 });
			}
			const text = await response.text();
			if (text.length > 4 * 1024 * 1024) {
				throw new Error('API response exceeds the allowed size.');
			}
			return { value: JSON.parse(text), etag: response.headers.get('etag') ?? undefined, unchanged: false };
		} catch (error) {
			if (attempt === 2 || (isUpdateRecord(error) && error.retryable === false)) {
				throw error;
			}
			await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
		}
	}
	throw new Error('API request failed.');
}

/** Numeric ordering and a version floor prevent accidentally downgrading a development base. */
export function selectUpstreamRelease(releases: unknown, currentVersion: string): { tag: string; version: string } | undefined {
	if (!Array.isArray(releases)) {
		throw new Error('Invalid upstream releases response.');
	}
	return releases.filter(isUpdateRecord)
		.filter(release => release.draft === false && release.prerelease === false && typeof release.tag_name === 'string' && /^v?\d+\.\d+\.\d+$/.test(release.tag_name))
		.map(release => ({ tag: String(release.tag_name), version: String(release.tag_name).replace(/^v/, '') }))
		.filter(release => compareArmotusitioVersions(release.version, currentVersion) > 0)
		.sort((a, b) => compareArmotusitioVersions(b.version, a.version))[0];
}

async function detect(dryRun: boolean): Promise<any> {
	const cachePath = path.join(stateRoot, 'upstream-cache.json');
	const cache = await jsonFile(cachePath).catch(() => ({}));
	const response = await fetchJSON('https://api.github.com/repos/microsoft/vscode/releases?per_page=100', cache.etag);
	const releases = response.unchanged ? cache.releases : response.value;
	const currentVersion = (await jsonFile(path.join(repositoryRoot, 'package.json'))).version;
	const release = selectUpstreamRelease(releases, currentVersion);
	let result;
	if (release) {
		const refs = await run('git', ['ls-remote', '--tags', 'https://github.com/microsoft/vscode.git', `refs/tags/${release.tag}`, `refs/tags/${release.tag}^{}`]);
		const lines = refs.split(/\r?\n/).filter(Boolean);
		const line = lines.find(value => value.endsWith('^{}')) ?? lines[0];
		const sha = line?.split(/\s+/)[0];
		if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
			throw new Error('Could not resolve the official upstream tag.');
		}
		result = { status: 'available', ...release, sha, currentVersion, checkedAt: new Date().toISOString() };
	} else {
		const latest = selectUpstreamRelease(releases, '0.0.0');
		result = { status: latest && compareArmotusitioVersions(currentVersion, latest.version) > 0 ? 'base-ahead-of-upstream' : 'no-newer-stable-release', currentVersion, latestStable: latest, checkedAt: new Date().toISOString() };
	}
	if (!dryRun) {
		await saveJSON(cachePath, { etag: response.etag ?? cache.etag, releases });
		await saveJSON(path.join(stateRoot, 'detection.json'), result);
	}
	return result;
}

async function prepare(): Promise<unknown> {
	const release = await detect(false);
	if (release.status !== 'available') {
		return release;
	}
	const candidate = path.join(stateRoot, 'candidates', `${release.tag}-${release.sha.slice(0, 12)}`);
	const statusPath = path.join(stateRoot, 'candidates', `${release.tag}-${release.sha.slice(0, 12)}.json`);
	try {
		await access(candidate);
		return { status: 'already-prepared', candidate, details: await jsonFile(statusPath).catch(() => ({ status: 'inspect-incomplete-candidate' })) };
	} catch { /* Only create a candidate that does not already exist. */ }
	const sourceCommit = await run('git', ['rev-parse', 'HEAD']);
	if (await run('git', ['status', '--porcelain', '--untracked-files=no'])) {
		throw new Error('Commit or stash tracked source changes before preparing an isolated candidate.');
	}
	await mkdir(path.dirname(candidate), { recursive: true });
	await run('git', ['clone', '--no-hardlinks', '--no-checkout', repositoryRoot, candidate], repositoryRoot, 600000);
	await run('git', ['checkout', '-b', `ats-upstream/${release.tag}`, sourceCommit], candidate);
	await run('git', ['remote', 'set-url', 'origin', `https://github.com/${armotusitioRepository}.git`], candidate);
	await run('git', ['remote', 'add', 'upstream', 'https://github.com/microsoft/vscode.git'], candidate);
	await run('git', ['fetch', '--no-tags', 'upstream', `refs/tags/${release.tag}`], candidate, 600000);
	const fetched = await run('git', ['rev-parse', 'FETCH_HEAD^{commit}'], candidate);
	if (fetched !== release.sha) {
		throw new Error('The upstream tag changed after detection; candidate was not merged.');
	}
	let status = 'needs-review';
	try {
		await run('git', ['merge', '--no-commit', '--no-ff', fetched], candidate, 600000);
	} catch (error) {
		const conflicts = await run('git', ['diff', '--name-only', '--diff-filter=U'], candidate);
		if (!conflicts) {
			await saveJSON(statusPath, { status: 'failed', candidate, sourceCommit, upstream: release, reason: 'Git merge failed without reported conflicts.' });
			throw error;
		}
		status = 'conflicts';
	}
	const conflicts = await run('git', ['diff', '--name-only', '--diff-filter=U'], candidate);
	if (status === 'needs-review') {
		const candidateConfig = path.join(candidate, 'build', 'armotusitio', 'product-overrides.json');
		const configuration = await jsonFile(candidateConfig);
		configuration.armotusitioUpstream = { ref: release.tag, commit: release.sha };
		await saveJSON(candidateConfig, configuration);
	}
	const result = { status, candidate, sourceCommit, upstream: release, conflicts: conflicts.split(/\r?\n/).filter(Boolean), buildStarted: false };
	await saveJSON(statusPath, result);
	return result;
}

/** Refuse every publication mutation unless Actions is explicitly disabled. */
export async function requireActionsDisabled(): Promise<void> {
	const permissions = JSON.parse(await run('gh', ['api', `repos/${armotusitioRepository}/actions/permissions`]));
	if (permissions.enabled !== false) {
		throw new Error('Publication stopped: GitHub Actions is not confirmed disabled.');
	}
}

async function initializeSigning(): Promise<unknown> {
	const configuration = await jsonFile(overridesPath);
	await mkdir(path.dirname(privateKeyPath), { recursive: true });
	let publicKey: string;
	try {
		publicKey = createPublicKey(await readFile(privateKeyPath)).export({ type: 'spki', format: 'pem' }).toString();
	} catch (error) {
		if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
			throw error;
		}
		if (configuration.armotusitioUpdate?.publicKey) {
			throw new Error('The signing key is missing. Restore its backup; do not silently replace the trusted key.');
		}
		const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
		await writeFile(privateKeyPath, keys.privateKey, { flag: 'wx', mode: 0o600 });
		publicKey = keys.publicKey;
	}
	if (process.platform === 'win32') {
		const account = await run('whoami', []);
		await run('icacls', [privateKeyPath, '/inheritance:r', '/grant:r', `${account}:(F)`]);
	} else {
		await chmod(privateKeyPath, 0o600);
	}
	if (configuration.armotusitioUpdate?.publicKey && configuration.armotusitioUpdate.publicKey !== publicKey) {
		throw new Error('Private key does not match the trusted public key.');
	}
	configuration.quality = 'stable';
	configuration.updateUrl = `${github}/releases/latest`;
	configuration.armotusitioUpdate = { repository: armotusitioRepository, publicKey, revision: configuration.armotusitioUpdate?.revision ?? 1 };
	await saveJSON(overridesPath, configuration);
	return { status: 'signing-ready', privateKeyPath, publicKeyFingerprint: createHash('sha256').update(publicKey).digest('hex'), instruction: 'Back up the private key securely. Commit the public configuration before building.' };
}

/** Stream hashes so large installers are not held in memory. */
export async function fileDigest(file: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}

async function applicationInfo(): Promise<any> {
	const application = path.resolve(repositoryRoot, '..', 'ArmotuSitio-IDE-win32-x64');
	const product = await jsonFile(path.join(application, 'resources', 'app', 'product.json'));
	const configuration = await jsonFile(overridesPath);
	const receipt = await jsonFile(path.join(stateRoot, 'build-receipt.json'));
	if (product.nameShort !== 'ArmotuSitio IDE' || product.armotusitioUpdate?.repository !== armotusitioRepository
		|| product.armotusitioUpdate?.publicKey !== configuration.armotusitioUpdate?.publicKey
		|| product.armotusitioUpdate?.revision !== configuration.armotusitioUpdate?.revision
		|| !/^[a-f0-9]{40}$/.test(product.commit) || product.commit !== await run('git', ['rev-parse', 'HEAD'])
		|| receipt.commit !== product.commit || receipt.installerSha256 !== await fileDigest(path.join(repositoryRoot, '.build', 'win32-x64', 'user-setup', 'VSCodeSetup.exe'))
		|| receipt.productSha256 !== await fileDigest(path.join(application, 'resources', 'app', 'product.json'))) {
		throw new Error('Build metadata does not match this clean source revision and trusted update configuration. Rebuild first.');
	}
	if (await run('git', ['status', '--porcelain', '--untracked-files=no'])) {
		throw new Error('Tracked source changes are pending; commit and rebuild before producing release artifacts.');
	}
	if (await stat(path.join(application, 'data')).then(() => true, () => false)) {
		throw new Error('Application contains a portable user profile. Refusing to distribute it.');
	}
	return { application, product, version: product.version, revision: product.armotusitioUpdate.revision };
}

async function artifacts(): Promise<unknown> {
	const { application, version, revision, product } = await applicationInfo();
	const output = path.join(repositoryRoot, '.build', 'releases');
	await mkdir(output, { recursive: true });
	const installerName = `ArmotuSitio-IDE-Setup-${version}-r${revision}-x64.exe`;
	const archiveName = `ArmotuSitio-IDE-${version}-r${revision}-win32-x64.zip`;
	const { ZipFile } = await import('yazl');
	const zip = new ZipFile();
	const temporary = path.join(output, `${archiveName}.${randomUUID()}.tmp`);
	const cancellation = new AbortController();
	const writing = pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx' }), { signal: cancellation.signal });
	void writing.catch(() => undefined);
	try {
		async function add(directory: string): Promise<void> {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const file = path.join(directory, entry.name);
				if (entry.isSymbolicLink()) {
					throw new Error(`Unexpected symbolic link in distribution: ${entry.name}`);
				}
				if (entry.isDirectory()) {
					await add(file);
				} else if (entry.isFile()) {
					zip.addFile(file, `ArmotuSitio IDE/${path.relative(application, file).split(path.sep).join('/')}`);
				}
			}
		}
		await add(application);
		zip.end();
		await writing;
		await rename(temporary, path.join(output, archiveName));
	} catch (error) {
		cancellation.abort();
		await writing.catch(() => undefined);
		await rm(temporary, { force: true });
		throw error;
	}
	await copyFile(path.join(repositoryRoot, '.build', 'win32-x64', 'user-setup', 'VSCodeSetup.exe'), path.join(output, installerName));
	const assets: Record<string, ArmotusitioAsset> = {};
	for (const [platform, name] of [['win32-x64-user', installerName], ['win32-x64-archive', archiveName]]) {
		const file = path.join(output, name);
		assets[platform] = { name, size: (await stat(file)).size, sha256: await fileDigest(file) };
	}
	const manifest = parseArmotusitioManifest({ schema: 1, repository: armotusitioRepository, channel: 'stable', revision, baseVersion: version, commit: product.commit, upstream: product.armotusitioUpstream, publishedAt: new Date().toISOString(), assets });
	const payload = Buffer.from(JSON.stringify(manifest));
	const privateKey = await readFile(privateKeyPath);
	const signature = sign(null, payload, privateKey);
	if (!verify(null, payload, product.armotusitioUpdate.publicKey, signature)) {
		throw new Error('Release signing key does not match this build.');
	}
	await saveJSON(path.join(output, armotusitioManifestName), { payload: payload.toString('base64'), signature: signature.toString('base64') });
	await writeFile(path.join(output, 'SHA256SUMS.txt'), Object.values(assets).map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n');
	return { status: 'artifacts-ready', output, tag: armotusitioReleaseTag(manifest), sourceCommit: product.commit };
}

async function validate(): Promise<unknown> {
	if (await run('git', ['status', '--porcelain', '--untracked-files=no'])) {
		throw new Error('Review and commit the candidate before recording release validation.');
	}
	const npmCLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
	await access(npmCLI);
	for (const args of [['run', 'hygiene'], ['run', 'typecheck-client'], ['run', 'check', '--prefix', 'extensions/armotusitio-ide'], ['test', '--prefix', 'extensions/armotusitio-ide']]) {
		console.log(`Validating: npm ${args.join(' ')}`);
		await run(process.execPath, [npmCLI, ...args], repositoryRoot, 1800000);
	}
	await run(process.execPath, [path.join(repositoryRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc'), '--project', 'extensions/armotusitio-ide/tsconfig.json', '--noEmit', '--pretty', 'false']);
	await run(process.execPath, ['--test', 'scripts/ats-autoupdate.test.mts'], repositoryRoot, 120000);
	const result = { status: 'validated', commit: await run('git', ['rev-parse', 'HEAD']), checkedAt: new Date().toISOString(), buildExecuted: false };
	await saveJSON(path.join(stateRoot, 'validation.json'), result);
	return result;
}

async function publish(approved: boolean): Promise<unknown> {
	if (!approved) {
		throw new Error('Review and smoke-test the installer first. Publication requires publish --approve.');
	}
	await requireActionsDisabled();
	await applicationInfo();
	const directory = path.join(repositoryRoot, '.build', 'releases');
	const envelope = await jsonFile(path.join(directory, armotusitioManifestName));
	const configuration = await jsonFile(overridesPath);
	const bytes = Buffer.from(envelope.payload, 'base64');
	if (!verify(null, bytes, configuration.armotusitioUpdate.publicKey, Buffer.from(envelope.signature, 'base64'))) {
		throw new Error('Invalid release metadata signature.');
	}
	const manifest = parseArmotusitioManifest(JSON.parse(bytes.toString()));
	const validation = await jsonFile(path.join(stateRoot, 'validation.json'));
	if (validation.status !== 'validated' || validation.commit !== manifest.commit || configuration.armotusitioUpdate.revision !== manifest.revision) {
		throw new Error('Validation is missing or belongs to another source revision.');
	}
	await run('git', ['fetch', 'origin', 'main']);
	await run('git', ['merge-base', '--is-ancestor', manifest.commit, 'origin/main']);
	const tag = armotusitioReleaseTag(manifest);
	const remoteTags = (await run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])).split(/\r?\n/).filter(Boolean);
	if (remoteTags.length) {
		const target = (remoteTags.find(ref => ref.endsWith('^{}')) ?? remoteTags[0]).split(/\s+/)[0];
		if (target !== manifest.commit) {
			throw new Error('The release tag already points to another commit.');
		}
	}
	const files = Object.values(manifest.assets).map(asset => path.join(directory, asset.name));
	for (const platform of armotusitioPlatforms) {
		const asset = manifest.assets[platform];
		if (await fileDigest(path.join(directory, asset.name)) !== asset.sha256 || (await stat(path.join(directory, asset.name))).size !== asset.size) {
			throw new Error(`Artifact changed after signing: ${asset.name}`);
		}
	}
	files.push(path.join(directory, armotusitioManifestName), path.join(directory, 'SHA256SUMS.txt'));
	const existing = await run('gh', ['api', `repos/${armotusitioRepository}/releases/tags/${tag}`]).then(JSON.parse, () => undefined);
	if (existing && (existing.draft !== true || existing.target_commitish !== manifest.commit)) {
		throw new Error('Release already exists or points at another commit; never replace published assets.');
	}
	if (!existing) {
		await requireActionsDisabled();
		await run('gh', ['release', 'create', tag, '--repo', armotusitioRepository, '--target', manifest.commit, '--draft', '--title', `ArmotuSitio IDE ${manifest.baseVersion} r${manifest.revision}`, '--notes', `Windows x64. Source: ${manifest.commit}. Signed update manifest; Windows executables may be unsigned.`]);
	}
	const draft = JSON.parse(await run('gh', ['api', `repos/${armotusitioRepository}/releases/tags/${tag}`]));
	for (const file of files) {
		if (!draft.assets.some((asset: any) => asset.name === path.basename(file))) {
			await requireActionsDisabled();
			await run('gh', ['release', 'upload', tag, file, '--repo', armotusitioRepository], repositoryRoot, 1800000);
		}
	}
	const uploaded = JSON.parse(await run('gh', ['api', `repos/${armotusitioRepository}/releases/tags/${tag}`]));
	for (const file of files) {
		const asset = uploaded.assets.find((entry: any) => entry.name === path.basename(file));
		if (!asset || asset.state !== 'uploaded' || asset.size !== (await stat(file)).size || asset.digest !== `sha256:${await fileDigest(file)}`) {
			throw new Error(`Remote digest does not match ${path.basename(file)}. Release remains a draft.`);
		}
	}
	await requireActionsDisabled();
	await run('gh', ['release', 'edit', tag, '--repo', armotusitioRepository, '--draft=false', '--latest']);
	await saveJSON(path.join(stateRoot, 'published', `${tag}.json`), { tag, commit: manifest.commit, publishedAt: new Date().toISOString() });
	return { status: 'published', tag, url: `https://github.com/${armotusitioRepository}/releases/tag/${tag}` };
}

async function withdraw(tag: string, approved: boolean): Promise<unknown> {
	if (!approved || !/^ats-v\d+\.\d+\.\d+-r[1-9]\d*$/.test(tag)) {
		throw new Error('Expected withdraw <release-tag> --approve.');
	}
	await requireActionsDisabled();
	await run('gh', ['release', 'edit', tag, '--repo', armotusitioRepository, '--prerelease', '--latest=false']);
	return { status: 'withdrawn-from-stable', tag, recovery: 'Publish a correction with a higher revision; clients never downgrade automatically.' };
}

/** Only old failed candidates can be pruned; reviewed, active and published work is retained. */
async function cleanup(approved: boolean): Promise<unknown> {
	const parent = path.join(stateRoot, 'candidates');
	await mkdir(parent, { recursive: true });
	const parentReal = await realpath(parent);
	if (!parentReal.startsWith(await realpath(repositoryRoot) + path.sep)) {
		throw new Error('Candidate directory is outside the checkout.');
	}
	const removed: string[] = [];
	const eligible: string[] = [];
	for (const name of await readdir(parent)) {
		if (!/^v?\d+\.\d+\.\d+-[a-f0-9]{12}\.json$/.test(name)) {
			continue;
		}
		const recordPath = path.join(parent, name);
		const record = await jsonFile(recordPath);
		if (record.status !== 'failed' || (await stat(recordPath)).mtimeMs > Date.now() - 30 * 86400000) {
			continue;
		}
		const candidate = path.join(parent, name.slice(0, -5));
		if (record.candidate !== candidate || (await lstat(candidate)).isSymbolicLink()) {
			throw new Error('Candidate cleanup path does not match the owned directory.');
		}
		const resolved = await realpath(candidate);
		if (!resolved.startsWith(parentReal + path.sep)) {
			throw new Error('Candidate cleanup escaped the owned directory.');
		}
		eligible.push(resolved);
		if (approved) {
			await rm(resolved, { recursive: true, force: false });
			await rm(recordPath);
			removed.push(resolved);
		}
	}
	return { status: approved ? 'cleaned' : 'cleanup-preview', eligible, removed, retained: 'All signing keys, releases and candidates requiring review.' };
}

/** Execute only the explicitly selected operation; detection never builds or publishes. */
export async function main(args = process.argv.slice(2)): Promise<unknown> {
	const [command = 'help', ...flags] = args;
	if (command === 'withdraw') {
		if (flags.length !== 2) {
			throw new Error('Expected withdraw <release-tag> --approve.');
		}
		return withLock(stateRoot, () => withdraw(flags[0], flags[1] === '--approve'));
	}
	if (command === 'revision') {
		if (flags.length !== 1 || !/^[1-9]\d*$/.test(flags[0]) || !Number.isSafeInteger(Number(flags[0]))) {
			throw new Error('Expected revision <positive-integer>.');
		}
		return withLock(stateRoot, async () => {
			const configuration = await jsonFile(overridesPath);
			if (!configuration.armotusitioUpdate?.publicKey || Number(flags[0]) <= configuration.armotusitioUpdate.revision) {
				throw new Error('Initialize signing first and select a strictly higher revision.');
			}
			configuration.armotusitioUpdate.revision = Number(flags[0]);
			const candidateRecord = await jsonFile(path.join(repositoryRoot, '..', `${path.basename(repositoryRoot)}.json`)).catch(() => undefined);
			if (candidateRecord?.candidate === repositoryRoot && /^v?\d+\.\d+\.\d+$/.test(candidateRecord.upstream?.tag) && /^[a-f0-9]{40}$/.test(candidateRecord.upstream?.sha)) {
				configuration.armotusitioUpstream = { ref: candidateRecord.upstream.tag, commit: candidateRecord.upstream.sha };
			}
			await saveJSON(overridesPath, configuration);
			return { status: 'revision-prepared', revision: Number(flags[0]), next: 'Review, commit, validate, build, then produce artifacts.' };
		});
	}
	const allowed: Record<string, string[]> = { detect: ['--dry-run', '--prepare'], prepare: ['--dry-run'], publish: ['--approve'], cleanup: ['--approve'], help: [], 'init-signing': [], validate: [], artifacts: [] };
	if (!allowed[command] || flags.some(flag => !allowed[command].includes(flag))) {
		throw new Error('Unknown option.');
	}
	if (command === 'help') {
		return { commands: ['detect [--dry-run] [--prepare]', 'prepare [--dry-run]', 'init-signing', 'revision <positive-integer>', 'validate', 'artifacts', 'publish --approve', 'withdraw <tag> --approve', 'cleanup [--approve]'], build: 'node scripts/ats-package-windows.mts', policy: 'No GitHub Actions. No automatic build or publication.' };
	}
	return withLock(stateRoot, async () => {
		switch (command) {
			case 'detect': return flags.includes('--prepare') && !flags.includes('--dry-run') ? prepare() : detect(flags.includes('--dry-run'));
			case 'prepare': return flags.includes('--dry-run') ? detect(true) : prepare();
			case 'init-signing': return initializeSigning();
			case 'validate': return validate();
			case 'artifacts': return artifacts();
			case 'publish': return publish(flags.includes('--approve'));
			case 'cleanup': return cleanup(flags.includes('--approve'));
			default: throw new Error('Unknown command. Run with help.');
		}
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then(result => console.log(JSON.stringify(result, null, 2))).catch(async error => {
		const message = error instanceof Error ? error.message.slice(0, 2000) : 'Update operation failed.';
		console.error(message);
		await saveJSON(path.join(stateRoot, 'last-error.json'), { command: process.argv[2], at: new Date().toISOString(), message }).catch(() => undefined);
		process.exitCode = 1;
	});
}
