/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Structured git tools for the chat agent (plan r6): `git_commit` and `git_push`, served by `ats-runner` next to `run`.
 * The agent never gets raw git. Its own immovable floor lives here and no permission rule can widen it: explicit
 * project files only (never a directory, `.` or `-A`), nothing sensitive, hooks always run, no force, no tags, no remote or
 * config changes, and never pushes the default branch. Commits may be made on the current branch, including main.
 * Permission rules then decide `allow`, `ask` or `deny` on top of it.
 * `git commit` and `git push` run the project's own hooks (we do not force `core.hooksPath`: that would break husky and
 * friends), and the agent can write to the project. So the hooks and the repository config are fingerprinted when the run
 * starts and any change refuses both tools, as does a modified hook directory inside the tree.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitOutput } from './native-git.ts';
import { runCommand } from './native-command-runner.ts';
import { requestApproval, type ApprovalAsk } from './native-approval.ts';
import { globMatches, suggestRule, type PermissionSet } from './native-permissions.ts';
import type { PermissionRequest } from './native-permissions-types.ts';
import { SECRET_NAME } from './native-sensitive-scope.ts';

export interface GitToolsContext {
	root: string;
	env: NodeJS.ProcessEnv;
	logDirectory: string;
	permissions: Pick<PermissionSet, 'decide'>;
	/** Resolves an `ask`; without it every `ask` is a denial. */
	ask?: ApprovalAsk;
	/** `repoFingerprint` taken when the run started; a different value now refuses commit and push. */
	repoBaseline?: string;
	/** Extra protected branch patterns (`atsHarness.protectedBranches`), e.g. `release/*`, `prod*`; case-insensitive. */
	protectedBranches?: readonly string[];
	/** Rechecks the run's project-permission snapshot after the user answers. */
	checkPermissions?: () => Promise<boolean>;
}
export interface GitToolResult { isError: boolean; text: string }

const MAX_PATHS = 100;
const MAX_PATH_LENGTH = 1024;
const MAX_MESSAGE_LENGTH = 2000;
/** Branches nobody pushes to from an agent, whatever the remote says its default is. */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);
const REF_NAME = /^[A-Za-z0-9._/-]{1,200}$/;
const REMOTE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
/** Directories whose files are credentials or repository internals, wherever they sit in the project. */
const SENSITIVE_SEGMENTS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.kube', '.armotusitio']);
const MAX_HOOK_FILES = 200;
/** Fixed prefix: literal pathspecs (a name like `*.ts` or `:(top)x` is never a pattern) and no fsmonitor command from repository config. */
const GIT_BASE = ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never'];
const PUSH_TIMEOUT_SEC = 180;

export const GIT_TOOLS = [
	{
		name: 'git_commit',
		description: 'Commit specific files of the project. Pass each project-relative file in `paths` (never a directory, ".", a wildcard or an absolute path) and the commit `message`. ' +
			'Repository hooks always run (they are the project\'s own and cannot be skipped); if the hooks or the git config change during the run the tool refuses with `repo-config-changed` or `hooks-modified`. Credential files (.env, keys) are refused. The user may be asked to approve. ' +
			'A `DENIED:` or `POLICY_DENIED:` answer is final: do not retry the same action in another form. If a hook fails, fix the cause and call again; never try to bypass it.',
		inputSchema: {
			type: 'object',
			properties: {
				paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_PATHS, description: 'Project-relative files to commit, one per item.' },
				message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_LENGTH, description: 'Commit message.' }
			},
			required: ['paths', 'message'],
			additionalProperties: false
		}
	},
	{
		name: 'git_push',
		description: 'Push the current branch to its upstream (or to origin, setting it as upstream). Never forces, never pushes tags, and never pushes main, master, develop, trunk, the remote default branch, init.defaultBranch or a branch the user marked as protected. The project\'s pre-push hooks run. ' +
			'The user is asked to approve. A `DENIED:` or `POLICY_DENIED:` answer is final: do not retry it. Publishing packages and creating releases are not available.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false }
	}
];

class GitToolError extends Error { }
const refuse = (reason: string): never => { throw new GitToolError('POLICY_DENIED: ' + reason); };

