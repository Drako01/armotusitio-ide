/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Structured delete and move tools for chat agents, served by `ats-runner`. The command floor denies `rm`/`del`/`mv` shells,
 * and Claude runs without Bash, so without these tools an agent could create and edit files but never remove or rename them.
 * Floor (immovable): project-relative paths only, never `.git` or `.armotusitio`, never through a link that leaves the project,
 * never overwrite a destination. Inside it, `edit:<glob>` permission rules decide; an irreversible deletion (an untracked or
 * locally modified file, or a sensitive one) always asks the user, whatever the preset says.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitOutput } from './native-git.ts';
import { GIT_BASE, isSensitiveGitPath } from './native-git-tools.ts';
import { requestApproval, type ApprovalAsk } from './native-approval.ts';
import type { PermissionSet } from './native-permissions.ts';
import { samePath } from './native-path.ts';

export interface FileToolsContext {
	root: string;
	permissions: Pick<PermissionSet, 'decide'>;
	/** Resolves an `ask`; without it every `ask` is a denial. */
	ask?: ApprovalAsk;
}
export interface FileToolResult { isError: boolean; text: string }

const MAX_PATH_LENGTH = 1024;
/** A deletion bigger than this is almost certainly a mistake (or `node_modules`); the agent must narrow it. */
export const MAX_DELETE_ENTRIES = 2000;
/** Segments no tool may touch: repository internals and the IDE's own permission files. */
const FORBIDDEN_SEGMENTS = new Set(['.git', '.armotusitio']);

export const FILE_TOOLS = [
	{
		name: 'delete_path',
		description: 'Delete a file or folder (recursively) inside the project. Use this instead of rm/del, which the command policy denies. ' +
			'Deleting untracked, locally modified or sensitive files asks the user first. Refused for .git, .armotusitio and paths outside the project. ' +
			'A git-ignored node_modules next to a lockfile can be deleted whole, whatever its size: use it to repair a corrupt install, then run the package manager install.',
		inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Project-relative path, e.g. "src/old.ts".' } }, required: ['path'], additionalProperties: false }
	},
	{
		name: 'move_path',
		description: 'Move or rename a file or folder inside the project. Use this instead of mv/move/ren. The destination must not exist; missing parent folders are created.',
		inputSchema: {
			type: 'object',
			properties: { from: { type: 'string', description: 'Project-relative source path.' }, to: { type: 'string', description: 'Project-relative destination path.' } },
			required: ['from', 'to'],
			additionalProperties: false
		}
	}
];

class FileToolError extends Error { }
/** A move never overwrites: anything already at the destination (file, folder or link) refuses it. */
const assertFree = async (target: string): Promise<void> => {
	if (await fs.lstat(target).then(() => true, () => false)) { refuse('destination-exists'); }
};
const refuse = (reason: string): never => { throw new FileToolError('POLICY_DENIED: ' + reason); };

/** Case-insensitive on Windows, like the file system: a differently cased path must not look foreign. */
const insideOf = (parent: string, candidate: string): boolean => samePath(parent, candidate) ||
	(process.platform === 'win32' ? candidate.toLowerCase().startsWith(parent.toLowerCase() + path.sep) : candidate.startsWith(parent + path.sep));

/**
 * NTFS names that reach a protected folder under another spelling: an alternate data stream or stream type (`.git::$INDEX_ALLOCATION`
 * deletes the whole folder), characters Windows reserves, a trailing dot or space (ignored by the file system) and 8.3 short names
 * (`GIT~1`). None is a plain project path, so none is accepted; this only runs on Windows.
 */
