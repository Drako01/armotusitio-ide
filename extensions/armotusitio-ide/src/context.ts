/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
import type { ContextSymbol, ContextSearchOptions, ContextSearchStats } from './context-index-types.ts';
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const path: typeof import('node:path') = require('node:path');
const { constants }: typeof import('node:fs') = require('node:fs');
const { SECRET_NAME }: typeof import('./native-sensitive-scope.ts') = require('./native-sensitive-scope.ts');
const { gitOutput }: typeof import('./native-git.ts') = require('./native-git.ts');
const { redactSecrets }: typeof import('./native-redact.ts') = require('./native-redact.ts');
const IGNORED = new Set(['node_modules', '.git', '.next', '.harness', '.env', 'dist', 'out', 'coverage', '.turbo', '.artifacts', 'vendor', 'build', 'tmp', 'target', '.cache', '.venv', '__pycache__', '.armotusitio', '.aws', '.codex', '.claude', '.ssh', '.kube']);
const SOURCE_EXT = new Set(['.go', '.php', '.ts', '.tsx', '.js', '.mjs', '.py', '.sql', '.json', '.md', '.yaml', '.yml']);

interface ProjectIndex { files: string[]; byExtension: Record<string, number>; truncated: boolean }
interface IndexOptions { limit?: number; signal?: AbortSignal }
const abort = (signal?: AbortSignal): void => { signal?.throwIfAborted(); };
const safeSegment = (name: string): boolean => !IGNORED.has(name.toLowerCase()) && !name.toLowerCase().startsWith('.env') && !SECRET_NAME.test(name);
const safeRelative = (file: string): boolean => !!file && !path.isAbsolute(file) && !/[:\\\x00-\x1f\x7f]/.test(file) && file.split('/').every(segment => segment !== '..' && safeSegment(segment));

/** File metadata only. Git exclusions apply in repositories; a failed Git inventory never widens a known repository. */
async function indexProject(root: string, { limit = 5000, signal }: IndexOptions = {}): Promise<ProjectIndex> {
	limit = Math.max(1, Math.min(5000, Number.isSafeInteger(limit) ? limit : 5000));
	abort(signal);
	const result: ProjectIndex = { files: [], byExtension: {}, truncated: false };
	let tracked: Set<string> | undefined;
	try { tracked = new Set((await gitOutput(root, ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)).toString('utf8').split('\0')); }
	catch { abort(signal); if (await fs.lstat(path.join(root, '.git')).then(() => true, () => false)) { throw Error('HARNESS_CONTEXT_GIT_UNAVAILABLE'); } }
	abort(signal);
	const directoriesWithFiles = tracked ? new Set<string>() : undefined;
	for (const file of tracked ?? []) {
		let parent = path.posix.dirname(file);
		while (parent !== '.' && parent !== '/') { directoriesWithFiles!.add(parent); const next = path.posix.dirname(parent); if (next === parent) { break; } parent = next; }
	}
	const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	let directories = 0;
	while (stack.length && result.files.length < limit) {
		abort(signal);
		if (++directories > 6000) { result.truncated = true; break; }
		const { dir, depth } = stack.pop()!;
		let entries: import('node:fs').Dirent[];
		try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
		entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		for (const entry of entries) {
			abort(signal);
			if (entry.isSymbolicLink() || !safeSegment(entry.name)) { continue; }
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { if (directoriesWithFiles && !directoriesWithFiles.has(path.relative(root, full).split(path.sep).join('/'))) { continue; } if (depth < 10) { stack.push({ dir: full, depth: depth + 1 }); } else { result.truncated = true; } continue; }
			if (!entry.isFile()) { continue; }
			const ext = path.extname(entry.name).toLowerCase();
			if (!SOURCE_EXT.has(ext) || /(?:\.min\.[cm]?js|\.map|\.generated\.[^.]+|\.g\.ts|[.-]lock\.json)$/i.test(entry.name)) { continue; }
			const relative = path.relative(root, full).split(path.sep).join('/');
			if (!safeRelative(relative) || (tracked && !tracked.has(relative))) { continue; }
			result.files.push(relative); result.byExtension[ext] = (result.byExtension[ext] || 0) + 1;
			if (result.files.length >= limit) { result.truncated = true; break; }
		}
	}
	result.files.sort(); return result;
}

interface CachedContext { signature: string; tokens: Set<string> }
const MAX_CONTENT_FILES = 1024;
const MAX_CONTENT_BYTES = 32 * 1024;
const MAX_CONTENT_FILE_SIZE = 256 * 1024;
const MAX_CORPUS_BYTES = 16 * 1024 * 1024;
const terms = (text: string): string[] => [...new Set([
	...(text.toLowerCase().match(/[a-z0-9_]{2,64}/g) ?? []),
	...(text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]{2,64}/g) ?? [])
])];

