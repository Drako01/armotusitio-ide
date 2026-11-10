/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexAdapter } from '../src/runtime/codex-adapter.ts';
import type { AdapterHost, SessionOpenOptions } from '../src/runtime/contracts.ts';

const root = '/tmp/ats-codex-guard-fixture';
const base: SessionOpenOptions = {
	identity: { root, worktree: root, provider: 'codex', conversationId: 'private' },
	role: 'conversation', instructions: 'Inspect only', env: process.env, nativeSubagents: true
};
const host = { emit: () => undefined } as unknown as AdapterHost;

test('native Codex subagents never open with writer, MCP, web or global full-access permissions', async () => {
	const adapter = new CodexAdapter();
	for (const override of [
		{ role: 'writer' as const },
		{ webSearch: true },
		{ toolServer: { command: 'node', args: [], env: {}, mcpConfigFile: '' } }
	]) {
		await assert.rejects(adapter.open({ ...base, ...override }, host), /RUNTIME_SUBAGENTS_UNSAFE/);
	}
	const unrestricted = new CodexAdapter({ fullAccess: () => true });
	await assert.rejects(unrestricted.open(base, host), /RUNTIME_SUBAGENTS_UNSAFE/);
});

test('native Codex child session refuses an unauditable root without starting a CLI', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-native-child-app-server-'));
	try {
		await assert.rejects(
			new CodexAdapter().open({ ...base, identity: { ...base.identity, root, worktree: root } }, host),
			/HARNESS_DELEGATION_ISOLATION_UNSUPPORTED/
		);
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
