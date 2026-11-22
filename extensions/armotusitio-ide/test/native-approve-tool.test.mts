/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { commandVerdict, decidePermissionPrompt, plainCommandWords, shellSegments, type ApproveContext } from '../src/native-approve-tool.ts';
import type { ApprovalDraft } from '../src/native-approval.ts';
import { createCommandPolicy, denialText } from '../src/native-command-policy.ts';
import { addUserRule, loadPermissions } from '../src/native-permissions.ts';

test('only plain command lines become words; anything a shell would interpret is refused', () => {
	assert.deepEqual([
		'pnpm --dir apps/web lint', 'node "scripts/build x.js" --flag', 'git log --oneline -5', ' npm   test ',
		'ls | grep a', 'echo $HOME', 'echo "$HOME"', 'rm -rf *', 'cat a > b', 'FOO=1 node a.js', 'a && b', 'node a.js; node b.js', 'echo `id`', 'echo "unterminated', 'node scripts\\a.js', ''
	].map(plainCommandWords), [
		['pnpm', '--dir', 'apps/web', 'lint'], ['node', 'scripts/build x.js', '--flag'], ['git', 'log', '--oneline', '-5'], ['npm', 'test'],
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined
	]);
});

test('a shell line splits into its commands at &&, ||, ; and |, with safe redirections and variables; anything else is refused', () => {
	assert.deepEqual([
		'git status && git diff', 'pnpm test 2>&1 | tail -20', 'pnpm lint; pnpm test', 'NODE_ENV=test pnpm test', 'git diff HEAD~1 > /dev/null', 'node a.js || echo "a | b"',
		'NODE_OPTIONS=--require=x node a.js', 'pnpm test > out.txt', 'sleep 9 &', 'ls && ', '&& ls', 'cat ~/x', 'node --x=~/y', 'git log $(id)', 'ls *.ts', 'a |& b'
	].map(shellSegments), [
		{ segments: [['git', 'status'], ['git', 'diff']], compound: true }, { segments: [['pnpm', 'test'], ['tail', '-20']], compound: true },
		{ segments: [['pnpm', 'lint'], ['pnpm', 'test']], compound: true }, { segments: [['pnpm', 'test']], compound: true }, { segments: [['git', 'diff', 'HEAD~1']], compound: true },
		{ segments: [['node', 'a.js'], ['echo', 'a | b']], compound: true },
		undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined
	]);
});

