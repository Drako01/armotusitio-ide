/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Shared harness of the native runtime suites (r8): a throwaway git project, the real session manager, store, IDE policy
 * and (for Claude) the real ats-runner approve tool over an authenticated channel, with a scripted user. `fake` installs
 * protocol-faithful fake CLIs; without it the installed provider CLIs run (real E2E, opt-in only).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeAdapter } from '../src/runtime/claude-adapter.ts';
import { CodexAdapter } from '../src/runtime/codex-adapter.ts';
import { AgentSessionManager, type ManagedSession, type RecoveryNotice } from '../src/runtime/session-manager.ts';
import { AgentSessionStore } from '../src/runtime/session-store.ts';
import { decideProviderCall } from '../src/runtime/provider-policy.ts';
import type { AgentEvent, AgentQuestion, QuestionAnswers, SessionIdentity, SessionRole, ToolCall } from '../src/runtime/contracts.ts';
import { createCommandPolicy } from '../src/native-command-policy.ts';
import { loadPermissions } from '../src/native-permissions.ts';
import { parseApprovalDraft, type ApprovalDraft } from '../src/native-approval.ts';
import type { ApprovalAnswer } from '../src/native-permissions-types.ts';
import { openToolChannel } from '../src/native-tool-server.ts';
import { projectPermissionsDigest } from '../src/native-run-integrity.ts';
import { processAlive } from '../src/native-runtime.ts';
import type { RunnerConfig } from '../src/ats-runner.ts';
import { ApprovalBroker } from '../src/runtime/approval-broker.ts';
import { repoFingerprint } from '../src/native-git-tools.ts';
import { agentContract } from '../src/native-agent-contract.ts';
import { FAKE_CLAUDE, FAKE_CODEX, installFakeCli } from './native-runtime-fakes.mts';

export type Provider = 'claude' | 'codex';
const RUNNER = path.resolve(import.meta.dirname, '../src/ats-runner.ts');

export interface User {
	approval(draft: ApprovalDraft): ApprovalAnswer | Promise<ApprovalAnswer>;
	question(questions: AgentQuestion[]): QuestionAnswers | undefined;
}

export interface Harness {
	provider: Provider;
	root: string;
	state: string;
	identity: SessionIdentity;
	base: string;
	home: string;
	store: AgentSessionStore;
	cards: ApprovalDraft[];
	/** Every tool call the provider asked the IDE to decide (card or not): what it did NOT ask about was decided by the provider alone. */
	mediated: ToolCall[];
	asked: AgentQuestion[][];
	user: User;
	manager(): AgentSessionManager;
	/** Simulates an IDE restart: every manager stops its processes; the registry stays. */
	restart(): Promise<void>;
	session(manager?: AgentSessionManager): Promise<ManagedSession>;
	executions(): Promise<string[]>;
	pids(): Promise<number[]>;
	close(): Promise<void>;
}

