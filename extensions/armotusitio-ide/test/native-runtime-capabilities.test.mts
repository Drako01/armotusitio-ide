/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSessionManager } from '../src/runtime/session-manager.ts';
import { AgentSessionStore } from '../src/runtime/session-store.ts';
import type { RuntimeCapabilities } from '../src/runtime/contracts.ts';

test('capability probes share only identical environments, retry failures and isolate profiles', async () => {
	const calls: string[] = [];
	const manager = new AgentSessionManager(new AgentSessionStore('unused-capability-store'), [{
		provider: 'codex',
		async capabilities(env): Promise<RuntimeCapabilities> {
			calls.push(env.CODEX_HOME!);
			if (env.CODEX_HOME === 'failed') { throw Error('fixture unavailable'); }
			return {
				provider: 'codex', version: env.CODEX_HOME!, compatible: true, transport: 'app-server', features: {
					session: 'supported', streaming: 'supported', resume: 'supported', fork: 'supported', interrupt: 'supported',
					steer: 'supported', approvals: 'supported', questions: 'supported', commandOutput: 'supported', mcp: 'supported', usage: 'supported'
				}
			};
		},
		async open() { throw Error('must not launch a provider'); }
	}], {
		async prepare() { throw Error('must not prepare a session'); },
		async approve() { throw Error('must not ask'); },
		async ask() { throw Error('must not ask'); }
	});
	const first = manager.capabilities('codex', { CODEX_HOME: 'A', PATH: 'bin' });
	assert.equal(first, manager.capabilities('codex', { PATH: 'bin', CODEX_HOME: 'A' }));
	await Promise.all([first, manager.capabilities('codex', { CODEX_HOME: 'B', PATH: 'bin' }), manager.capabilities('codex', { CODEX_HOME: 'A', PATH: 'upgraded' })]);
	await assert.rejects(manager.capabilities('codex', { CODEX_HOME: 'failed' }), /fixture unavailable/);
	await assert.rejects(manager.capabilities('codex', { CODEX_HOME: 'failed' }), /fixture unavailable/);
	assert.deepEqual(calls, ['A', 'B', 'A', 'failed', 'failed']);
});