/**
 * Read-only local retrieval for @ autocomplete. Cached lexical terms are refreshed by file identity,
 * modification/change time and size; symbol names come from VS Code, never another model or network index.
 * A bounded corpus and cancellation keep typing responsive on large projects. Raw contents are never persisted.
 */
class IncrementalContextIndex {
	private readonly root: string;
	private readonly cache = new Map<string, CachedContext>();
	private inventory?: ProjectIndex;
	private indexedAt = 0;
	private canonicalRoot?: string;

	constructor(root: string) { this.root = root; }

	/** Invalidates file content or the inventory after a host file event. */
	invalidate(file?: string): void {
		if (file) { this.cache.delete(file); } else { this.cache.clear(); }
		this.inventory = undefined;
	}

	async search(query: string, { signal, symbols = [], limit = 50 }: ContextSearchOptions = {}): Promise<{ files: string[]; stats: ContextSearchStats; truncated: boolean }> {
		abort(signal);
		const canonical = await fs.realpath(this.root);
		if (this.canonicalRoot && canonical !== this.canonicalRoot) { throw Error('HARNESS_CONTEXT_ROOT_UNSAFE'); }
		this.canonicalRoot = canonical;
		if (!this.inventory || Date.now() - this.indexedAt > 2000) {
			this.inventory = await indexProject(canonical, { signal }); this.indexedAt = Date.now();
			const present = new Set(this.inventory.files);
			for (const file of this.cache.keys()) { if (!present.has(file)) { this.cache.delete(file); } }
		}
		const inventory = this.inventory;
		const stats: ContextSearchStats = { files: inventory.files.length, readFiles: 0, cacheHits: 0, readBytes: 0, contentLimited: inventory.files.length > MAX_CONTENT_FILES };
		const needle = query.replace(/\\/g, '/').toLowerCase().slice(0, 300);
		const wanted = terms(needle);
		const rank = new Map<string, number>();
		for (const file of inventory.files) {
			const lower = file.toLowerCase(), base = path.posix.basename(lower);
			const score = !needle || base.startsWith(needle) ? 100 : base.includes(needle) ? 80 : lower.includes(needle) ? 60 : 0;
			if (score) { rank.set(file, score); }
		}
		const present = new Set(inventory.files);
		for (const symbol of symbols.slice(0, 200)) {
			if (!safeRelative(symbol.path) || !present.has(symbol.path)) { continue; }
			const named = terms(symbol.name);
			if (needle && (symbol.name.toLowerCase().includes(needle) || (wanted.length > 0 && wanted.every(term => named.includes(term))))) { rank.set(symbol.path, (rank.get(symbol.path) ?? 0) + 120); }
		}
		if (wanted.length) {
			for (const file of inventory.files.slice(0, MAX_CONTENT_FILES)) {
				abort(signal);
				const absolute = path.join(canonical, file);
				let stat: import('node:fs').Stats;
				try {
					stat = await fs.lstat(absolute);
					if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTENT_FILE_SIZE || await fs.realpath(absolute) !== absolute) { this.cache.delete(file); rank.delete(file); continue; }
				} catch { this.cache.delete(file); rank.delete(file); continue; }
				const signature = [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size].join(':');
				let cached = this.cache.get(file);
				if (cached?.signature === signature) { stats.cacheHits++; }
				else {
					const bytes = Math.min(stat.size, MAX_CONTENT_BYTES);
					if (stats.readBytes + bytes > MAX_CORPUS_BYTES) { stats.contentLimited = true; break; }
					let handle: import('node:fs/promises').FileHandle | undefined;
					try {
						handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
						const opened = await handle.stat();
						if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || await fs.realpath(absolute) !== absolute) { continue; }
						const buffer = Buffer.alloc(bytes);
						const read = await handle.read(buffer, 0, bytes, 0);
						stats.readFiles++; stats.readBytes += read.bytesRead;
						if (buffer.includes(0)) { this.cache.delete(file); rank.delete(file); continue; }
						cached = { signature, tokens: new Set(terms(redactSecrets(buffer.toString('utf8'))).slice(0, 256)) };
						this.cache.set(file, cached);
						while (this.cache.size > MAX_CONTENT_FILES) { this.cache.delete(this.cache.keys().next().value!); }
					} catch { this.cache.delete(file); rank.delete(file); continue; }
					finally { await handle?.close(); }
				}
				if (cached && wanted.every(term => cached.tokens.has(term))) { rank.set(file, (rank.get(file) ?? 0) + 30); }
			}
		}
		abort(signal);
		const files = [...rank].sort(([a, aScore], [b, bScore]) => bScore - aScore || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).slice(0, Math.max(1, Math.min(50, limit))).map(([file]) => file);
		return { files, stats, truncated: inventory.truncated || stats.contentLimited };
	}
}

function summary(index: { byExtension: Record<string, number> }) { return Object.entries(index.byExtension).sort((a, b) => b[1] - a[1]).map(([ext, count]) => ext + ': ' + count).join(', '); }
module.exports = { indexProject, summary, IGNORED, IncrementalContextIndex };
