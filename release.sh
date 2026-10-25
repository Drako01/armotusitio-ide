#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
# Run from Git Bash with Windows x64 Node (the existing build requires Windows).
# ./release.sh --plan                 Read-only plan; authenticated GitHub reads.
# ./release.sh                        Prepare metadata through a PR, build and publish.
# ./release.sh --no-publish           Prepare metadata, validate, build and sign only.
# Close the packaged IDE first; keep Docker Desktop running with Linux containers.
# A failed metadata PR is retained for inspection; never force-push or bypass rules.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec node --input-type=module - "$@" <<'NODE'
import path from 'node:path';
import { readFile, writeFile, access, rename, rm } from 'node:fs/promises';
import { createPublicKey, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const flags = process.argv.slice(2);
if (flags.includes('--help') || flags.includes('-h')) {
	console.log(`Usage: ./release.sh [--plan|--dry-run] [--no-publish]
Requires Git Bash, Windows x64 Node >=24.18, git, gh authentication, pwsh.exe,
dependencies, Docker Desktop (Linux containers), and the existing signing key.
Start on clean, current main. This script never switches away from dirty sources.
The version comes from package.json, checked against product/upstream metadata.
The revision is max(published revisions for that version)+1, or 1; drafts do not count.
--plan / --dry-run performs authenticated reads only; no lock, metadata, git or build writes.
Normal execution may create a metadata branch, commit ONLY product-overrides.json,
push it, create a PR and squash-merge through repository protections, then update main.
It runs the existing validation, complete build, signed artifacts and publication recipes.
--no-publish stops after signed artifacts so you can smoke-test the packaged IDE.
Normal publication resumes a matching draft and never replaces a published release.
No Actions settings, signing keys, Git protections or credentials are changed.
Inspect retained PR/branch after an interrupted metadata update; merge/close it before retrying.`);
	process.exit(0);
}
if (flags.some(flag => !['--plan', '--dry-run', '--no-publish'].includes(flag))) {
	console.error('Unknown option. Run ./release.sh --help.'); process.exit(1);
}
const planning = flags.includes('--plan') || flags.includes('--dry-run');
const root = process.cwd();
const metadata = 'build/armotusitio/product-overrides.json';
const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const { run, main: update, withLock, requireActionsDisabled } = await import(pathToFileURL(path.join(root, 'scripts/ats-autoupdate.mts')).href);
const { armotusitioRepository: repository } = await import(pathToFileURL(path.join(root, 'src/vs/platform/update/common/armotusitioUpdate.ts')).href);

// Capture command failures without echoing stdout/stderr that could contain credentials.
async function command(file, args) {
	try { return await run(file, args, root, 120000); }
	catch { throw new Error(`${path.basename(file)} operation failed (${args[0] ?? 'preflight'}). Inspect that operation locally and retry; no protections were bypassed.`); }
}
const git = (...args) => command('git', args);
const gh = (...args) => command('gh', args);

async function cleanMain() {
	if (await git('branch', '--show-current') !== 'main' || await git('status', '--porcelain', '--untracked-files=no')) {
		throw new Error('Start on main with clean tracked sources. Finish any retained metadata PR before retrying.');
	}
	return git('rev-parse', 'HEAD');
}

async function configuration() {
	const [pkg, product, overrides] = await Promise.all([json('package.json'), json('product.json'), json(metadata)]);
	if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || (product.version !== undefined && product.version !== pkg.version)
		|| overrides.armotusitioUpstream?.ref?.replace(/^v/, '') !== pkg.version
		|| overrides.armotusitioUpdate?.repository !== repository || overrides.quality !== 'stable'
		|| !Number.isSafeInteger(overrides.armotusitioUpdate?.revision) || overrides.armotusitioUpdate.revision < 1
		|| typeof overrides.armotusitioUpdate.publicKey !== 'string') {
		throw new Error('Release version, upstream, stable channel or trusted update metadata is inconsistent.');
	}
	return { version: pkg.version, revision: overrides.armotusitioUpdate.revision, overrides,
		fingerprint: JSON.stringify([pkg, product, overrides]) };
}

