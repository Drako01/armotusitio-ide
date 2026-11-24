/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* A goal started from the chat runs with the integration's real wiring and a minimal editor host. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerGoalIntegration, type GoalIntegrationDeps } from '../src/native-goal-integration.ts';

/** The editor host the integration touches, with no UI: every prompt is a failure of the test. */
function host(root: string, mcp: { enabled(): boolean; client: { tools(): Promise<unknown[]>; call(name: string, args: unknown): Promise<unknown> } }) {
	const folder = { name: 'project', uri: { fsPath: root, toString: () => 'file://' + root } };
	const prompts: string[] = [];
	const vscode = {
		l10n: { t: (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index: string) => args[Number(index)] ?? '') },
		window: {
			showWarningMessage: async (message: string) => { prompts.push(message); return undefined; },
			showInformationMessage: async () => undefined,
			showQuickPick: async (items: unknown, options: { title?: string }) => { prompts.push(options?.title ?? 'quick pick'); return undefined; }
		},
		workspace: { workspaceFolders: [folder], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
		commands: { registerCommand: () => ({ dispose() { } }) },
		Uri: { file: (fsPath: string) => ({ fsPath }) }
	};
	const context = { subscriptions: [] as Array<{ dispose(): void }>, globalStorageUri: { fsPath: path.join(root, '.storage') } };
	const deps: GoalIntegrationDeps = {
		context, vscode, controller: { mcp }, metricsDirectory: () => path.join(root, '.storage', 'metrics'), ensureTrust: () => true, showError: () => undefined,
		commandExtras: () => [], providerCallsPer24h: () => 0, resultCache: async () => ({ get: async () => undefined, set: async () => undefined }),
		environmentTemplates: async () => [], systemExec: async () => ({ exitCode: 0, output: '' }), doctorFor: async () => [], servicePreflight: async () => true,
		launchAgent: async () => { throw Error('HARNESS_TEST_NO_AGENT'); },
		deliveryGitTool: () => async () => ({ isError: true, text: 'DENIED: test' })
	};
	return { folder, prompts, deps, dispose: () => context.subscriptions.forEach(item => item.dispose()) };
}

test('a chat goal whose text looks like a card key starts, reading the card from the connected client or as plain text without it', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-goal-chat-')));
	const asked: string[] = [];
	const fake = host(root, { enabled: () => true, client: { tools: async () => [], call: async name => { asked.push(name); throw Error('HARNESS_CARD_MISSING'); } } });
	try {
		const goals = registerGoalIntegration(fake.deps);
		let ended!: (summary: string) => void;
		const summary = new Promise<string>(resolve => { ended = resolve; });
		const launch = await goals.startFromChat(fake.folder, 'Aplicá la política DF-01 y continuá con el ROADMAP', text => ended(text));
		assert.deepEqual({ started: launch.started, prompts: fake.prompts, cardRead: asked.length > 0 }, { started: true, prompts: [], cardRead: true });
		// The goal runs in the background; how it ended reaches the chat, even when it fails.
		assert.equal(await summary, 'El objetivo falló (HARNESS_TEST_NO_AGENT).');
	} finally {
		fake.dispose();
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
