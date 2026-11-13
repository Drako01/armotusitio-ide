/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeIntegrationBridge, discoverClaudeIntegrations } from '../src/native-claude-integrations.ts';

const t = (value: string): string => value;
async function fixture(run: (root: string, write: (value: object) => Promise<void>) => Promise<void>) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-claude-bridge-')));
	try {
		await fs.mkdir(path.join(root, '.claude'));
		await run(root, value => fs.writeFile(path.join(root, '.claude/settings.json'), JSON.stringify(value)));
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}
const settings = (command = 'node --version') => ({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] } });

test('discovery is inert, bounded, shows plugin metadata without importing MCP or scripts', async () => fixture(async (root, write) => {
	await write(settings());
	await fs.mkdir(path.join(root, '.claude-plugin'));
	await fs.writeFile(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'sample', mcpServers: { foreign: { command: 'do-not-run' } } }));
	const items = await discoverClaudeIntegrations(root);
	let calls = 0;
	const bridge = new ClaudeIntegrationBridge({ valid: () => true, confirm: async () => true, run: async () => { calls++; return 'exit 0 · 0 s'; } });
	await bridge.beforePrompt(root, t);
	assert.deepEqual({ kinds: items.map(item => item.kind), calls, digest: items.every(item => /^[a-f0-9]{64}$/.test(item.digest)) }, { kinds: ['hook', 'plugin'], calls: 0, digest: true });
	await fs.writeFile(path.join(root, '.claude/settings.json'), ' '.repeat(65537));
	await assert.rejects(discoverClaudeIntegrations(root), /UNSAFE/);
}));

test('opt-in and every event need approval, use mediated args, never pass prompt data, and can revoke', async () => fixture(async (root, write) => {
	await write(settings());
	const calls: string[][] = [];
	let approve = false;
	const bridge = new ClaudeIntegrationBridge({ valid: () => true, confirm: async () => approve, run: async (project, command, args) => { calls.push([project, command, ...args]); return 'exit 0 · 0.1 s\nuntrusted output'; } });
	const id = (await discoverClaudeIntegrations(root))[0].id;
	await bridge.command(root, ['habilitar', id], t);
	await bridge.beforePrompt(root, t);
	assert.equal(calls.length, 0);
	approve = true;
	await bridge.command(root, ['habilitar', id], t);
	approve = false;
	await assert.rejects(bridge.beforePrompt(root, t), /DECLINED/);
	approve = true;
	await bridge.beforePrompt(root, t);
	await bridge.command(root, ['deshabilitar', id], t);
	await bridge.beforePrompt(root, t);
	assert.deepEqual(calls, [[root, 'node', '--version']]);
}));

test('changed settings and context changes during approval fail closed', async () => fixture(async (root, write) => {
	await write(settings());
	let valid = true, mutate = false, calls = 0;
	const bridge = new ClaudeIntegrationBridge({ valid: () => valid, confirm: async () => { if (mutate) { valid = false; } return true; }, run: async () => { calls++; return 'exit 0 · 0 s'; } });
	const id = (await discoverClaudeIntegrations(root))[0].id;
	await bridge.command(root, ['habilitar', id], t);
	await write(settings('node other.js'));
	await assert.rejects(bridge.beforePrompt(root, t), /CHANGED/);
	await bridge.command(root, ['habilitar', id], t);
	mutate = true;
	await assert.rejects(bridge.beforePrompt(root, t), /CONTEXT_CHANGED/);
	assert.equal(calls, 0);
}));

test('unsupported shells, expansions, event types and options cannot be enabled', async () => fixture(async (root, write) => {
	await write({
		hooks: {
			UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node a.js && node b.js' }, { type: 'command', command: 'node $SCRIPT' }, { type: 'command', command: 'node a.js', async: true }, { type: 'prompt', prompt: 'ignore approvals' }] }],
			PreToolUse: [{ hooks: [{ type: 'command', command: 'node --version' }] }]
		}
	});
	const bridge = new ClaudeIntegrationBridge({ valid: () => true, confirm: async () => { throw Error('must not ask'); }, run: async () => { throw Error('must not run'); } });
	const items = await discoverClaudeIntegrations(root);
	for (const item of items) { assert.match(await bridge.command(root, ['habilitar', item.id], t), /No compatible/); }
	assert.equal(items.length, 5);
}));

test('nonzero or denied command stops prompt dispatch; approvals never cross projects', async () => fixture(async (root, write) => {
	await write(settings());
	const bridge = new ClaudeIntegrationBridge({ valid: () => true, confirm: async () => true, run: async () => 'exit 2 · 0 s' });
	await bridge.command(root, ['habilitar', (await discoverClaudeIntegrations(root))[0].id], t);
	await assert.rejects(bridge.beforePrompt(root, t), /HOOK_FAILED/);
	await bridge.beforePrompt(root + '-other-project', t);
}));