async function releasePlan(version) {
	const pages = JSON.parse(await gh('api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`));
	if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) { throw new Error('Invalid paginated release response.'); }
	const releases = pages.flat();
	let maximum = 0;
	for (const release of releases) {
		if (typeof release?.tag_name !== 'string' || typeof release.draft !== 'boolean') { throw new Error('Invalid release metadata.'); }
		if (release.draft) { continue; }
		const match = /^ats-v(\d+\.\d+\.\d+)-r([1-9]\d*)$/.exec(release.tag_name);
		if (!match || match[1] !== version) { continue; }
		if (typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at)) || !Number.isSafeInteger(Number(match[2]))) {
			throw new Error('Published release has invalid revision or publication date.');
		}
		maximum = Math.max(maximum, Number(match[2]));
	}
	const revision = maximum + 1;
	if (!Number.isSafeInteger(revision)) { throw new Error('Release revision overflow.'); }
	const tag = `ats-v${version}-r${revision}`;
	const matching = releases.filter(release => release.tag_name === tag);
	if (matching.length > 1) { throw new Error('Ambiguous release tag.'); }
	return { revision, tag, draft: matching[0] };
}

async function currentRemote(commit) {
	const remote = JSON.parse(await gh('api', `repos/${repository}/commits/main`));
	if (remote.sha !== commit) { throw new Error('Local main is not current GitHub main. Update with git pull --ff-only origin main, then retry.'); }
}

