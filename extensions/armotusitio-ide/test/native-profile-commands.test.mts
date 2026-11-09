/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Command Palette flow of the AI profile registry, driven through a scripted host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { authStateLabel, registerProfileCommands, signingInOf } from '../src/native-profile-commands.ts';
import { ProfileRegistry } from '../src/native-profiles.ts';

interface Terminal { name: string; env: Record<string, string | null>; sent: string[] }

test('adding an account and signing in opens the provider login in a terminal that has only that profile directory', async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-profile-cmd-'));
	try {
		const registry = new ProfileRegistry(path.join(base, 'storage'), async () => undefined);
		const handlers = new Map<string, () => Promise<void>>();
		const terminals: Terminal[] = [];
		const handles: object[] = [];
		const picks = [{ value: 'claude' }];
		const closers: Array<(terminal: unknown) => void> = [];
		const host = {
			l10n: { t: (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]) },
			commands: { registerCommand: (id: string, run: () => Promise<void>) => { handlers.set(id, run); return { dispose() { } }; } },
			window: {
				showQuickPick: async () => picks.shift(), showInputBox: async () => 'Trabajo', showInformationMessage: async (_text: string, action: string) => action,
				createTerminal: (options: { name: string; env: Record<string, string | null> }) => { const terminal: Terminal = { name: options.name, env: options.env, sent: [] }; terminals.push(terminal); const handle = { show() { }, sendText: (text: string) => terminal.sent.push(text) }; handles.push(handle); return handle; },
				onDidCloseTerminal: (listener: (terminal: unknown) => void) => { closers.push(listener); return { dispose() { } }; }
			}
		};
		let ended = 0;
		const deps = { registry, rootOf: async () => undefined, showError: (error: unknown) => { throw error; }, onSignInEnded: () => { ended++; } };
		registerProfileCommands({ subscriptions: [] }, host, deps);
		await handlers.get('atsHarness.accounts.add')!();
		const [profile] = await registry.list('claude');
		const terminal = terminals[0];
		const during = signingInOf(deps).has(profile.id);
		closers[0](handles[0]);
		assert.deepEqual({
			alias: profile.alias, names: [...handlers.keys()].sort(), terminal: terminal.name, sent: terminal.sent,
			dir: terminal.env.CLAUDE_CONFIG_DIR === registry.configDirectory(profile), cleared: [terminal.env.ANTHROPIC_API_KEY, terminal.env.CODEX_HOME, terminal.env.OPENAI_API_KEY], during, after: signingInOf(deps).has(profile.id), ended
		}, { alias: 'Trabajo', names: ['atsHarness.accounts.add', 'atsHarness.accounts.manage'], terminal: 'Cuenta Trabajo', sent: ['claude auth login'], dir: true, cleared: [null, null, null], during: true, after: false, ended: 1 });
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('every authentication state has a distinct label with an icon, so color is never the only signal', () => {
	const labels = (['authenticated', 'not-authenticated', 'unknown', 'cli-unavailable', 'connection-failed', 'connecting'] as const).map(state => authStateLabel(text => text, state));
	assert.equal(new Set(labels).size, 6);
	assert.ok(labels.every(label => /^\$\([a-z-]+\) \S/.test(label)));
});