/** True for a project path the agent must never commit. */
export function isSensitiveGitPath(relative: string): boolean {
	const segments = relative.split('/');
	return segments.some(segment => SENSITIVE_SEGMENTS.has(segment.toLowerCase())) || SECRET_NAME.test(segments[segments.length - 1]) ||
		/^(?:\.git-credentials|\.htpasswd|kubeconfig|.*\.(?:jks|keystore|tfstate(?:\.backup)?|tfvars(?:\.json)?))$/i.test(segments[segments.length - 1]);
}

const git = async (root: string, args: string[]): Promise<string | undefined> =>
	(await gitOutput(root, [...GIT_BASE, ...args]).then(buffer => buffer.toString('utf8').trim(), () => undefined));

/** Absolute path git itself resolves for `name` (honours `core.hooksPath`, worktrees and `GIT_DIR`); `undefined` outside a repository. */
async function gitPath(root: string, name: string): Promise<string | undefined> {
	const found = await git(root, ['rev-parse', '--git-path', name]);
	return found ? path.resolve(root, found) : undefined;
}

/** sha256 over the repository config and every non-sample hook script (name and content), wherever `core.hooksPath` points. */
export async function repoFingerprint(root: string): Promise<string> {
	const hash = createHash('sha256');
	const config = await gitPath(root, 'config');
	hash.update('config\0').update(config ? await fs.readFile(config).catch(() => '') : 'no-repo');
	const hooks = await gitPath(root, 'hooks');
	let count = 0, bytes = 0;
	const visit = async (directory: string, depth: number): Promise<void> => {
		if (depth > 8) { throw Error('HARNESS_OPERATION_FAILED'); }
		const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') { return []; }
			throw error;
		});
		for (const name of names.sort()) {
			if (name.endsWith('.sample')) { continue; }
			if (++count > MAX_HOOK_FILES) { throw Error('HARNESS_OPERATION_FAILED'); }
			const file = path.join(directory, name);
			const stat = await fs.lstat(file);
			hash.update('\0hook\0' + path.relative(hooks!, file) + '\0' + stat.mode + '\0');
			if (stat.isDirectory()) { await visit(file, depth + 1); continue; }
			if (!stat.isFile() || (bytes += stat.size) > 1024 * 1024) { throw Error('HARNESS_OPERATION_FAILED'); }
			hash.update(await fs.readFile(file));
		}
	};
	if (hooks) { await visit(hooks, 0); }
	return hash.digest('hex');
}

const insideOf = (parent: string, candidate: string): boolean => candidate === parent || candidate.startsWith(parent + path.sep);

/**
 * Refuses when the repository config or hooks differ from the start of the run, or when the hook directory lives inside the
 * working tree (for example `core.hooksPath=.githooks`) and has uncommitted changes or is part of the files to commit.
 */
async function assertHooksUntouched(context: GitToolsContext, paths: readonly string[]): Promise<void> {
	const { root } = context;
	if (context.repoBaseline !== undefined && await repoFingerprint(root) !== context.repoBaseline) { return refuse('repo-config-changed'); }
	const hooks = await gitPath(root, 'hooks');
	if (!hooks) { return; }
	const real = await fs.realpath(root).catch(() => root);
	const hooksReal = await fs.realpath(hooks).catch(() => hooks);
	if (!insideOf(real, hooksReal)) { return; }
	const relative = path.relative(real, hooksReal).split(path.sep).join('/');
	if (!relative || relative === '.git' || relative.startsWith('.git/')) { return; }
	if (paths.some(file => file === relative || file.startsWith(relative + '/'))) { return refuse('hooks-modified'); }
	// An unreadable status must not read as "clean".
	if (await git(root, ['status', '--porcelain', '--untracked-files=all', '--', relative]) !== '') { return refuse('hooks-modified'); }
}