export async function harness(provider: Provider, extraEnv: Record<string, string> = {}, fake = true): Promise<Harness> {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-runtime-')));
	const root = path.join(base, 'project'), home = path.join(base, 'home'), state = path.join(base, 'state'), bin = path.join(base, 'bin');
	await Promise.all([fs.mkdir(root), fs.mkdir(home), fs.mkdir(state)]);
	execFileSync('git', ['init', '-q', '-b', 'main', root]);
	await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
	if (fake) { await installFakeCli(bin, provider, provider === 'codex' ? FAKE_CODEX : FAKE_CLAUDE); }
	// Real providers keep the user's HOME (their login lives there); fakes get a throwaway one.
	const env: NodeJS.ProcessEnv = fake ? { ...process.env, PATH: bin + path.delimiter + (process.env.PATH ?? ''), FAKE_STATE_DIR: state, HOME: home, USERPROFILE: home, ...extraEnv } : { ...process.env, ...extraEnv };
	const cards: ApprovalDraft[] = [];
	const mediated: ToolCall[] = [];
	const asked: AgentQuestion[][] = [];
	const user: User = { approval: () => 'once', question: questions => Object.fromEntries(questions.map(question => [question.id, ['blue']])) };
	// Same order as the chat: a live task/session grant answers without a card; otherwise the user's card, then the grant.
	const broker = new ApprovalBroker();
	const answer = async (draft: ApprovalDraft): Promise<ApprovalAnswer> => {
		if (draft.rule && broker.covers(draft.rule, provider)) { return 'once'; }
		cards.push(draft);
		const given = await user.approval(draft);
		broker.record(draft.rule, given, provider);
		return given;
	};
	const permissions = await loadPermissions(root, home, undefined, { preset: 'dev' });
	const policy = createCommandPolicy({ subprojects: [], delegate: false, extras: [], permissions });
	let current: ManagedSession | undefined;
	const channel = await openToolChannel(path.join(base, 'channel'), async (method, params) => {
		if (method === 'approval') {
			const card = parseApprovalDraft(params, root);
			if (!card) { return 'deny'; }
			const decide = () => answer(card);
			return current ? current.awaitUser('approval', decide, answer => answer !== 'deny') : decide();
		}
		if (method === 'epoch') { return current?.turnNumber ?? 0; }
		if (method === 'question') {
			const questions = (params as { questions: AgentQuestion[] }).questions;
			asked.push(questions);
			return user.question(questions);
		}
		throw Error('UNEXPECTED');
	});
	let runs = 0;
	const managers: AgentSessionManager[] = [];
	const store = new AgentSessionStore(path.join(base, 'store'));
	const services = {
		async prepare(identity: SessionIdentity, role: SessionRole) {
			const directory = path.join(base, 'runs', String(++runs));
			await fs.mkdir(directory, { recursive: true });
			const config: RunnerConfig = {
				schemaVersion: 1, root, env, logDirectory: path.join(directory, 'logs'), maxTurns: 50, approve: provider === 'claude', turnEpochs: true, permissions: { preset: 'dev' },
				...(role === 'writer' ? { git: true, files: true, repoBaseline: await repoFingerprint(root) } : {}),
				policy: { subprojects: [], delegate: false, extras: [] }, projectPermissionsBaseline: await projectPermissionsDigest(root),
				channel: { address: channel.address, token: channel.token }
			};
			const configFile = path.join(directory, 'runner.json');
			await fs.writeFile(configFile, JSON.stringify(config));
			// The runner reads permissions from a throwaway HOME, so the user's own rules never change a scenario's verdicts.
			const toolServer = { command: process.execPath, args: [RUNNER, configFile], env: fake ? {} : { HOME: home, USERPROFILE: home }, mcpConfigFile: path.join(directory, 'mcp.json') };
			await fs.writeFile(toolServer.mcpConfigFile, JSON.stringify({ mcpServers: { 'ats-runner': { type: 'stdio', command: toolServer.command, args: toolServer.args, env: toolServer.env } } }));
			// Real providers get the same session contract as the IDE; fakes only need a marker.
			const instructions = fake ? 'IDE contract (' + role + ')' : agentContract({ provider, role: role === 'writer' ? 'implementer' : 'planner', maxTurns: 40, runner: true, git: role === 'writer', files: role === 'writer', nativeShell: true });
			// An AI profile gives the provider its own private config directory, like the IDE's environment builder does.
			const profileEnv = identity.profileId ? { ...env, [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: path.join(base, 'profiles', identity.profileId) } : env;
			return { options: { instructions, env: profileEnv, toolServer, maxTurns: Number(process.env.ATS_E2E_MAX_TURNS) || 40 }, dispose: async () => undefined };
		},
		approve: (_session: ManagedSession, call: ToolCall) => {
			mediated.push(call);
			return decideProviderCall({ root, policy, permissions, trusted: () => true, sandboxed: true, ask: draft => answer(draft) }, call);
		},
		ask: async (_session: ManagedSession, questions: AgentQuestion[]) => { asked.push(questions); return user.question(questions); }
	};
	const identity: SessionIdentity = { root, worktree: root, provider, conversationId: 'c1' };
	const self: Harness = {
		provider, root, state, identity, store, cards, mediated, asked, user, base, home,
		manager() {
			const manager = new AgentSessionManager(store, [new ClaudeAdapter(), new CodexAdapter()], services, { retryDelayMs: 50 });
			managers.push(manager);
			return manager;
		},
		async restart() { for (const manager of managers.splice(0)) { await manager.dispose(); } },
		async session(manager = self.manager()) { current = await manager.session(identity); return current; },
		async executions() { return (await fs.readFile(path.join(state, 'executions.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean); },
		async pids() { return (await fs.readFile(path.join(state, 'pids.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number); },
		async close() {
			for (const manager of managers) { await manager.dispose(); }
			await channel.close();
			await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
		}
	};
	return self;
}

/** Every event of a session from now on, in delivery order. */
export function record(session: ManagedSession): AgentEvent[] {
	const events: AgentEvent[] = [];
	session.bridge.subscribe(event => events.push(event));
	return events;
}

export async function settledPids(pids: number[]): Promise<number[]> {
	for (let attempt = 0; attempt < 40; attempt++) {
		const alive = pids.filter(processAlive);
		if (!alive.length) { return []; }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return pids.filter(processAlive);
}