async function recipe() {
	if (process.env.GITHUB_ACTIONS === 'true') { throw new Error('This recipe is for local release execution only.'); }
	if (process.env.GH_HOST && process.env.GH_HOST !== 'github.com') { throw new Error('Use github.com for this release.'); }
	await gh('auth', 'status', '--hostname', 'github.com');
	const origin = await git('remote', 'get-url', 'origin');
	if (![ `https://github.com/${repository}.git`, `https://github.com/${repository}`, `git@github.com:${repository}.git`, `ssh://git@github.com/${repository}.git` ].includes(origin)) {
		throw new Error('origin must point directly to the configured GitHub repository.');
	}
	let commit = await cleanMain();
	await currentRemote(commit);
	let config = await configuration();
	const selected = await releasePlan(config.version);
	await requireActionsDisabled();
	console.log(`Release ${selected.tag}\nRepository: ${repository}\nSource: ${commit}\nMetadata revision: ${config.revision} -> ${selected.revision}\nMode: ${planning ? 'read-only plan' : flags.includes('--no-publish') ? 'build and sign' : 'build, sign and publish'}`);
	if (selected.draft && (selected.draft.draft !== true || selected.draft.target_commitish !== commit || config.revision !== selected.revision)) {
		throw new Error('The selected draft belongs to different source/metadata. Inspect it before retrying; no draft was changed.');
	}
	if (planning) {
		console.log(`Stages: ${config.revision === selected.revision ? '' : 'metadata-only commit, push, PR and protected squash merge; '}validate; build-all (Windows + Linux); artifacts${flags.includes('--no-publish') ? '' : '; publish --approve'}.`);
		return;
	}
	if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 24
		|| (Number(process.versions.node.split('.')[0]) === 24 && Number(process.versions.node.split('.')[1]) < 18)) {
		throw new Error('Use Git Bash with Windows x64 Node >=24.18; Linux/WSL Node cannot run the existing Windows build.');
	}
	await command('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
	if ((await command('docker', ['info', '--format', '{{.OSType}}'])).trim() !== 'linux') { throw new Error('Start Docker Desktop with Linux containers.'); }
	await access(path.join(root, 'node_modules', 'gulp', 'bin', 'gulp.js'));
	const key = process.env.ATS_IDE_SIGNING_KEY ? path.resolve(process.env.ATS_IDE_SIGNING_KEY) : path.join(root, '.build/ats-autoupdate/signing/private.pem');
	let publicKey;
	try { publicKey = createPublicKey(await readFile(key)).export({ type: 'spki', format: 'pem' }).toString(); }
	catch { throw new Error('Restore the existing release signing key before running this recipe.'); }
	if (publicKey !== config.overrides.armotusitioUpdate.publicKey) { throw new Error('Existing signing key does not match the trusted metadata.'); }
	const { assertPackagedClosed, buildAll } = await import(pathToFileURL(path.join(root, 'scripts/ats-build-all.mts')).href);
	await assertPackagedClosed(path.resolve(root, '..', 'ArmotuSitio-IDE-win32-x64'));

	async function unchanged() {
		if (await cleanMain() !== commit || (await configuration()).fingerprint !== config.fingerprint) { throw new Error('Source or release metadata changed during this recipe. Restart from a reviewed clean main.'); }
		if ((await releasePlan(config.version)).tag !== selected.tag) { throw new Error('Published releases changed during this recipe. Recalculate and review the revision before retrying.'); }
		await currentRemote(commit);
		await requireActionsDisabled();
	}
	await unchanged();
	if (config.revision !== selected.revision) {
		const branch = `release/ats-v${config.version}-r${selected.revision}-${commit.slice(0, 12)}`;
		await git('switch', '-c', branch);
		await withLock(path.join(root, '.build/ats-autoupdate'), async () => {
			// The existing revision CLI only permits increases. A new base version may
			// require resetting to r1; change only this field under the same lock.
			if ((await configuration()).fingerprint !== config.fingerprint) { throw new Error('Metadata changed before revision preparation.'); }
			config.overrides.armotusitioUpdate.revision = selected.revision;
			const temporary = path.join(root, `${metadata}.${randomUUID()}.tmp`);
			try {
				await writeFile(temporary, JSON.stringify(config.overrides, null, '\t') + '\n', { flag: 'wx' });
				await rename(temporary, path.join(root, metadata));
			} finally { await rm(temporary, { force: true }); }
		});
		if ((await git('diff', '--name-only')).trim() !== metadata || await git('diff', '--cached', '--name-only')) { throw new Error('Unexpected source/index changes. Review the retained metadata branch.'); }
		await git('add', '--', metadata);
		await git('diff', '--cached', '--check');
		await git('commit', '-m', `chore(release): prepare ${selected.tag}`, '--only', '--', metadata);
		const metadataCommit = await git('rev-parse', 'HEAD');
		if (await git('status', '--porcelain', '--untracked-files=no')) { throw new Error('Source changed during the metadata commit.'); }
		await currentRemote(commit);
		await requireActionsDisabled();
		await git('push', '--set-upstream', 'origin', branch);
		await requireActionsDisabled();
		await gh('pr', 'create', '--repo', repository, '--base', 'main', '--head', branch, '--title', `chore(release): prepare ${selected.tag}`, '--body', `Prepare only the update revision for ${selected.tag}. The release recipe will validate, build and sign from clean main after this PR is merged.`);
		await requireActionsDisabled();
		await gh('pr', 'merge', branch, '--repo', repository, '--squash', '--match-head-commit', metadataCommit);
		const pr = JSON.parse(await gh('pr', 'view', branch, '--repo', repository, '--json', 'state'));
		if (pr.state !== 'MERGED') { throw new Error('Metadata PR is not merged. Complete required reviews/checks, merge it, then return to clean updated main and retry.'); }
		await git('switch', 'main');
		await git('pull', '--ff-only', 'origin', 'main');
		commit = await cleanMain();
		if ((await git('diff', metadataCommit, 'HEAD', '--name-only')).trim()) { throw new Error('Main gained unrelated source changes while merging metadata. Review the new main before retrying.'); }
		const merged = await configuration();
		const expected = JSON.parse(config.fingerprint); expected[2].armotusitioUpdate.revision = selected.revision;
		if (merged.fingerprint !== JSON.stringify(expected)) { throw new Error('Merged release metadata differs from the prepared change.'); }
		config = merged;
	}
	await unchanged();
	console.log('Validating the selected release source...'); await update(['validate']);
	await unchanged();
	console.log('Building all release platforms...'); await buildAll();
	await unchanged();
	console.log('Preparing signed release artifacts...'); await update(['artifacts']);
	await unchanged();
	if (!flags.includes('--no-publish')) {
		console.log(`Publishing ${selected.tag} through the existing verified publication recipe...`);
		await update(['publish', '--approve']);
		console.log(`Published: https://github.com/${repository}/releases/tag/${selected.tag}`);
	} else { console.log('Signed artifacts ready in .build/releases. Smoke-test, then publish with: node scripts/ats-autoupdate.mts publish --approve'); }
}

try {
	if (planning) { await recipe(); }
	else { await withLock(path.join(root, '.build/ats-release-recipe'), recipe); }
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Release recipe failed.');
	process.exitCode = 1;
}
NODE