test('a compound line runs when every command may run, asks once for the whole line when one asks, and is denied naming the refused command', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-compound-')));
	try {
		const permissions = await loadPermissions(root, root, undefined, { preset: 'dev' });
		const policy = createCommandPolicy({ subprojects: [{ path: '.', ecosystem: 'node', packageManager: 'pnpm', scripts: ['test', 'lint'] }], delegate: false, extras: [], permissions });
		const summary = (line: string) => { const verdict = commandVerdict({ policy }, line); return verdict.verdict === 'ask' ? ['ask', verdict.draft.rule, verdict.draft.command] : verdict.verdict === 'deny' ? ['deny', verdict.message.split('\n')[0], verdict.message.split('\n').at(-1)] : ['allow']; };
		assert.deepEqual(['git status && git diff', 'pnpm test 2>&1 | tail -20', 'pnpm lint && node scripts/release.mjs', 'git log | sh', 'cd src && ls'].map(summary), [
			['allow'], ['allow'], ['ask', '', 'pnpm lint && node scripts/release.mjs'], ['deny', 'POLICY_DENIED: shell-operator', 'In: sh'], ['deny', 'POLICY_DENIED: change-directory', 'In: cd src']
		]);
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('Claude permission prompts are decided by the same policy and permissions as the structured tools', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-approve-')));
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-approve-home-'));
	try {
		await fs.mkdir(path.join(root, 'src'));
		await addUserRule('edit:secret/**', 'deny', home);
		const permissions = await loadPermissions(root, home, undefined, { preset: 'dev' });
		const asked: ApprovalDraft[] = [];
		const context: ApproveContext = {
			root, permissions, policy: createCommandPolicy({ subprojects: [], delegate: false, extras: ['node'], permissions }),
			ask: async card => { asked.push(card); return card.detail[0].includes('docker images') ? 'once' : 'deny'; }
		};
		const decide = (tool_name: string, input: Record<string, unknown>) => decidePermissionPrompt(context, { tool_name, input });
		const verdict = async (tool_name: string, input: Record<string, unknown>) => { const decision = await decide(tool_name, input); return decision.behavior === 'allow' ? 'allow' : decision.message.split('\n', 1)[0]; };
		assert.deepEqual([
			await verdict('Bash', { command: 'node --version' }),
			await verdict('Bash', { command: 'docker ps' }),
			await verdict('Bash', { command: 'docker images' }),
			// A compound line is judged command by command: both read-only here.
			await verdict('Bash', { command: 'ls | grep x' }),
			await verdict('Bash', { command: 'cd apps/web' }),
			await verdict('Bash', { command: 'node --version', run_in_background: true }),
			await verdict('Bash', { command: 'gh auth token' }),
			await verdict('Edit', { file_path: path.join(root, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }),
			await verdict('Write', { file_path: 'src/new.ts', content: 'x' }),
			await verdict('Write', { file_path: path.join(root, '.git', 'config'), content: 'x' }),
			await verdict('Edit', { file_path: path.join(os.tmpdir(), 'outside.ts'), old_string: 'a', new_string: 'b' }),
			await verdict('Write', { file_path: 'secret/key.txt', content: 'x' }),
			await verdict('Read', { file_path: path.join(root, 'src', 'a.ts') }),
			await verdict('Read', { file_path: path.join(os.tmpdir(), 'outside.ts') }),
			// Credential files are refused the same way to Read and to the terminal, and one refused command denies its line.
			await verdict('Read', { file_path: path.join(root, '.env') }),
			await verdict('Bash', { command: 'cat .env' }),
			await verdict('Bash', { command: 'git status && rm -rf src' }),
			await verdict('WebFetch', { url: 'https://example.com' }),
			await verdict('Bash', 'not an object' as unknown as Record<string, unknown>)
		], [
			'allow', 'DENIED: the user did not allow it', 'allow', 'allow', 'POLICY_DENIED: change-directory', 'POLICY_DENIED: background', 'POLICY_DENIED: credential-access',
			'allow', 'allow', 'POLICY_DENIED: protected-path', 'POLICY_DENIED: path-outside-project', 'POLICY_DENIED: edit:secret/**', 'allow', 'POLICY_DENIED: path-outside-project',
			'POLICY_DENIED: credential-access', 'POLICY_DENIED: credential-access', 'POLICY_DENIED: destructive', 'DENIED: the user did not allow it',
			denialText('invalid').split('\n', 1)[0]
		]);
		// An allowed prompt hands the input back unchanged; the cards were the two external CLI calls.
		assert.deepEqual({ allowed: await decide('Bash', { command: 'node --version', description: 'version' }), cards: asked.map(card => card.detail[0]) },
			{ allowed: { behavior: 'allow', updatedInput: { command: 'node --version', description: 'version' } }, cards: ['command: docker ps', 'command: docker images', 'host: example.com'] });
	} finally {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test('a tool of a user-added MCP server asks by default, obeys mcp rules, and an unknown server is unavailable', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-approve-mcp-')));
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-approve-mcp-home-'));
	try {
		await addUserRule('mcp:github/list_issues', 'allow', home);
		await addUserRule('mcp:github/delete_repo', 'deny', home);
		const permissions = await loadPermissions(root, home, undefined, { preset: 'dev' });
		const asked: ApprovalDraft[] = [];
		const context: ApproveContext = {
			root, permissions, policy: createCommandPolicy({ subprojects: [], delegate: false, extras: [], permissions }), mcpServers: ['github'],
			ask: async card => { asked.push(card); return 'once'; }
		};
		const verdict = async (tool_name: string) => { const decision = await decidePermissionPrompt(context, { tool_name, input: { title: 'x'.repeat(500), n: 1 } }); return decision.behavior === 'allow' ? 'allow' : decision.message.split('\n', 1)[0]; };
		const results = [await verdict('mcp__github__list_issues'), await verdict('mcp__github__delete_repo'), await verdict('mcp__github__create_issue'), await verdict('mcp__other__anything')];
		assert.deepEqual({ results, cards: asked.map(card => ({ kind: card.kind, detail: card.detail.map(line => line.slice(0, 40)) })) }, {
			results: ['allow', 'POLICY_DENIED: mcp:github/delete_repo', 'allow', 'POLICY_DENIED: tool-unavailable'],
			cards: [{ kind: 'mcp', detail: ['server: github', 'tool: create_issue', 'arg title: ' + 'x'.repeat(29), 'arg n: 1'] }]
		});
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('WebFetch asks per host, obeys web rules, and never reaches private or non-https hosts', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-approve-web-')));
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-approve-web-home-'));
	try {
		await addUserRule('web:docs.python.org', 'allow', home);
		await addUserRule('web:*.evil.example', 'deny', home);
		const permissions = await loadPermissions(root, home, undefined, { preset: 'dev' });
		const asked: ApprovalDraft[] = [];
		const context: ApproveContext = { root, permissions, policy: createCommandPolicy({ subprojects: [], delegate: false, extras: [], permissions }), ask: async card => { asked.push(card); return 'once'; } };
		const verdict = async (url: string) => { const decision = await decidePermissionPrompt(context, { tool_name: 'WebFetch', input: { url, prompt: 'summarize' } }); return decision.behavior === 'allow' ? 'allow' : decision.message.split('\n', 1)[0]; };
		const results = [await verdict('https://docs.python.org/3/'), await verdict('https://a.evil.example/x'), await verdict('https://nodejs.org/api'), await verdict('http://nodejs.org'),
			await verdict('https://localhost/admin'), await verdict('https://192.168.1.10/'), await verdict('https://printer.local/'), await verdict('https://user:pw@nodejs.org/'), await verdict('not a url')];
		assert.deepEqual({ results, cards: asked.map(card => card.detail) }, {
			results: ['allow', 'POLICY_DENIED: web:*.evil.example', 'allow', 'POLICY_DENIED: web-host', 'POLICY_DENIED: web-host', 'POLICY_DENIED: web-host', 'POLICY_DENIED: web-host', 'POLICY_DENIED: web-host', 'POLICY_DENIED: web-host'],
			cards: [['host: nodejs.org', 'url: https://nodejs.org/api']]
		});
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