/** One project-relative path with `/` separators, validated; throws a `POLICY_DENIED` error otherwise. */
async function checkPath(root: string, raw: unknown): Promise<string> {
	if (typeof raw !== 'string' || !raw || raw.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) { return refuse('invalid-path'); }
	if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('\\') || raw.startsWith('/')) { return refuse('absolute-path'); }
	if (raw.startsWith('-') || raw.startsWith(':')) { return refuse('invalid-path'); }
	if (/[\\/]$/.test(raw)) { return refuse('directory-not-allowed'); }
	const relative = path.posix.normalize(raw.replace(/\\/g, '/')).replace(/^(\.\/)+/, '');
	if (relative === '.' || relative === '..' || relative.startsWith('../')) { return refuse(relative === '.' ? 'directory-not-allowed' : 'path-outside-project'); }
	if (isSensitiveGitPath(relative)) { return refuse('sensitive-file'); }
	const absolute = path.join(root, relative);
	const stat = await fs.lstat(absolute).catch(() => undefined);
	if (stat) {
		if (stat.isDirectory()) { return refuse('directory-not-allowed'); }
		// Compared against the canonical root: a junction or a differently-cased root must not make a real path look foreign.
		const canonicalRoot = await fs.realpath(root).catch(() => root);
		const parent = await fs.realpath(path.dirname(absolute)).catch(() => undefined);
		const target = await fs.realpath(absolute).catch(() => undefined);
		const inside = (candidate: string | undefined): boolean => !!candidate && insideOf(canonicalRoot, candidate);
		if (!inside(parent) || !inside(target)) { return refuse('path-outside-project'); }
	} else if (await git(root, ['ls-files', '--error-unmatch', '--', relative]) === undefined) {
		// A missing file may only be committed as a deletion of something git tracks.
		return refuse('path-not-found');
	}
	return relative;
}

const currentBranch = async (root: string): Promise<string> => {
	const branch = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
	return branch && REF_NAME.test(branch) && !branch.startsWith('-') ? branch : refuse('no-current-branch');
};

const clip = (text: string, length: number): string => text.length > length ? text.slice(0, length - 1) + '...' : text;

/** `permissions.decide` then, for `ask`, the user's approval. Returns the denial text, or `undefined` to proceed. */
async function authorize(context: GitToolsContext, request: Extract<PermissionRequest, { kind: 'git_commit' | 'git_push' }>, title: string, detail: string[]): Promise<string | undefined> {
	const verdict = context.permissions.decide(request);
	if (verdict.decision === 'deny') { return 'POLICY_DENIED: ' + (verdict.reason ?? verdict.rule ?? 'denied by permissions'); }
	if (verdict.decision === 'allow') { return undefined; }
	return requestApproval(context.ask, { kind: request.kind, title, detail, rule: suggestRule(request) });
}

async function runGit(context: GitToolsContext, args: string[], timeoutSec?: number): Promise<Awaited<ReturnType<typeof runCommand>>> {
	return runCommand({
		root: context.root, cwd: '.', command: 'git', args: [...GIT_BASE, ...args], timeoutSec, logDirectory: context.logDirectory,
		// Never wait for a credential or an editor: an unanswered prompt would hang the run.
		env: { ...context.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' }
	});
}

const failure = (what: string, result: { exitCode: number | null; timedOut: boolean; output: string }): GitToolResult =>
	({ isError: true, text: what + ' failed (' + (result.timedOut ? 'timed out' : 'exit ' + result.exitCode) + '). Fix the cause; do not bypass hooks or checks.\n' + (result.output || '(no output)') });

async function commit(context: GitToolsContext, input: { paths?: unknown; message?: unknown }): Promise<GitToolResult> {
	const { root } = context;
	if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > MAX_PATHS) { return refuse('invalid-paths'); }
	if (typeof input.message !== 'string' || input.message.includes('\0')) { return refuse('invalid-message'); }
	const message = input.message.trim();
	if (message.length < 1 || message.length > MAX_MESSAGE_LENGTH) { return refuse('invalid-message'); }
	const paths = [...new Set(await Promise.all(input.paths.map(entry => checkPath(root, entry))))];
	const branch = await currentBranch(root);
	await assertHooksUntouched(context, paths);
	const denial = await authorize(context, { kind: 'git_commit', branch, files: paths, message }, 'Commit',
		['branch: ' + branch, 'files: ' + clip(paths.join(', '), 300), 'message: ' + clip(message.replace(/\s+/g, ' '), 300)]);
	if (denial) { return { isError: true, text: denial }; }
	await assertHooksUntouched(context, paths);
	if (await currentBranch(root) !== branch) { return refuse('branch-changed'); }
	if (context.checkPermissions && !await context.checkPermissions()) { return refuse('project-permissions-changed'); }
	const added = await runGit(context, ['add', '--', ...paths]);
	if (added.exitCode !== 0) { return failure('git add', added); }
	await assertHooksUntouched(context, paths);
	// `--` with paths commits only those files, so anything else the user staged stays out of this commit. Hooks run; there is no `--no-verify`.
	const committed = await runGit(context, ['commit', '-m', message, '--', ...paths]);
	if (committed.exitCode !== 0) { return failure('git commit', committed); }
	const head = await git(root, ['rev-parse', '--short', 'HEAD']);
	return { isError: false, text: 'COMMITTED ' + (head ?? '') + ' on ' + branch + ': ' + paths.length + ' file(s)\n' + (committed.output || '') };
}

