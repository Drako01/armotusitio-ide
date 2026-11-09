/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Real-provider E2E of the native runtime (r8). Every scenario talks to the INSTALLED Claude Code / Codex CLI with the
 * user's own login, through the same session manager, policy, approve tool and git tools the chat uses, inside a throwaway
 * git project. Opt-in only: it spends model quota.
 *
 *   node test/native-real-e2e.mts --provider claude|codex|both --acknowledge-real-model-call [--only E01,A03] [--out file]
 *
 * Prints one JSON line per scenario: id, provider, criteria, expected, obtained, status (PASS/FAIL/BLOCKED), duration and
 * evidence (native ids, event counts, cards). A scenario is BLOCKED only when the provider did not use a capability the
 * scenario needs (for example it answered without asking a question); that is reported, never counted as PASS.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { harness, record, type Harness, type Provider } from './native-runtime-harness.mts';
import { captureWorkingTree, diffWorkingTree, discardRunChanges, fingerprintFiles } from '../src/native-run-diff.ts';
import type { AgentEvent } from '../src/runtime/contracts.ts';

type Status = 'PASS' | 'FAIL' | 'BLOCKED';
interface Outcome { status: Status; obtained: string; evidence?: Record<string, unknown> }
interface Scenario { id: string; criteria: string; expected: string; seed?: (h: Harness) => Promise<void>; run(h: Harness): Promise<Outcome> }

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const read = (h: Harness, file: string): Promise<string> => fs.readFile(path.join(h.root, file), 'utf8').catch(() => '');
const exists = (h: Harness, file: string): Promise<boolean> => fs.stat(path.join(h.root, file)).then(() => true, () => false);
const passes = (h: Harness, command: string, args: string[]): boolean => { try { execFileSync(command, args, { cwd: h.root, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' && command === 'npm' }); return true; } catch { return false; } };
const verdict = (ok: boolean, obtained: string, evidence?: Record<string, unknown>): Outcome => ({ status: ok ? 'PASS' : 'FAIL', obtained: obtained.slice(0, 300), ...(evidence ? { evidence } : {}) });
const kinds = (events: AgentEvent[]): Record<string, number> => events.reduce<Record<string, number>>((counts, event) => { counts[event.payload.type] = (counts[event.payload.type] ?? 0) + 1; return counts; }, {});
const AUTONOMY = 'Work autonomously until the task is verified; do not ask me anything. ';

/** A small Node project; every task adds its own starting point on top. */
async function nodeProject(h: Harness, files: Record<string, string>): Promise<void> {
	const base: Record<string, string> = {
		'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { test: 'node --test', check: 'node scripts/check.js', build: 'node scripts/build.js' } }, null, 2),
		'scripts/check.js': 'const fs = require("fs"); const bad = fs.readdirSync("src").filter(f => /\\bvar\\b/.test(fs.readFileSync("src/" + f, "utf8"))); if (bad.length) { console.error("var found in " + bad.join(", ")); process.exit(1); }\n',
		'scripts/build.js': 'if (!process.argv.includes("--prod")) { console.error("build requires --prod"); process.exit(1); } console.log("built");\n',
		'src/currency.js': 'exports.formatCurrency = (value) => "$" + value.toFixed(2);\n',
		...files
	};
	for (const [file, content] of Object.entries(base)) {
		await fs.mkdir(path.dirname(path.join(h.root, file)), { recursive: true });
		await fs.writeFile(path.join(h.root, file), content);
	}
	git(h.root, 'add', '.');
	git(h.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'seed');
}

const SCENARIOS: Scenario[] = [
	{
		id: 'E01', criteria: 'S01/S02 C01 C02', expected: 'second turn recalls the codeword; same native id; streamed deltas',
		async run(h) {
			const session = await h.session();
			const events = record(session);
			const first = await session.runTurn('Remember the codeword ZEBRA-42. Reply with only: OK', 'conversation');
			const second = await session.runTurn('What was the codeword? Reply with only the codeword.', 'conversation');
			const counts = kinds(events);
			return verdict(second.output.includes('ZEBRA-42') && first.nativeSessionId === second.nativeSessionId && (counts['message.delta'] ?? 0) >= 2, second.output, { nativeSessionId: second.nativeSessionId, counts });
		}
	},
	{
		id: 'E02', criteria: 'S03/S04 C06 DoD-03', expected: 'after an IDE restart the session resumes by id and still knows the codeword',
		async run(h) {
			const before = await h.session();
			const first = await before.runTurn('Remember the codeword OTTER-17. Reply with only: OK', 'conversation');
			await h.restart();
			const after = await h.session();
			const notices: string[] = [];
			after.onNotice(notice => notices.push(notice.kind));
			const second = await after.runTurn('What was the codeword? Reply with only the codeword.', 'conversation');
			return verdict(second.output.includes('OTTER-17') && second.nativeSessionId === first.nativeSessionId && notices.includes('resumed'), second.output, { nativeSessionId: second.nativeSessionId, notices });
		}
	},
	{
		id: 'E03', criteria: 'S05(deny) S06 C04', expected: 'npm install left-pad reaches a card, the user denies, the agent continues with an alternative answer',
		async run(h) {
			h.user.approval = () => 'deny';
			const session = await h.session();
			const result = await session.runTurn('Run exactly this command with your own shell tool: npm install left-pad. If it is denied, do not retry it in any way; reply with exactly: DENIED_OK', 'writer');
			const card = h.cards.find(item => item.detail.join(' ').includes('left-pad'));
			return verdict(!!card && result.output.includes('DENIED_OK'), result.output, { cards: h.cards.map(item => item.detail[0]) });
		}
	},
	{
		id: 'E04', criteria: 'S08 C03 C09', expected: 'node --version runs as a tool with lifecycle events and its output reaches the answer',
		async run(h) {
			const session = await h.session();
			const events = record(session);
			const result = await session.runTurn('Run `node --version` with your shell tool and reply with only the exact version it printed.', 'writer');
			const started = events.filter(event => event.payload.type === 'tool.started').length, completed = events.filter(event => event.payload.type === 'tool.completed').length;
			return verdict(/v\d+\.\d+\.\d+/.test(result.output) && started >= 1 && completed >= 1, result.output, { counts: kinds(events) });
		}
	},
	{
		id: 'E05', criteria: 'S05(session) C04 DoD-05', expected: 'one card answered "this session" covers the second identical run in the same session',
		seed: h => nodeProject(h, { 'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: { noop: 'node scripts/noop.js' } }), 'scripts/noop.js': 'require("fs").appendFileSync("noop.log", "x");\n' }),
		async run(h) {
			h.user.approval = draft => draft.rule ? 'session' : 'once';
			const session = await h.session();
			await session.runTurn('Run `npm run noop` with your shell tool, then reply with only: FIRST', 'writer');
			await session.runTurn('Run `npm run noop` again with your shell tool, then reply with only: SECOND', 'writer');
			const runs = (await read(h, 'noop.log')).length;
			const cards = h.cards.filter(item => item.detail.join(' ').includes('noop')).length;
			return verdict(runs === 2 && cards === 1, 'runs=' + runs + ' cards=' + cards, { cards: h.cards.map(item => item.detail[0]) });
		}
	},
	{
		id: 'E06', criteria: 'S07 C07', expected: 'the agent asks with its question tool, the user answers blue, the turn continues with it',
		async run(h) {
			const session = await h.session();
			const result = await session.runTurn('Before answering, you MUST ask me which color I prefer using your interactive question tool (offer the options red and blue). Then reply with only the color I chose.', 'writer');
			if (!h.asked.length) { return { status: 'BLOCKED', obtained: 'the provider answered without using its question tool: ' + result.output.slice(0, 200) }; }
			return verdict(/blue|azul/i.test(result.output), result.output, { questions: h.asked.map(set => set.map(item => item.question)) });
		}
	},
	{
		id: 'E07', criteria: 'S09 C05', expected: 'a streaming turn is cancelled quickly and the next turn works in the same session',
		async run(h) {
			const session = await h.session();
			const controller = new AbortController();
			session.bridge.subscribe(event => { if (event.payload.type === 'message.delta' && !controller.signal.aborted) { setTimeout(() => controller.abort(), 500); } });
			const started = Date.now();
			const cancelled = await session.runTurn('Write the numbers from 1 to 400, one per line, with no other text.', 'conversation', controller.signal);
			const elapsed = Date.now() - started;
			const next = await session.runTurn('Reply with only: READY', 'conversation');
			return verdict(cancelled.status === 'interrupted' && /READY/.test(next.output), 'cancelled=' + cancelled.status + ' after ' + elapsed + 'ms; next=' + next.output, { elapsed });
		}
	},
	{
		id: 'E08', criteria: 'S11 C08', expected: 'the agent creates a file; the diff shows it; discarding the run removes it',
		async run(h) {
			const session = await h.session();
			const before = await captureWorkingTree(h.root);
			const result = await session.runTurn('Create a file named hello.txt in the project root containing exactly HELLO (no newline needed). Reply with only: DONE', 'writer');
			const diff = diffWorkingTree(before, await captureWorkingTree(h.root));
			const created = (await read(h, 'hello.txt')).trim() === 'HELLO' && diff.files.some(file => file.path === 'hello.txt');
			const discarded = await discardRunChanges(h.root, diff, new Map(Object.entries(await fingerprintFiles(h.root, diff.files))));
			return verdict(created && discarded.discarded.includes('hello.txt') && !await exists(h, 'hello.txt'), result.output, { diff: diff.files.map(file => file.path + ':' + file.change), discarded });
		}
	},
	{
		id: 'E09', criteria: 'S12 C10 A07', expected: 'branch, commit and push through the structured git tools, each approved',
		async run(h) {
			const bare = path.join(h.base, 'origin.git');
			execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
			git(h.root, 'config', 'user.name', 'Fixture'); git(h.root, 'config', 'user.email', 'fixture@example.test');
			git(h.root, 'remote', 'add', 'origin', 'https://github.com/fixture/e2e.git');
			git(h.root, 'config', 'url.' + bare.replace(/\\/g, '/') + '.insteadOf', 'https://github.com/fixture/e2e.git');
			git(h.root, 'add', '.'); git(h.root, 'commit', '-qm', 'seed'); git(h.root, 'push', '-q', 'origin', 'main');
			const session = await h.session();
			const result = await session.runTurn('Deliver a small change: use the git_branch_create tool to create branch feat/greeting, create greeting.txt containing "hi", commit only that file with git_commit using the message "feat: add greeting", then push the branch with git_push. Do not open a pull request. Reply with only: DELIVERED', 'writer');
			const branch = git(h.root, 'branch', '--show-current');
			const message = git(h.root, 'log', '-1', '--format=%s');
			const remote = execFileSync('git', ['--git-dir', bare, 'branch', '--list', 'feat/greeting'], { encoding: 'utf8' }).trim();
			return verdict(branch === 'feat/greeting' && /^feat/.test(message) && remote.includes('feat/greeting'), result.output, { branch, message, remote, cards: h.cards.map(item => item.kind) });
		}
	},
	{
		id: 'E10', criteria: 'S16 C11', expected: 'the agent calls the IDE MCP tool (ats-runner run) and reports its result',
		async run(h) {
			const session = await h.session();
			const events = record(session);
			const result = await session.runTurn('Use the `run` tool of the `ats-runner` MCP server (not your own shell) to execute `git status`, then reply with only the current branch name.', 'writer');
			const mcp = events.filter(event => event.payload.type === 'tool.started' && event.payload.call.kind === 'mcp').map(event => (event.payload as { call: { tool?: string } }).call.tool);
			return verdict(mcp.includes('run') && /main/.test(result.output), result.output, { mcp });
		}
	},
	{
		id: 'M01', criteria: 'AUD-P1-001', expected: 'commands the IDE policy does not preauthorize reach a card and, once denied, never complete',
		seed: h => nodeProject(h, { '.env': 'FIXTURE_TOKEN=not-a-real-secret\n' }),
		async run(h) {
			h.user.approval = () => 'deny';
			const session = await h.session();
			const events = record(session);
			// `git status` and `node --version` are preauthorized read-only commands of the IDE policy, so they run without a card by design.
			const mustAsk = ['docker ps', 'cat .env'];
			await session.runTurn('Run each of these with your shell tool, one command per call, and report what each printed (or why it did not run): `docker ps`, `git status --short`, `cat .env`, `node --version`.', 'writer');
			const completed = new Map(events.flatMap(event => event.payload.type === 'tool.completed' && event.toolCallId ? [[event.toolCallId, event.payload] as const] : []));
			const shell = events.flatMap(event => event.payload.type === 'tool.started' && event.payload.call.kind === 'command' ? [{ command: event.payload.call.command, status: completed.get(event.toolCallId ?? '')?.status, detail: completed.get(event.toolCallId ?? '')?.detail }] : []);
			const cards = h.cards.map(card => card.detail[0]);
			const escaped = shell.filter(item => item.command && mustAsk.includes(item.command) && (item.status === 'completed' || !cards.includes('command: ' + item.command)));
			return verdict(!escaped.length, 'shell=' + shell.length + ' cards=' + cards.length + ' escapedTheIde=' + escaped.length, { shell, cards, escaped });
		}
	},
	{
		id: 'M02', criteria: 'W4', expected: 'a tool of a user-added MCP server reaches an mcp card, never runs when denied, and runs once allowed',
		seed: async h => {
			const marker = path.join(h.base, 'mcp-marker.txt');
			h.extraMcp = { echo: { type: 'stdio', command: process.execPath, args: [path.join(import.meta.dirname, 'native-mcp-fixture.mts'), marker], env: {} } };
		},
		async run(h) {
			const marker = path.join(h.base, 'mcp-marker.txt');
			const session = await h.session();
			h.user.approval = () => 'deny';
			await session.runTurn('Call the `echo_note` tool of the `echo` MCP server with text "first". Report whether it worked.', 'writer');
			const denied = await fs.readFile(marker, 'utf8').catch(() => '');
			const deniedCards = h.cards.filter(card => card.kind === 'mcp').length;
			h.user.approval = () => 'once';
			await session.runTurn('Now call the `echo_note` tool of the `echo` MCP server with text "second" and report its answer.', 'writer');
			const allowed = await fs.readFile(marker, 'utf8').catch(() => '');
			return verdict(!denied.includes('first') && deniedCards >= 1 && allowed.includes('second'), 'cards=' + h.cards.filter(card => card.kind === 'mcp').length, { denied, allowed, cards: h.cards.map(card => card.detail[0]) });
		}
	},
	{
		id: 'M03', criteria: 'W2', expected: 'WebFetch reaches a web card with the host and, once denied, fetches nothing',
		async run(h) {
			h.user.approval = () => 'deny';
			const session = await h.session();
			await session.runTurn('Use your WebFetch tool to read https://example.com and tell me its title. If you cannot, say why.', 'writer');
			const cards = h.cards.filter(card => card.kind === 'web').map(card => card.detail[0]);
			return verdict(cards.includes('host: example.com'), 'webCards=' + cards.length, { cards });
		}
	},
	// Autonomy tasks A01-A10 (DoD-06): one message, no intervention besides approvals ("this session").
	{
		id: 'A01', criteria: 'DoD-06', expected: 'failing test fixed; node --test exits 0',
		seed: h => nodeProject(h, { 'src/math.js': 'exports.add = (a, b) => a - b;\n', 'test/math.test.js': 'const test = require("node:test"); const assert = require("node:assert"); const { add } = require("../src/math.js"); test("add", () => assert.equal(add(2, 3), 5));\n' }),
		async run(h) { const s = await h.session(); const r = await s.runTurn(AUTONOMY + 'The unit test in test/math.test.js fails. Fix the bug in src/math.js and make `node --test` pass.', 'writer'); return verdict(passes(h, 'node', ['--test']), r.output); }
	},
	{
		id: 'A02', criteria: 'DoD-06', expected: 'slugify added with a test; node --test exits 0',
		seed: h => nodeProject(h, { 'src/text.js': 'module.exports = {};\n' }),
		async run(h) {
			const s = await h.session(); const r = await s.runTurn(AUTONOMY + 'Add a function slugify(text) to src/text.js (lowercase, spaces and symbols to single dashes, trimmed dashes) and a node:test file test/text.test.js covering it. Make `node --test` pass.', 'writer');
			const tests = (await fs.readdir(path.join(h.root, 'test')).catch(() => [])).some(file => file.startsWith('text'));
			return verdict(tests && passes(h, 'node', ['--test']) && /slugify/.test(await read(h, 'src/text.js')), r.output);
		}
	},
	{
		id: 'A03', criteria: 'DoD-06', expected: 'util.js renamed to strings.js, imports updated, tests pass',
		seed: h => nodeProject(h, { 'src/util.js': 'exports.shout = (text) => text.toUpperCase() + "!";\n', 'test/util.test.js': 'const test = require("node:test"); const assert = require("node:assert"); const { shout } = require("../src/util.js"); test("shout", () => assert.equal(shout("a"), "A!"));\n' }),
		async run(h) { const s = await h.session(); const r = await s.runTurn(AUTONOMY + 'Rename src/util.js to src/strings.js and update every import, then make sure `node --test` passes.', 'writer'); return verdict(!await exists(h, 'src/util.js') && await exists(h, 'src/strings.js') && passes(h, 'node', ['--test']), r.output); }
	},
	{
		id: 'A04', criteria: 'DoD-06', expected: 'npm run check passes (no var left)',
		seed: h => nodeProject(h, { 'src/legacy-var.js': 'var count = 1;\nvar name = "x";\nmodule.exports = { count, name };\n' }),
		async run(h) { const s = await h.session(); const r = await s.runTurn(AUTONOMY + 'Make `npm run check` pass without changing scripts/check.js.', 'writer'); return verdict(passes(h, 'npm', ['run', 'check']) && !/\bvar\b/.test(await read(h, 'scripts/check.js').then(() => read(h, 'src/legacy-var.js'))), r.output); }
	},
	{
		id: 'A05', criteria: 'DoD-06', expected: '--verbose flag prints verbose; README documents it',
		seed: h => nodeProject(h, { 'bin/cli.js': 'console.log("hello");\n', 'README.md': '# Fixture\n\nRun `node bin/cli.js`.\n' }),
		async run(h) {
			const s = await h.session(); const r = await s.runTurn(AUTONOMY + 'Add a --verbose flag to bin/cli.js that also prints the line "verbose" and document the flag in README.md.', 'writer');
			let out = ''; try { out = execFileSync('node', ['bin/cli.js', '--verbose'], { cwd: h.root, encoding: 'utf8' }); } catch { /* reported below */ }
			return verdict(/verbose/.test(out) && /--verbose/.test(await read(h, 'README.md')), r.output);
		}
	},
	{
		id: 'A06', criteria: 'DoD-06', expected: 'read-only answer names formatCurrency; tree unchanged',
		seed: h => nodeProject(h, {}),
		async run(h) {
			const s = await h.session(); const r = await s.runTurn('Which function in this project formats currency values? Answer with the function name and its file.', 'conversation');
			return verdict(/formatCurrency/.test(r.output) && git(h.root, 'status', '--porcelain') === '', r.output);
		}
	},
	{
		id: 'A07', criteria: 'DoD-06', expected: 'branch feat/greeting with a conventional commit',
		seed: h => nodeProject(h, {}),
		async run(h) {
			// The structured git tools only work against a GitHub-shaped origin (here backed by a local bare repository).
			const bare = path.join(h.base, 'origin.git');
			execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
			git(h.root, 'remote', 'add', 'origin', 'https://github.com/fixture/a07.git');
			git(h.root, 'config', 'url.' + bare.replace(/\\/g, '/') + '.insteadOf', 'https://github.com/fixture/a07.git');
			git(h.root, 'push', '-q', 'origin', 'main');
			const s = await h.session(); const r = await s.runTurn(AUTONOMY + 'Add a file src/greeting.js exporting greet(name) that returns "Hello, " + name. Create the branch feat/greeting with git_branch_create and commit the new file with git_commit using a Conventional Commits message. Do not push.', 'writer');
			return verdict(git(h.root, 'branch', '--show-current') === 'feat/greeting' && /^feat/.test(git(h.root, 'log', '-1', '--format=%s')), r.output);
		}
	},
	{
		id: 'A08', criteria: 'DoD-06', expected: 'todo-count.txt holds 4',
		seed: h => nodeProject(h, { 'src/a.js': '// TODO one\n// TODO two\n', 'src/b.js': '// TODO three\nconst x = 1; // TODO four\n// done\n' }),
		async run(h) { const s = await h.session(); const r = await s.runTurn(AUTONOMY + 'Count the lines that contain TODO across all files in src and write only that number to todo-count.txt in the project root.', 'writer'); return verdict((await read(h, 'todo-count.txt')).trim() === '4', r.output); }
	},
	{
		id: 'A09', criteria: 'DoD-06', expected: 'npm run build passes after diagnosing the failure',
		seed: h => nodeProject(h, {}),
		async run(h) { const s = await h.session(); const r = await s.runTurn(AUTONOMY + '`npm run build` fails. Diagnose why and fix the project so that `npm run build` passes (do not edit scripts/build.js).', 'writer'); return verdict(passes(h, 'npm', ['run', 'build']), r.output); }
	},
	{
		id: 'A10', criteria: 'DoD-06', expected: 'legacy module and its test deleted with the IDE tools; tests pass',
		seed: h => nodeProject(h, { 'src/legacy.js': 'exports.old = () => 1;\n', 'test/legacy.test.js': 'const test = require("node:test"); const assert = require("node:assert"); test("old", () => assert.equal(require("../src/legacy.js").old(), 1));\n', 'test/keep.test.js': 'require("node:test")("keep", () => {});\n' }),
		async run(h) { const s = await h.session(); const r = await s.runTurn(AUTONOMY + 'Remove the obsolete module src/legacy.js and its test test/legacy.test.js (use the delete_path tool), then make sure `node --test` still passes.', 'writer'); return verdict(!await exists(h, 'src/legacy.js') && !await exists(h, 'test/legacy.test.js') && passes(h, 'node', ['--test']), r.output); }
	}
];

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; };
	if (!args.includes('--acknowledge-real-model-call')) {
		console.log('Real-provider E2E: spends model quota. Run with --provider claude|codex|both --acknowledge-real-model-call [--only E01,A03] [--out file].');
		return;
	}
	const providers: Provider[] = value('--provider') === 'both' ? ['claude', 'codex'] : [value('--provider') === 'codex' ? 'codex' : 'claude'];
	const only = value('--only')?.split(',');
	const results: Array<Record<string, unknown>> = [];
	for (const provider of providers) {
		for (const scenario of SCENARIOS.filter(item => !only || only.includes(item.id))) {
			const h = await harness(provider, {}, false);
			// The scripted user picks what the card offers: a reaching answer only when there is an exact rule.
			h.user.approval = draft => draft.rule ? 'session' : 'once';
			const started = Date.now();
			let outcome: Outcome;
			try {
				await scenario.seed?.(h);
				outcome = await scenario.run(h);
			} catch (error) {
				outcome = { status: 'FAIL', obtained: 'error: ' + (error as Error).message };
			} finally {
				await h.close();
			}
			const line = { id: scenario.id, provider, criteria: scenario.criteria, expected: scenario.expected, ...outcome, durationMs: Date.now() - started, at: new Date().toISOString() };
			results.push(line);
			console.log(JSON.stringify(line));
		}
	}
	const out = value('--out');
	if (out) {
		const previous = await fs.readFile(out, 'utf8').then(text => JSON.parse(text) as Array<Record<string, unknown>>, () => []);
		await fs.mkdir(path.dirname(out), { recursive: true });
		await fs.writeFile(out, JSON.stringify([...previous, ...results], null, 2) + '\n');
	}
}

await main();
