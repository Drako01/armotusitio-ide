/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { addUserRule, commandName, dependencyDecision, globMatches, loadPermissions, suggestRule } from '../src/native-permissions.ts';
import type { PermissionPreset, PermissionRequest } from '../src/native-permissions-types.ts';

async function workspace(files: { user?: unknown; project?: unknown } = {}) {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-permissions-')));
	const home = path.join(base, 'home');
	const root = path.join(base, 'project');
	for (const [directory, content] of [[home, files.user], [root, files.project]] as const) {
		await fs.mkdir(path.join(directory, '.armotusitio'), { recursive: true });
		if (content !== undefined) { await fs.writeFile(path.join(directory, '.armotusitio', 'permissions.json'), typeof content === 'string' ? content : JSON.stringify(content)); }
	}
	return { base, home, root, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}
const run = (command: string, ...args: string[]): PermissionRequest => ({ kind: 'run', command, args, cwd: '.' });
const edit = (file: string): PermissionRequest => ({ kind: 'edit', path: file });
const commit: PermissionRequest = { kind: 'git_commit', branch: 'main', files: [], message: 'x' };
const push: PermissionRequest = { kind: 'git_push', branch: 'main', remote: 'origin' };

test('glob matching is literal except for star, iterative, and immune to pathological patterns', () => {
	const started = Date.now();
	const hostile = globMatches('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(4000));
	assert.deepEqual([globMatches('pnpm test*', 'pnpm test --run'), globMatches('pnpm test*', 'pnpm tes'), globMatches('src/**', 'src/a/b.ts'), globMatches('a.b', 'axb'), globMatches('(a+)+$', 'aaaa'), globMatches('*', ''), hostile, Date.now() - started < 2000],
		[true, false, true, false, false, true, false, true]);
});

test('layers: deny beats ask beats allow, the project cannot allow, and the preset answers only when no rule matched', async () => {
	const space = await workspace({
		user: { version: 1, allow: ['run:make*', 'run:go test*', 'edit:docs/**'], ask: ['run:go test ./slow*'], deny: ['edit:secrets/**'] },
		project: { version: 1, allow: ['run:evil*'], ask: ['run:make deploy*'], deny: ['run:make clean*', 'git_push'] }
	});
	try {
		const set = await loadPermissions(space.root, space.home);
		const verdict = (request: PermissionRequest) => { const { decision, source, rule } = set.decide(request); return [decision, source, rule]; };
		assert.deepEqual({
			warnings: set.warnings.length,
			allow: verdict(run('make', 'build')), ask: verdict(run('go', 'test', './slow')), projectAsk: verdict(run('MAKE.EXE', 'deploy', 'x')), projectDeny: verdict(run('make', 'clean')),
			ignoredProjectAllow: verdict(run('evil', 'x')), editDeny: verdict(edit('secrets\\key.txt')), editAllow: verdict(edit('./docs/a/b.md')), push: verdict(push), commit: verdict(commit)
		}, {
			warnings: 1,
			allow: ['allow', 'user', 'run:make*'], ask: ['ask', 'user', 'run:go test ./slow*'], projectAsk: ['ask', 'project', 'run:make deploy*'], projectDeny: ['deny', 'project', 'run:make clean*'],
			ignoredProjectAllow: ['allow', 'preset', undefined], editDeny: ['deny', 'user', 'edit:secrets/**'], editAllow: ['allow', 'user', 'edit:docs/**'], push: ['deny', 'project', 'git_push'], commit: ['ask', 'preset', undefined]
		});
	} finally { await space.cleanup(); }
});

test('invalid, oversized, corrupt or symlinked files fail closed with warnings', async () => {
	const invalid: unknown[] = [
		'{not json', { version: 2 }, { version: 1, bogus: [] }, { version: 1, allow: ['sudo rm'] }, { version: 1, allow: 'run:x' }, { version: 1, preset: 'root' },
		{ version: 1, allow: Array.from({ length: 201 }, (_, index) => 'run:a' + index) }, { version: 1, allow: ['run:' + 'x'.repeat(300)] }, { version: 1, deny: ['run:x\u0000'] }, 'x'.repeat(17 * 1024)
	];
	for (const content of invalid) {
		const space = await workspace({ user: content });
		try {
			const set = await loadPermissions(space.root, space.home, undefined, { preset: 'readonly' });
			assert.deepEqual([set.warnings.length, set.decide(run('make', 'build')).decision], [2, 'deny'], JSON.stringify(content).slice(0, 60));
		} finally { await space.cleanup(); }
	}
	const space = await workspace();
	try {
		await fs.writeFile(path.join(space.base, 'real.json'), JSON.stringify({ version: 1, allow: ['run:*'] }));
		await fs.symlink(path.join(space.base, 'real.json'), path.join(space.home, '.armotusitio', 'permissions.json'));
		const set = await loadPermissions(space.root, space.home, undefined, { preset: 'readonly' });
		assert.deepEqual([set.warnings.length, set.decide(run('make')).decision], [2, 'deny']);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EPERM') { throw error; }
	} finally { await space.cleanup(); }
});

test('presets answer by kind and the user file can only override them with explicit rules', async () => {
	const space = await workspace();
	try {
		const answers = async (preset: PermissionPreset) => {
			const set = await loadPermissions(space.root, space.home, undefined, { preset });
			return [run('make', 'build'), run('git', 'status'), run('node', '--version'), edit('a.ts'), commit, push].map(request => set.decide(request).decision);
		};
		assert.deepEqual({ readonly: await answers('readonly'), dev: await answers('dev'), trusted: await answers('trusted'), fallback: (await loadPermissions(space.root, space.home)).preset },
			{ readonly: ['deny', 'allow', 'allow', 'deny', 'deny', 'deny'], dev: ['allow', 'allow', 'allow', 'allow', 'ask', 'ask'], trusted: ['allow', 'allow', 'allow', 'allow', 'allow', 'ask'], fallback: 'dev' });
		assert.deepEqual((['readonly', 'dev', 'trusted'] as const).map(dependencyDecision), ['deny', 'ask', 'ask']);
		await addUserRule('run:make*', 'allow', space.home);
		assert.equal((await loadPermissions(space.root, space.home, undefined, { preset: 'readonly' })).decide(run('make', 'x')).decision, 'allow');
	} finally { await space.cleanup(); }
});

test('addUserRule writes atomically to the user file, validates, deduplicates and preserves the rest', async () => {
	const space = await workspace({ user: { version: 1, preset: 'trusted', deny: ['run:rm*'], allow: ['git_commit'] } });
	try {
		await addUserRule('run:make test*', 'allow', space.home);
		await addUserRule('run:make test*', 'allow', space.home);
		await addUserRule('edit:src/**', 'ask', space.home);
		const file = path.join(space.home, '.armotusitio', 'permissions.json');
		const written = JSON.parse(await fs.readFile(file, 'utf8'));
		const leftovers = (await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'));
		const rejected = await Promise.all(['sudo', 'run:', 'run:a\nb', 'x'.repeat(301)].map(rule => addUserRule(rule, 'allow', space.home).then(() => 'accepted', () => 'rejected')));
		assert.deepEqual({ leftovers, rejected, written }, {
			leftovers: [], rejected: ['rejected', 'rejected', 'rejected', 'rejected'],
			written: { version: 1, preset: 'trusted', deny: ['run:rm*'], allow: ['git_commit', 'run:make test*'], ask: ['edit:src/**'] }
		});
		await fs.writeFile(file, '{corrupt');
		await assert.rejects(addUserRule('run:x*', 'allow', space.home), /PERMISSIONS_FILE_UNSAFE/);
		assert.equal(await fs.readFile(file, 'utf8'), '{corrupt');
		const fresh = path.join(space.base, 'fresh');
		await addUserRule('git_push', 'deny', fresh);
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(fresh, '.armotusitio', 'permissions.json'), 'utf8')), { version: 1, deny: ['git_push'] });
	} finally { await space.cleanup(); }
});