const isWindowsAlias = (segment: string): boolean => /[:*?"<>|]/.test(segment) || /[. ]$/.test(segment) || /~\d/.test(segment);

/** Validated project-relative path with `/` separators; refuses anything that is not plainly inside the project. */
function relativePath(raw: unknown): string {
	if (typeof raw !== 'string' || !raw || raw.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) { return refuse('invalid-path'); }
	if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || /^[\\/~]/.test(raw)) { return refuse('absolute-path'); }
	const relative = path.posix.normalize(raw.replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
	if (!relative || relative === '.') { return refuse('project-root'); }
	if (relative === '..' || relative.startsWith('../')) { return refuse('path-outside-project'); }
	const segments = relative.split('/');
	if (process.platform === 'win32' && segments.some(isWindowsAlias)) { return refuse('invalid-path'); }
	if (segments.some(segment => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) { return refuse('protected-path'); }
	return relative;
}

/** The nearest existing ancestor of `relative` must resolve inside the canonical project root (no junction or symlink escape). */
async function assertInside(root: string, relative: string): Promise<void> {
	const canonicalRoot = await fs.realpath(root);
	let current = path.dirname(path.join(root, relative));
	for (; ;) {
		const real = await fs.realpath(current).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : refuse('path-unreadable'));
		if (real !== undefined) {
			if (!insideOf(canonicalRoot, real)) { refuse('path-outside-project'); }
			return;
		}
		const parent = path.dirname(current);
		if (parent === current) { return refuse('path-outside-project'); }
		current = parent;
	}
}

/**
 * The file floor shared by every tool that changes project files (delete/move here, native Edit/Write approval): a validated
 * project-relative path that does not leave the project through a link. Throws `POLICY_DENIED: <reason>`.
 */
export async function projectFilePath(root: string, raw: unknown): Promise<string> {
	const relative = relativePath(raw);
	await assertInside(root, relative);
	return relative;
}

/** Entries under `absolute` without following links; refuses nested repositories and oversized trees. */
async function inventory(absolute: string, relative: string): Promise<{ entries: number; sensitive: boolean }> {
	let entries = 0, sensitive = false;
	const visit = async (file: string, rel: string): Promise<void> => {
		if (++entries > MAX_DELETE_ENTRIES) { refuse('too-many-entries'); }
		if (isSensitiveGitPath(rel)) { sensitive = true; }
		const stat = await fs.lstat(file);
		if (!stat.isDirectory()) { return; }
		for (const name of await fs.readdir(file)) {
			if (FORBIDDEN_SEGMENTS.has(name.toLowerCase())) { refuse('protected-path'); }
			await visit(path.join(file, name), rel + '/' + name);
		}
	};
	await visit(absolute, relative);
	return { entries, sensitive };
}

/** Dependency folders a package manager rebuilds from a lockfile; deleting one loses nothing. */
const DEPENDENCY_FOLDERS = new Set(['node_modules']);
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'];
/** Directory-only scan budget for a dependency folder: deep enough for pnpm's `.pnpm/<id>/node_modules/@scope/pkg/<dir>`, bounded in count. */
const DEPENDENCY_SCAN_DEPTH = 7;
const DEPENDENCY_SCAN_DIRECTORIES = 50_000;

/** A lockfile in the folder that owns the dependencies or in an ancestor up to the project root (workspaces keep it at the root). */
async function hasLockfile(root: string, relative: string): Promise<boolean> {
	for (let folder = path.posix.dirname(relative); ; folder = path.posix.dirname(folder)) {
		const found = await Promise.all(LOCKFILES.map(name => exists(path.join(root, folder, name))));
		if (found.includes(true)) { return true; }
		if (folder === '.') { return false; }
	}
}

/**
 * Directories only (a file cannot be a protected folder), never following a link: refuses a protected folder (`.git`, `.armotusitio`,
 * which would mean a nested repository or IDE state living inside the dependencies) and a tree beyond the budget. Links are not
 * entered; removing one never touches its target.
 */
async function assertDependencyTreeIsDisposable(absolute: string): Promise<void> {
	let level = [absolute], directories = 0;
	for (let depth = 0; level.length && depth < DEPENDENCY_SCAN_DEPTH; depth++) {
		const next: string[] = [];
		for (const folder of level) {
			if (++directories > DEPENDENCY_SCAN_DIRECTORIES) { refuse('too-many-entries'); }
			for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
				if (FORBIDDEN_SEGMENTS.has(entry.name.toLowerCase())) { refuse('protected-path'); }
				if (entry.isDirectory()) { next.push(path.join(folder, entry.name)); }
			}
		}
		level = next;
	}
	// Anything deeper than the budget is not inspected, which is why only dependency folders qualify, never arbitrary trees.
}

/**
 * A git-ignored dependency folder with a lockfile (beside it or in an ancestor) and no protected folder inside: reinstalling restores
 * it, so it is recoverable like a tracked file and exempt from the entry cap (a healthy `node_modules` holds tens of thousands of
 * files). Without this the agent can never repair a corrupt install and sends the user to do it by hand.
 */
async function reinstallable(root: string, relative: string): Promise<boolean> {
	if (!DEPENDENCY_FOLDERS.has(path.posix.basename(relative).toLowerCase()) || !await hasLockfile(root, relative)) { return false; }
	// check-ignore rejects `--literal-pathspecs` (part of GIT_BASE); the path is already validated and passed after `--`.
	const ignored = await gitOutput(root, GIT_BASE.filter(arg => arg !== '--literal-pathspecs').concat('check-ignore', '-q', '--', relative)).then(() => true, () => false);
	if (!ignored) { return false; }
	await assertDependencyTreeIsDisposable(path.join(root, relative));
	return true;
}
const exists = (file: string): Promise<boolean> => fs.lstat(file).then(() => true, () => false);

