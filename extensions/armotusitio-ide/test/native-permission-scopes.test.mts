/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Persistent permission scopes: project and global survive a restart, stay isolated, and revoke immediately. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { addUserRule, globalRuleAllowed, loadPermissions, removeUserRule, projectKey } from '../src/native-permissions.ts';
import { parseApprovalDraft, requestApproval } from '../src/native-approval.ts';
import type { PermissionRequest } from '../src/native-permissions-types.ts';

const run = (command: string, ...args: string[]): PermissionRequest => ({ kind: 'run', command, args, cwd: '.' });

test('only exact inspection commands may be remembered for every project', () => {
	assert.deepEqual({
		allowed: [run('docker', 'ps'), run('docker', 'images'), run('terraform', 'version')].map(request => globalRuleAllowed(request)),
		refused: [run('docker', 'ps', '-a'), run('docker', 'run'), run('docker', 'inspect'), run('kubectl', 'get'), run('npm', 'run', 'build'), run('node', 'x.js'), run('sh', '-c'), run('constructor', 'ps')].map(request => globalRuleAllowed(request)),
		gitAndEdit: [globalRuleAllowed({ kind: 'git_commit', branch: 'main', files: [], message: 'x' }, '/repo'), globalRuleAllowed({ kind: 'edit', path: 'a.txt' })]
	}, { allowed: [true, true, true], refused: Array(8).fill(false), gitAndEdit: [false, false] });
});

test('the card offers the global answer only for inspection commands and the host honours nothing else', async () => {
	const card = (command: string, args: string[]) => parseApprovalDraft({ title: 'Run', detail: [], kind: 'run', command, args, cwd: '/repo' }, '/repo');
	assert.deepEqual({ docker: card('docker', ['ps'])?.global, npm: card('npm', ['run', 'build'])?.global },
		{ docker: true, npm: undefined });
	const ask = async () => 'global' as const;
	assert.deepEqual({
		withRule: await requestApproval(ask, { kind: 'run', title: 't', detail: [], rule: 'run:docker ps' }),
		withoutRule: await requestApproval(ask, { kind: 'run', title: 't', detail: [], rule: '' })
	}, { withRule: undefined, withoutRule: 'DENIED: the user did not allow it' });
});

test('project and global rules persist across a restart, stay in their scope and revoke at once', async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-scopes-'));
	try {
		const home = path.join(base, 'home');
		const [one, two] = [path.join(base, 'one'), path.join(base, 'two')];
		await Promise.all([fs.mkdir(one, { recursive: true }), fs.mkdir(two, { recursive: true })]);
		const verdicts = async () => Promise.all([one, two].map(async root => (await loadPermissions(root, home, undefined, { preset: 'readonly' })).decide(run('docker', 'ps')).decision));
		const before = await verdicts();
		await addUserRule('run:docker ps', 'allow', home, one);
		const projectOnly = await verdicts();
		await addUserRule('run:docker ps', 'allow', home);
		const everywhere = await verdicts();
		// A new load from the same files is what an IDE restart does.
		const afterRestart = await verdicts();
		await removeUserRule('run:docker ps', home, projectKey(one));
		const revoked = await verdicts();
		assert.deepEqual({ before, projectOnly, everywhere, afterRestart, revoked }, {
			before: ['deny', 'deny'], projectOnly: ['allow', 'deny'], everywhere: ['allow', 'allow'], afterRestart: ['allow', 'allow'], revoked: ['deny', 'deny']
		});
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});
