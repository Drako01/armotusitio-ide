/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAgentProfiles, parseAgentProfiles } from '../src/native-agent-profiles.ts';
import { createDelegationBroker, type ReadOnlyDelegation } from '../src/native-agent-delegation.ts';

const agent = { id: 'security', role: 'reviewer', instruction: 'Review security of the supplied context.', tools: [], model: 'sonnet', maxTurns: 2 };
const config = (extra = {}) => JSON.stringify({ schemaVersion: 1, maxConcurrent: 1, maxLaunches: 1, agents: [{ ...agent, enabled: true }], ...extra });

test('project profiles are disabled by default and cannot widen the empty tool surface or budget', () => {
	const disabled = parseAgentProfiles(config({ agents: [agent] }));
	assert.equal(disabled.profiles[0].enabled, false);
	for (const changes of [{ tools: ['Bash'] }, { role: 'implementer' }, { model: '--settings' }, { maxTurns: 7 }, { permissions: 'allow' }]) {
		assert.throws(() => parseAgentProfiles(config({ agents: [{ ...agent, ...changes }] })), /PROFILES_INVALID/);
	}
	for (const changes of [{ maxConcurrent: 3 }, { maxLaunches: 3 }, { agents: [agent, agent] }, { provider: 'codex' }]) {
		assert.throws(() => parseAgentProfiles(config(changes)), /PROFILES_INVALID/);
	}
});

test('profile launch requires explicit authorization, pins model and role and preserves bounded lifecycle', async () => {
	const profiles = parseAgentProfiles(config());
	const requests: ReadOnlyDelegation[] = [];
	const broker = createDelegationBroker({
		enabled: () => true, profiles: async () => profiles,
		authorize: async request => { requests.push(request); return true; },
		launch: async request => {
			assert.equal(request, requests[0]);
			return { cancel() { }, outcome: Promise.resolve({ status: 'passed', exitCode: 0, output: 'Verified supplied context only.', durationMs: 12, truncated: false }) };
		}
	});
	const result = await broker.call({ role: 'reviewer', profile: 'security', instruction: 'Check this function.' });
	assert.deepEqual([requests[0].profile, requests[0].model, requests[0].maxTurns, requests[0].profileDigest], ['security', 'sonnet', 2, profiles.digest]);
	assert.match(requests[0].instruction, /not permission authority/);
	assert.match(JSON.stringify(result), /tool-free/);
	await assert.rejects(broker.call({ role: 'reviewer', instruction: 'Another task' }), /LIMIT/);
	broker.dispose();
});

test('changed, disabled and mismatched profiles fail closed before launch', async () => {
	let current = parseAgentProfiles(config());
	const broker = createDelegationBroker({
		enabled: () => true, profiles: async () => current,
		authorize: async () => { current = parseAgentProfiles(config({ agents: [agent] })); return true; },
		launch: async () => assert.fail('must not launch')
	});
	await assert.rejects(broker.call({ role: 'planner', profile: 'security', instruction: 'task' }), /PROFILE_UNAVAILABLE/);
	await assert.rejects(broker.call({ role: 'reviewer', profile: 'security', instruction: 'task' }), /PROFILE_CHANGED/);
	await assert.rejects(broker.call({ role: 'reviewer', profile: 'security', instruction: 'task' }), /PROFILE_UNAVAILABLE/);
});

test('profile file discovery is bounded, workspace-local and refuses directory redirects', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-profiles-')));
	try {
		assert.equal((await loadAgentProfiles(root)).digest, 'absent');
		await fs.mkdir(path.join(root, '.armotusitio'));
		await fs.writeFile(path.join(root, '.armotusitio', 'agents.json'), config());
		assert.equal((await loadAgentProfiles(root)).profiles[0].id, 'security');
		await fs.writeFile(path.join(root, '.armotusitio', 'agents.json'), ' '.repeat(65537));
		await assert.rejects(loadAgentProfiles(root), /PROFILES_INVALID/);
		await fs.rename(path.join(root, '.armotusitio'), path.join(root, 'redirect'));
		await fs.symlink(path.join(root, 'redirect'), path.join(root, '.armotusitio'), 'junction');
		await assert.rejects(loadAgentProfiles(root), /PROFILES_INVALID/);
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