test('suggested rules persist only exact unambiguous commands and never dependencies, git or edits', async () => {
	const space = await workspace();
	try {
		const suggestions = [run('pnpm.cmd', 'test', '--run'), run('Make'), edit('src/a/b.ts'), edit('README.md'), commit, push,
			run('pnpm', 'install', 'x'), run('npx', '-y', 'x'), run('node'), run('node', '*.js'), run('node', 'a b.js'), run('node', 'a?.js'), run('go', 'get', 'x'), run('python', '-m', 'pip', 'install', 'x')].map(suggestRule);
		assert.deepEqual(suggestions, ['run:pnpm test --run', '', '', '', '', '', '', '', '', '', '', '', '', '']);
		await addUserRule(suggestions[0], 'allow', space.home);
		const set = await loadPermissions(space.root, space.home, undefined, { preset: 'readonly' });
		assert.deepEqual([set.decide(run('pnpm', 'test', '--run')).decision, set.decide(run('pnpm', 'test', '-w')).decision], ['allow', 'deny']);
		assert.deepEqual([commandName('/usr/bin/curl'), commandName('C:\\Windows\\System32\\curl.EXE')], ['curl', 'curl']);
	} finally { await space.cleanup(); }
});

test('a corrupt user or project file fails closed even without a readonly preset', async () => {
	for (const files of [{ user: '{broken' }, { project: '{broken' }, { user: { version: 1, allow: ['run:*'], bogus: true } }]) {
		const space = await workspace(files);
		try {
			const set = await loadPermissions(space.root, space.home);
			assert.deepEqual([set.warnings.length, ...[run('node', 'test.js'), run('git', 'status'), commit, push].map(request => set.decide(request).decision)], [2, 'deny', 'deny', 'deny', 'deny']);
		} finally { await space.cleanup(); }
	}
});

test('subjects exceeding the bounded glob budget are denied rather than matched after truncation', async () => {
	const space = await workspace({ user: { version: 1, allow: ['run:*'] } });
	try {
		const set = await loadPermissions(space.root, space.home);
		assert.equal(set.decide(run('node', 'a'.repeat(2048))).decision, 'deny');
	} finally { await space.cleanup(); }
});