/** Where `branch` would be pushed; throws when the target is anything but the same-named branch of a plain remote. */
async function pushTarget(root: string, branch: string, protectedBranches: readonly string[] = []): Promise<{ remote: string; setUpstream: boolean }> {
	const lower = branch.toLowerCase();
	const defaultBranch = (await git(root, ['config', '--get', 'init.defaultBranch']))?.toLowerCase();
	if (PROTECTED_BRANCHES.has(lower) || lower === defaultBranch || protectedBranches.some(pattern => globMatches(pattern.toLowerCase(), lower))) { return refuse('protected-branch'); }
	const configured = await git(root, ['config', '--get', 'branch.' + branch + '.remote']);
	const merge = await git(root, ['config', '--get', 'branch.' + branch + '.merge']);
	let remote = 'origin', setUpstream = true;
	if (configured !== undefined || merge !== undefined) {
		// An upstream with another name would make a push land on a different branch (for example a feature branch tracking main).
		if (!configured || merge !== 'refs/heads/' + branch) { return refuse('upstream-mismatch'); }
		remote = configured; setUpstream = false;
	}
	if (!REMOTE_NAME.test(remote) || remote === '.') { return refuse('invalid-remote'); }
	if (!(await git(root, ['remote']))?.split(/\r?\n/).includes(remote)) { return refuse('no-remote'); }
	// The remote's own default branch (origin/HEAD) is protected even when it is not called main.
	const head = await git(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/' + remote + '/HEAD']);
	if (head === remote + '/' + branch) { return refuse('protected-branch'); }
	return { remote, setUpstream };
}

async function push(context: GitToolsContext): Promise<GitToolResult> {
	const branch = await currentBranch(context.root);
	const { remote, setUpstream } = await pushTarget(context.root, branch, context.protectedBranches);
	await assertHooksUntouched(context, []);
	const denial = await authorize(context, { kind: 'git_push', branch, remote }, 'Push', ['branch: ' + branch, 'remote: ' + remote]);
	if (denial) { return { isError: true, text: denial }; }
	await assertHooksUntouched(context, []);
	if (await currentBranch(context.root) !== branch) { return refuse('branch-changed'); }
	const currentTarget = await pushTarget(context.root, branch, context.protectedBranches);
	if (currentTarget.remote !== remote || currentTarget.setUpstream !== setUpstream) { return refuse('upstream-mismatch'); }
	if (context.checkPermissions && !await context.checkPermissions()) { return refuse('project-permissions-changed'); }
	// Explicit full refspec: always the current branch to the same-named branch, never a force (`+`), tag or deletion. Pre-push hooks run.
	const refspec = 'refs/heads/' + branch + ':refs/heads/' + branch;
	const pushed = await runGit(context, ['-c', 'push.followTags=false', 'push', ...(setUpstream ? ['--set-upstream'] : []), '--no-tags', remote, refspec], PUSH_TIMEOUT_SEC);
	if (pushed.exitCode !== 0) { return failure('git push', pushed); }
	return { isError: false, text: 'PUSHED ' + branch + ' to ' + remote + '\n' + (pushed.output || '') };
}

/** Run one git tool call; every refusal is a short `POLICY_DENIED: <reason>` the model must not retry. */
export async function handleGitTool(context: GitToolsContext, name: string, input: unknown): Promise<GitToolResult> {
	try {
		const value = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
		if (name === 'git_commit') { return await commit(context, value); }
		if (name === 'git_push') { return await push(context); }
		return { isError: true, text: 'Unknown tool' };
	} catch (error) {
		if (error instanceof GitToolError) { return { isError: true, text: error.message }; }
		return { isError: true, text: /^HARNESS_[A-Z_]+$/.test((error as Error).message) ? (error as Error).message : 'HARNESS_EXECUTABLE_UNAVAILABLE' };
	}
}