/** True only when git can restore every file under `relative` exactly: tracked, and no local change, untracked or ignored file. */
async function recoverable(root: string, relative: string): Promise<boolean> {
	const read = (args: string[]) => gitOutput(root, [...GIT_BASE, ...args]).then(buffer => buffer.toString('utf8'), () => undefined);
	const tracked = await read(['ls-files', '-z', '--', relative]);
	const status = await read(['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=matching', '--', relative]);
	return !!tracked && status === '';
}

/** `edit:` rules decide every path; `forceAsk` turns an allow into a question (irreversible or sensitive change). */
async function authorize(context: FileToolsContext, paths: string[], detail: string[], forceAsk: boolean): Promise<string | undefined> {
	let ask = forceAsk;
	for (const file of paths) {
		const verdict = context.permissions.decide({ kind: 'edit', path: file });
		if (verdict.decision === 'deny') { return 'POLICY_DENIED: ' + (verdict.rule ?? 'denied by permissions'); }
		ask ||= verdict.decision === 'ask';
	}
	// No "always" rule: these approvals are about one concrete, possibly irreversible, change.
	return ask ? requestApproval(context.ask, { kind: 'edit', title: 'Change project files', detail, rule: '', path: paths[0] }) : undefined;
}

async function deletePath(context: FileToolsContext, input: Record<string, unknown>): Promise<FileToolResult> {
	const relative = await projectFilePath(context.root, input.path);
	const absolute = path.join(context.root, relative);
	const stat = await fs.lstat(absolute).catch(() => refuse('path-not-found'));
	// A link is removed itself, never its target, so it needs no inventory of what it points to.
	// A dependency folder is not inventoried entry by entry: it is big and rebuilt from the lockfile; it is scanned for protected folders instead.
	const dependencies = stat.isDirectory() && await reinstallable(context.root, relative);
	const { entries, sensitive } = stat.isSymbolicLink() ? { entries: 1, sensitive: false } : dependencies ? { entries: 0, sensitive: false } : await inventory(absolute, relative);
	const safe = !sensitive && (dependencies || await recoverable(context.root, relative));
	const size = dependencies ? ' (dependencies)' : stat.isDirectory() ? ' (' + entries + ' entries)' : '';
	const denial = await authorize(context, [relative], ['delete: ' + relative + (stat.isDirectory() ? '/' : '') + size, dependencies ? 'recoverable by reinstalling from the lockfile' : safe ? 'recoverable with git' : 'NOT recoverable with git'], !safe);
	if (denial) { return { isError: true, text: denial }; }
	// Re-validate after the (possibly long) approval wait: the tree may have changed meanwhile.
	await assertInside(context.root, relative);
	// Retries ride out the short file locks a Windows antivirus or indexer holds on freshly installed packages.
	await fs.rm(absolute, { recursive: true, force: false, maxRetries: 10, retryDelay: 200 });
	return { isError: false, text: 'DELETED ' + relative + (entries > 1 ? ' (' + entries + ' entries)' : '') };
}

async function movePath(context: FileToolsContext, input: Record<string, unknown>): Promise<FileToolResult> {
	const from = relativePath(input.from);
	const to = relativePath(input.to);
	if (from === to || to.startsWith(from + '/')) { return refuse('invalid-destination'); }
	await assertInside(context.root, from);
	await assertInside(context.root, to);
	const source = path.join(context.root, from);
	const target = path.join(context.root, to);
	const stat = await fs.lstat(source).catch(() => refuse('path-not-found'));
	await assertFree(target);
	const sensitive = stat.isSymbolicLink() ? false : (await inventory(source, from)).sensitive || isSensitiveGitPath(to);
	const denial = await authorize(context, [from, to], ['move: ' + from + ' -> ' + to], sensitive);
	if (denial) { return { isError: true, text: denial }; }
	await assertInside(context.root, to);
	await assertFree(target);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.rename(source, target);
	return { isError: false, text: 'MOVED ' + from + ' -> ' + to };
}

/** Run one file tool call; refusals are short `POLICY_DENIED: <reason>` texts the agent can act on. */
export async function handleFileTool(context: FileToolsContext, name: string, input: unknown): Promise<FileToolResult> {
	try {
		const value = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
		if (name === 'delete_path') { return await deletePath(context, value); }
		if (name === 'move_path') { return await movePath(context, value); }
		return { isError: true, text: 'Unknown tool' };
	} catch (error) {
		if (error instanceof FileToolError) { return { isError: true, text: error.message }; }
		const code = (error as NodeJS.ErrnoException).code;
		return { isError: true, text: 'HARNESS_FILE_OPERATION_FAILED' + (code ? ': ' + code : '') };
	}
}
