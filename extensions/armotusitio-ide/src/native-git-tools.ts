/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Structured branch, commit, push and GitHub PR tools for chat agents, served by `ats-runner` beside `run`.
 * The agent never gets raw git or gh. The immovable floor restricts file selection, branch targets and remote updates:
 * no force, reset, stash, merge, bypass, tags, secret files or default-branch pushes. GitHub PR operations require an
 * exact base and payload. The project's permissions and IDE approvals can only further restrict these tools.
 * Commit/push run the project's own hooks. The IDE pins hooks and config across calls; only its own verified branch
 * switch or first upstream push can renew that baseline. Modified hooks and unrelated config changes remain blocked.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitOutput } from './native-git.ts';
import { runCommand } from './native-command-runner.ts';
import { requestApproval, type ApprovalAsk, type ApprovalSubject } from './native-approval.ts';
import { globMatches, suggestRule, type PermissionSet } from './native-permissions.ts';
import type { PermissionRequest } from './native-permissions-types.ts';
import { SECRET_NAME } from './native-sensitive-scope.ts';
import { redactSecrets } from './native-redact.ts';

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
	/** Stops commands when the provider session is cancelled. */
	signal?: AbortSignal;
	/** Offline fixture only; the runner constructs this context without a replacement. */
	ghRunner?: (args: string[]) => Promise<Awaited<ReturnType<typeof runCommand>>>;
}
export interface GitToolResult { isError: boolean; text: string; /** New trusted fingerprint after an IDE-owned git config mutation. */ repoBaseline?: string }

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
	},
	{
		name: 'git_branch_create',
		description: 'Create a named, exclusive local branch without force, reset, stash or overwriting worktrees. Optional from: HEAD or an existing origin/<branch> tracking ref (for example origin/qa); do not assume qa for other repositories. Preserve local changes and reject a different base if the checkout is dirty. Reuses the already checked out branch. Permissions and user approval apply; DENIED is final.',
		inputSchema: {
			type: 'object',
			properties: {
				branch: { type: 'string', minLength: 1, maxLength: 200 },
				from: { type: 'string', description: 'HEAD (default) or an already available origin/<branch> ref.' }
			},
			required: ['branch'],
			additionalProperties: false
		}
	},
	{
		name: 'git_pr_upsert',
		description: 'Create or update the GitHub pull request for the current, already pushed branch. Provide the explicit target base (qa for RedEvent, not globally), complete title and body. Reuse an existing open PR, never duplicate one or reopen a closed PR. No issue association, auto-merge, merge, actions or bypass. The IDE may ask for approval showing repository, head, base and exact content; DENIED is final.',
		inputSchema: {
			type: 'object',
			properties: {
				base: { type: 'string', minLength: 1, maxLength: 200 },
				title: { type: 'string', minLength: 1, maxLength: 160 },
				body: { type: 'string', minLength: 1, maxLength: 2000 }
			},
			required: ['base', 'title', 'body'],
			additionalProperties: false
		}
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

/** Fingerprint only hooks, so legitimate branch/upstream config changes cannot launder modified hooks. */
async function hookFingerprint(root: string): Promise<string> {
	const hash = createHash('sha256');
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

/** sha256 over repository configuration and hook scripts, including worktree-specific metadata. */
export async function repoFingerprint(root: string): Promise<string> {
	const hash = createHash('sha256');
	const config = await gitPath(root, 'config');
	hash.update('config\0').update(config ? await fs.readFile(config).catch(() => '') : 'no-repo');
	hash.update('\0hooks\0').update(await hookFingerprint(root));
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
async function authorize(context: GitToolsContext, request: Exclude<PermissionRequest, { kind: 'run' | 'edit' }>, title: string, detail: string[], subject: ApprovalSubject = {}): Promise<string | undefined> {
	const verdict = context.permissions.decide(request);
	if (verdict.decision === 'deny') { return 'POLICY_DENIED: ' + (verdict.reason ?? verdict.rule ?? 'denied by permissions'); }
	if (verdict.decision === 'allow') { return undefined; }
	return requestApproval(context.ask, { kind: request.kind, title, detail, rule: suggestRule(request), ...subject });
}

async function runGit(context: GitToolsContext, args: string[], timeoutSec?: number): Promise<Awaited<ReturnType<typeof runCommand>>> {
	if (context.signal?.aborted) { return refuse('cancelled'); }
	return runCommand({
		root: context.root, cwd: '.', command: 'git', args: [...GIT_BASE, ...args], timeoutSec, logDirectory: context.logDirectory,
		// Never wait for a credential or an editor: an unanswered prompt would hang the run.
		env: { ...context.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' }, signal: context.signal
	});
}

const failure = (what: string, result: { exitCode: number | null; timedOut: boolean; cancelled?: boolean; output: string }): GitToolResult =>
	({ isError: true, text: what + ' failed (' + (result.cancelled ? 'cancelled' : result.timedOut ? 'timed out' : 'exit ' + result.exitCode) + '). Fix the cause; do not bypass hooks or checks.\n' + (result.output || '(no output)') });

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

/** Read-only, bounded verification that this IDE workspace is the actual root of its git checkout. */
async function repository(root: string): Promise<string> {
	const top = await git(root, ['rev-parse', '--show-toplevel']);
	if (!top || await fs.realpath(top).catch(() => '') !== await fs.realpath(root)) { return refuse('repository-root-mismatch'); }
	const url = await git(root, ['config', '--get', 'remote.origin.url']);
	const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url ?? '');
	return match ? match[1] : refuse('github-origin-required');
}

const validName = async (root: string, raw: unknown): Promise<string> => {
	if (typeof raw !== 'string' || !REF_NAME.test(raw) || raw.startsWith('-') || raw.startsWith('/') || raw.endsWith('/') || raw.includes('..')) { return refuse('invalid-branch'); }
	return await git(root, ['check-ref-format', '--branch', raw]) === raw ? raw : refuse('invalid-branch');
};

/** Current config entries, excluding the exact upstream pair that git_push is allowed to install. */
function otherConfig(entries: string | undefined, branch: string): string[] {
	if (entries === undefined) { return refuse('repo-config-unavailable'); }
	return entries.split('\0').filter(entry => entry && !entry.startsWith('branch.' + branch + '.remote\n') && !entry.startsWith('branch.' + branch + '.merge\n')).sort();
}

async function branchCreate(context: GitToolsContext, input: Record<string, unknown>): Promise<GitToolResult> {
	const { root } = context;
	const branch = await validName(root, input.branch);
	const from = input.from === undefined ? 'HEAD' : input.from;
	if (typeof from !== 'string' || (from !== 'HEAD' && !/^origin\/[A-Za-z0-9._/-]{1,200}$/.test(from))) { return refuse('invalid-start-point'); }
	if (from !== 'HEAD') { await validName(root, from.slice('origin/'.length)); }
	const repo = await repository(root);
	const current = await currentBranch(root);
	const initialHead = await git(root, ['rev-parse', '--verify', 'HEAD']);
	if (!initialHead) { return refuse('no-head'); }
	const start = from === 'HEAD' ? initialHead : await git(root, ['rev-parse', '--verify', 'refs/remotes/' + from + '^{commit}']);
	if (!start) { return refuse('base-ref-missing'); }
	const dirty = await git(root, ['status', '--porcelain', '--untracked-files=all']);
	if (dirty === undefined) { return refuse('git-status-unavailable'); }
	if (from !== 'HEAD' && start !== initialHead && dirty) { return refuse('local-changes-on-base-switch'); }
	await assertHooksUntouched(context, []);
	const exists = await git(root, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]) !== undefined;
	const existingHead = exists ? await git(root, ['rev-parse', '--verify', 'refs/heads/' + branch + '^{commit}']) : undefined;
	if (exists && current !== branch && dirty && existingHead !== initialHead) { return refuse('local-changes-on-branch-reuse'); }
	if (PROTECTED_BRANCHES.has(branch.toLowerCase()) || context.protectedBranches?.some(pattern => globMatches(pattern.toLowerCase(), branch.toLowerCase()))) { return refuse('protected-branch'); }
	const actualFrom = exists ? 'refs/heads/' + branch : from;
	const denial = await authorize(context, { kind: 'git_branch_create', repo, branch, from: actualFrom }, 'Create or reuse branch',
		['repository: ' + repo, 'branch: ' + branch, 'from: ' + actualFrom], { repo, branch, from: actualFrom });
	if (denial) { return { isError: true, text: denial }; }
	await assertHooksUntouched(context, []);
	if (await currentBranch(root) !== current || await git(root, ['rev-parse', '--verify', 'HEAD']) !== initialHead ||
		await git(root, ['status', '--porcelain', '--untracked-files=all']) !== dirty ||
		(from !== 'HEAD' && await git(root, ['rev-parse', '--verify', 'refs/remotes/' + from + '^{commit}']) !== start) ||
		(exists && await git(root, ['rev-parse', '--verify', 'refs/heads/' + branch + '^{commit}']) !== existingHead)) { return refuse('repository-changed'); }
	if (context.checkPermissions && !await context.checkPermissions()) { return refuse('project-permissions-changed'); }
	if (exists && current === branch) { return { isError: false, text: 'BRANCH_REUSED ' + branch + ' in ' + repo }; }
	const hooks = await hookFingerprint(root);
	const beforeConfig = await git(root, ['config', '--local', '--list', '-z']);
	const switched = await runGit(context, exists ? ['switch', branch] : ['switch', '--no-track', '--create', branch, from]);
	if (switched.exitCode !== 0 || switched.cancelled || switched.timedOut) { return failure('git switch', switched); }
	if (await currentBranch(root) !== branch || await hookFingerprint(root) !== hooks ||
		await git(root, ['config', '--local', '--list', '-z']) !== beforeConfig) { return refuse('repo-config-changed'); }
	if (context.checkPermissions && !await context.checkPermissions()) { return refuse('project-permissions-changed'); }
	return { isError: false, text: (exists ? 'BRANCH_REUSED ' : 'BRANCH_CREATED ') + branch + ' from ' + actualFrom + ' in ' + repo, repoBaseline: await repoFingerprint(root) };
}

async function runGh(context: GitToolsContext, args: string[]): Promise<Awaited<ReturnType<typeof runCommand>>> {
	if (context.signal?.aborted) { return refuse('cancelled'); }
	if (context.ghRunner) { return context.ghRunner(args); }
	return runCommand({
		root: context.root, cwd: '.', command: 'gh', args, timeoutSec: PUSH_TIMEOUT_SEC,
		logDirectory: context.logDirectory, signal: context.signal,
		env: { ...context.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
	});
}

interface PrState { number: number; headRefName: string; baseRefName: string; state: string; title: string; body: string; url: string; headRepositoryOwner: { login: string }; headRepository: { name: string } }
async function existingPr(context: GitToolsContext, repo: string, branch: string, base: string): Promise<PrState | undefined> {
	const result = await runGh(context, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all',
		'--json', 'number,headRefName,baseRefName,state,title,body,url,headRepositoryOwner,headRepository', '--limit', '100']);
	if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.truncated) { return refuse('github-pr-query-failed'); }
	let data: unknown;
	try { data = JSON.parse(result.output); } catch { return refuse('github-pr-response-invalid'); }
	if (!Array.isArray(data) || data.length > 100 || !data.every(pr => pr && typeof pr === 'object')) { return refuse('github-pr-response-invalid'); }
	const prs = data as PrState[];
	if (!prs.every(pr => Number.isSafeInteger(pr.number) && pr.number > 0 && pr.headRefName === branch &&
		typeof pr.baseRefName === 'string' && typeof pr.state === 'string' && typeof pr.title === 'string' &&
		typeof pr.body === 'string' && pr.url === 'https://github.com/' + repo + '/pull/' + pr.number &&
		pr.headRepositoryOwner?.login === repo.split('/')[0] && pr.headRepository?.name === repo.split('/')[1])) { return refuse('github-pr-response-invalid'); }
	if (prs.some(pr => pr.baseRefName !== base)) { return refuse('existing-pr-other-base'); }
	if (prs.length > 1) { return refuse('ambiguous-pr'); }
	if (prs[0] && prs[0].state !== 'OPEN') { return refuse('closed-pr-exists'); }
	return prs[0];
}

async function prUpsert(context: GitToolsContext, input: Record<string, unknown>): Promise<GitToolResult> {
	const { root } = context;
	const repo = await repository(root);
	const branch = await currentBranch(root);
	const base = await validName(root, input.base);
	if (base === branch) { return refuse('pr-base-is-head'); }
	if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160 ||
		typeof input.body !== 'string' || !input.body.trim() || input.body.length > 2000 || /[\0]/.test(input.title + input.body) ||
		redactSecrets(input.title + input.body) !== input.title + input.body) { return refuse('invalid-pr-content'); }
	const title = input.title.trim(), body = input.body;
	await assertHooksUntouched(context, []);
	const old = await existingPr(context, repo, branch, base);
	if (old && old.title === title && old.body === body) { return { isError: false, text: 'PR_REUSED ' + old.url + ' (' + branch + ' -> ' + base + ')' }; }
	const action = old ? 'update #' + old.number : 'create';
	const denial = await authorize(context, { kind: 'git_pr_upsert', repo, branch, base, title, body }, 'GitHub PR',
		['repository: ' + repo, 'head: ' + branch, 'base: ' + base, 'action: ' + action, 'title: ' + title],
		{ repo, branch, base, prTitle: title, prBody: body, action });
	if (denial) { return { isError: true, text: denial }; }
	await assertHooksUntouched(context, []);
	if (await currentBranch(root) !== branch || await repository(root) !== repo ||
		(context.checkPermissions && !await context.checkPermissions())) { return refuse('repository-changed'); }
	const checked = await existingPr(context, repo, branch, base);
	if ((old?.number ?? 0) !== (checked?.number ?? 0) || (old && checked && (old.title !== checked.title || old.body !== checked.body))) {
		return refuse('pr-state-changed');
	}
	const args = old
		? ['pr', 'edit', String(old.number), '--repo', repo, '--title', title, '--body', body]
		: ['pr', 'create', '--repo', repo, '--head', branch, '--base', base, '--title', title, '--body', body];
	const result = await runGh(context, args);
	if (result.exitCode !== 0 || result.cancelled || result.timedOut || result.truncated) { return failure('GitHub PR', result); }
	await assertHooksUntouched(context, []);
	if (await currentBranch(root) !== branch || (context.checkPermissions && !await context.checkPermissions())) { return refuse('repository-changed'); }
	const verified = await existingPr(context, repo, branch, base);
	if (!verified || verified.title !== title || verified.body !== body) { return refuse('pr-verification-failed'); }
	return { isError: false, text: (old ? 'PR_UPDATED ' : 'PR_CREATED ') + verified.url + ' (' + branch + ' -> ' + base + ')' };
}

