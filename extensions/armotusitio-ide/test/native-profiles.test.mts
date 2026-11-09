/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** AI profile registry: identity, persistence, precedence, credential isolation and authentication state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProfileRegistry, type ProfileExec } from '../src/native-profiles.ts';

const never: ProfileExec = async () => undefined;

async function withStorage(work: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-profiles-'));
	try { await work(path.join(directory, 'storage')); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('profiles are managed by stable id: add, rename, duplicate and invalid aliases, remove with its private directory', async () => {
	await withStorage(async directory => {
		const registry = new ProfileRegistry(directory, never);
		const personal = await registry.add('claude', ' Personal ');
		const work = await registry.add('claude', 'Work');
		const codex = await registry.add('codex', 'Personal');
		const refused = await Promise.all([registry.add('claude', 'personal'), registry.add('claude', '  '), registry.add('claude', 'x'.repeat(41)), registry.add('claude', 'bad\u0007')].map(promise => promise.then(() => 'accepted', error => (error as Error).message)));
		const renamed = await registry.rename(work.id, 'Pro');
		const dir = registry.configDirectory(work);
		const existedBefore = await fs.stat(dir).then(() => true, () => false);
		await registry.remove(work.id);
		assert.deepEqual({
			aliases: [personal.alias, codex.alias], refused, sameId: renamed.id === work.id, renamedAlias: renamed.alias, existedBefore,
			dirGone: await fs.stat(dir).then(() => false, () => true), left: (await registry.list()).map(profile => profile.alias).sort()
		}, { aliases: ['Personal', 'Personal'], refused: ['HARNESS_PROFILE_ALIAS_TAKEN', 'HARNESS_PROFILE_ALIAS_INVALID', 'HARNESS_PROFILE_ALIAS_INVALID', 'HARNESS_PROFILE_ALIAS_INVALID'], sameId: true, renamedAlias: 'Pro', existedBefore: true, dirGone: true, left: ['Personal', 'Personal'] });
	});
});

test('resolution is workspace, then provider default, then nothing, and survives a restart', async () => {
	await withStorage(async directory => {
		const registry = new ProfileRegistry(directory, never);
		const personal = await registry.add('claude', 'Personal');
		const work = await registry.add('claude', 'Work');
		const [one, two] = [path.join(directory, 'one'), path.join(directory, 'two')];
		const none = await registry.resolve('claude', one);
		await registry.setDefault(personal.id);
		await registry.assign(one, work.id);
		const restarted = new ProfileRegistry(directory, never);
		const resolved = await Promise.all([restarted.resolve('claude', one), restarted.resolve('claude', two), restarted.resolve('codex', one)]);
		await restarted.remove(work.id);
		const afterRemoval = await restarted.resolve('claude', one);
		assert.deepEqual({ none, ids: resolved.map(profile => profile?.alias), afterRemoval: afterRemoval?.alias }, { none: undefined, ids: ['Work', 'Personal', undefined], afterRemoval: 'Personal' });
	});
});

test('a process environment carries only its own profile directory and none of the IDE credentials', async () => {
	await withStorage(async directory => {
		const registry = new ProfileRegistry(directory, never);
		const [a, b, codex] = [await registry.add('claude', 'A'), await registry.add('claude', 'B'), await registry.add('codex', 'C')];
		const base: NodeJS.ProcessEnv = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', CODEX_HOME: '/other', Claude_Config_Dir: '/other2', KEEP: '1' };
		const [envA, envB, envC] = [registry.environment(a, base), registry.environment(b, base), registry.environment(codex, base)];
		assert.deepEqual({
			a: [envA.CLAUDE_CONFIG_DIR, envA.CODEX_HOME, envA.ANTHROPIC_API_KEY, envA.CLAUDE_CODE_OAUTH_TOKEN, envA.Claude_Config_Dir, envA.KEEP],
			different: envA.CLAUDE_CONFIG_DIR !== envB.CLAUDE_CONFIG_DIR, codex: [envC.CODEX_HOME, envC.CLAUDE_CONFIG_DIR, envC.OPENAI_API_KEY], baseUntouched: base.ANTHROPIC_API_KEY
		}, { a: [registry.configDirectory(a), undefined, undefined, undefined, undefined, '1'], different: true, codex: [registry.configDirectory(codex), undefined, undefined], baseUntouched: 'k' });
	});
});

test('concurrent windows adding profiles lose none, and a damaged file is reported and never overwritten', async () => {
	await withStorage(async directory => {
		const windows = [new ProfileRegistry(directory, never), new ProfileRegistry(directory, never), new ProfileRegistry(directory, never)];
		await Promise.all(windows.map((registry, index) => registry.add('codex', 'Account ' + index)));
		const aliases = (await new ProfileRegistry(directory, never).list()).map(profile => profile.alias).sort();
		const file = path.join(directory, 'profiles.json');
		await fs.writeFile(file, '{broken');
		const refused = await new ProfileRegistry(directory, never).add('codex', 'New').then(() => 'accepted', error => (error as Error).message);
		assert.deepEqual({ aliases, refused, bytes: await fs.readFile(file, 'utf8') }, { aliases: ['Account 0', 'Account 1', 'Account 2'], refused: 'HARNESS_PROFILES_UNSAFE', bytes: '{broken' });
	});
});

test('authentication state is what the provider CLI reports for that profile, never assumed', async () => {
	await withStorage(async directory => {
		const seen: string[] = [];
		const exec: ProfileExec = async (provider, env) => {
			seen.push(env.CLAUDE_CONFIG_DIR ?? env.CODEX_HOME ?? '');
			if (provider === 'claude') { return { code: 0, output: JSON.stringify({ loggedIn: env.CLAUDE_CONFIG_DIR?.endsWith('-in') === true }) }; }
			return { code: 0, output: env.CODEX_HOME?.endsWith('-in') ? 'Logged in using ChatGPT' : 'Not logged in' };
		};
		const registry = new ProfileRegistry(directory, exec);
		const claude = await registry.add('claude', 'x');
		const codex = await registry.add('codex', 'y');
		const garbled = new ProfileRegistry(directory, async () => ({ code: 0, output: 'not json' }));
		const missing = new ProfileRegistry(directory, never);
		const states = [await registry.authState(claude, {}), await registry.authState(codex, {}), await garbled.authState(claude, {}), await missing.authState(claude, {})];
		assert.deepEqual({ states, isolated: seen.every((value, index) => value === registry.configDirectory(index === 0 ? claude : codex)) }, { states: ['not-authenticated', 'not-authenticated', 'unknown', 'cli-unavailable'], isolated: true });
	});
});
