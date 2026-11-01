/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Bounded, symlink-safe sensitive-file integrity scan. Never persists file contents.
 * Git decides what is project content, so each project's own `.gitignore` defines its noise. Trees too large or deep
 * to walk are reported as `unscanned` instead of aborting: the scan only backs read-only turns that are already sandboxed.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gitOutput } from './native-git.ts';

const MAX_DIRECTORIES = 6000;
/** One heavy tree is cut here, so it cannot use up the budget the rest of the project needs. */
const MAX_DIRECTORIES_PER_TREE = 1500;
const MAX_SENSITIVE_FILES = 2000;
const MAX_SECRET_BYTES = 1024 * 1024;
const MAX_DEPTH = 14;
const SKIP_DIRS = new Set([
	'.git', 'node_modules', 'dist', 'build', 'out', '.next', '.turbo', 'coverage', '.cache',
	'.venv', 'venv', 'vendor', 'target', '.artifacts', '.idea', '.vscode-test', '__pycache__',
	// Package-manager, framework and tooling caches: large, regenerable and never hold user secrets.
	'.npm-cache', '.pnpm-store', '.yarn', '.parcel-cache', '.nuxt', '.svelte-kit', '.angular',
	'.gradle', '.terraform', '.netlify', '.playwright-mcp', '.playwright-cli', '.build'
]);
/** Harness-generated output, skipped by path because `runtime` and `state` are too generic to skip by name. */
const SKIP_PATHS = ['.harness/runtime', '.harness/state'];
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.aws|\.dockerconfigjson|credentials(?:\.[a-z0-9_-]+)?\.json|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/i;

export interface SensitiveScan {
	digest: string;
	entries: number;
	/** Leading folders that were too large or deep to analyze, sorted; part of the digest. */
	unscanned: string[];
}

interface ScanState {
	directories: number;
	secrets: Set<string>;
	unscanned: Set<string>;
}

/** Leading folders of a relative path, e.g. `apps/api` or `.harness/runtime/output`. */
const leadingFolders = (relative: string, segments: number): string => relative.split('/').slice(0, segments).join('/');

const isSkippedDirectory = (relative: string): boolean =>
	relative.split('/').some(name => SKIP_DIRS.has(name)) || SKIP_PATHS.some(skipped => relative === skipped || relative.startsWith(skipped + '/'));

/** Records a file when it is a credential candidate outside skipped trees. */
function collectSecret(state: ScanState, relative: string): void {
	const slash = relative.lastIndexOf('/');
	if (!SECRET_NAME.test(relative.slice(slash + 1)) || (slash > 0 && isSkippedDirectory(relative.slice(0, slash)))) { return; }
	if (state.secrets.add(relative).size > MAX_SENSITIVE_FILES) { throw Error('HARNESS_SENSITIVE_FILES_LIMIT'); }
}

/** Breadth-first walk of one directory tree; whatever exceeds the budget is recorded as unscanned. */
async function walk(root: string, start: string, state: ScanState): Promise<void> {
	const queue = [start];
	let treeDirectories = 0;
	while (queue.length) {
		const relative = queue.shift()!;
		if (++treeDirectories > MAX_DIRECTORIES_PER_TREE || ++state.directories > MAX_DIRECTORIES) {
			for (const pending of [relative, ...queue]) { state.unscanned.add(leadingFolders(pending, 2) || '.'); }
			return;
		}
		let entries;
		try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
			throw error;
		}
		for (const entry of entries) {
			const child = relative ? relative + '/' + entry.name : entry.name;
			if (!entry.isDirectory()) { collectSecret(state, child); continue; }
			if (isSkippedDirectory(child)) { continue; }
			if (child.split('/').length > MAX_DEPTH) { state.unscanned.add(leadingFolders(child, 3)); continue; }
			queue.push(child);
		}
	}
}

/** What git considers project content: visible files, plus ignored files and (collapsed) ignored folders. */
async function gitListings(root: string): Promise<Buffer[]> {
	return await Promise.all([
		gitOutput(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
		gitOutput(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
	]);
}

/**
 * Credential candidates per git listing. Collapsed folders are walked unless they are known caches,
 * so a wholly ignored `secrets/` stays covered.
 */
async function scanListings(root: string, listings: Buffer[], state: ScanState): Promise<void> {
	const folders: string[] = [];
	for (const listing of listings) {
		for (const entry of listing.toString('utf8').split('\0')) {
			if (!entry) { continue; }
			if (entry.endsWith('/')) { folders.push(entry.slice(0, -1)); } else { collectSecret(state, entry); }
		}
	}
	for (const folder of folders) {
		if (!isSkippedDirectory(folder)) { await walk(root, folder, state); }
	}
}

export async function sensitiveScopeDigest(root: string): Promise<SensitiveScan> {
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_SENSITIVE_ROOT_CHANGED'); }
	const state: ScanState = { directories: 0, secrets: new Set(), unscanned: new Set() };
	// Outside a repository (or when git cannot answer) the same candidates come from walking the whole tree.
	const listings = await gitListings(canonical).catch(() => undefined);
	if (listings) { await scanListings(canonical, listings, state); } else { await walk(canonical, '', state); }
	const digest = createHash('sha256');
	const unscanned = [...state.unscanned].sort();
	digest.update('unscanned:' + unscanned.join('\0') + '\0');
	let entries = 0;
	for (const relative of [...state.secrets].sort()) {
		digest.update(relative + '\0');
		// Symlinks are not traversed. Their presence and link target are fingerprinted.
		const fullPath = path.join(canonical, relative);
		let stat;
		try { stat = await fs.lstat(fullPath); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { digest.update('missing'); continue; }
			throw error;
		}
		entries++;
		if (stat.isSymbolicLink()) {
			digest.update('symlink:' + await fs.readlink(fullPath));
		} else if (stat.isFile()) {
			if (stat.size > MAX_SECRET_BYTES) { throw Error('HARNESS_SENSITIVE_FILE_TOO_LARGE'); }
			digest.update(createHash('sha256').update(await fs.readFile(fullPath)).digest());
		} else {
			digest.update('special:' + stat.mode);
		}
	}
	return { digest: digest.digest('hex'), entries, unscanned };
}