async function push(context: GitToolsContext): Promise<GitToolResult> {
	const branch = await currentBranch(context.root);
	const { remote, setUpstream } = await pushTarget(context.root, branch, context.protectedBranches);
	await assertHooksUntouched(context, []);
	const hooks = await hookFingerprint(context.root);
	const beforeConfig = otherConfig(await git(context.root, ['config', '--local', '--list', '-z']), branch);
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
	if (pushed.exitCode !== 0 || pushed.cancelled || pushed.timedOut) { return failure('git push', pushed); }
	if (await hookFingerprint(context.root) !== hooks ||
		JSON.stringify(otherConfig(await git(context.root, ['config', '--local', '--list', '-z']), branch)) !== JSON.stringify(beforeConfig)) {
		return refuse('repo-config-changed');
	}
	if (setUpstream && (await git(context.root, ['config', '--get', 'branch.' + branch + '.remote']) !== remote ||
		await git(context.root, ['config', '--get', 'branch.' + branch + '.merge']) !== 'refs/heads/' + branch)) { return refuse('upstream-mismatch'); }
	if (context.checkPermissions && !await context.checkPermissions()) { return refuse('project-permissions-changed'); }
	return { isError: false, text: 'PUSHED ' + branch + ' to ' + remote + '\n' + (pushed.output || ''), repoBaseline: await repoFingerprint(context.root) };
}

/** Run one git tool call; every refusal is a short `POLICY_DENIED: <reason>` the model must not retry. */
export async function handleGitTool(context: GitToolsContext, name: string, input: unknown): Promise<GitToolResult> {
	try {
		const value = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
		if (name === 'git_commit') { return await commit(context, value); }
		if (name === 'git_push') { return await push(context); }
		if (name === 'git_branch_create') { return await branchCreate(context, value); }
		if (name === 'git_pr_upsert') { return await prUpsert(context, value); }
		return { isError: true, text: 'Unknown tool' };
	} catch (error) {
		if (error instanceof GitToolError) { return { isError: true, text: error.message }; }
		return { isError: true, text: /^HARNESS_[A-Z_]+$/.test((error as Error).message) ? (error as Error).message : 'HARNESS_EXECUTABLE_UNAVAILABLE' };
	}
}
