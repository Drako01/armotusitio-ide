/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { runEditorTool, type EditorBackend } from '../src/native-editor-tools.ts';
import { commandAllowed, KeychainDevSecrets, type SecretMeta } from '../src/native-dev-secrets.ts';
import { callToolChannel, openToolChannel } from '../src/native-tool-server.ts';
import { parseExcludedPorts, pickPort, runDoctor, type Exec } from '../src/native-machine-doctor.ts';
import { collectOrphans, createEnvironment } from '../src/native-ephemeral-env.ts';
import { DecisionLog, decisionsPrompt } from '../src/native-decisions.ts';
import { budgetLevel, estimateCalls, quotaCheck } from '../src/native-goal-budget.ts';
import { publishProcesses, readProcesses } from '../src/native-process-monitor.ts';
import { integrationOrder, linkedPullRequestsSection } from '../src/native-multi-repo.ts';
import { cardCriteria, cardKeyOf, readCard } from '../src/native-card-goal.ts';
import { reviewTasks, threadStates } from '../src/native-review-comments.ts';
import { createActivityFeed } from '../src/native-activity-feed.ts';

test('editor tools answer with project-relative, bounded results and refuse refactors outside the scope', async () => {
	const root = path.resolve('/repo');
	let applied = 0;
	const backend: EditorBackend = {
		async locations() { return [{ file: path.join(root, 'internal/app/app.go'), line: 9, character: 4, preview: 'func Run()' }]; },
		async symbols() { return [{ name: 'Run', kind: 'Function', file: path.join(root, 'internal/app/app.go'), line: 9 }]; },
		async hover() { return ['func Run() error']; },
		async calls() { return []; },
		async diagnostics() { return [{ file: path.join(root, 'a.go'), line: 0, severity: 'error', message: 'undefined: x' }]; },
		async rename(_file, _line, _character, name) { return { files: [path.join(root, 'internal/app/app.go'), path.join(root, name === 'Outside' ? 'cmd/main.go' : 'internal/app/app_test.go')], apply: async () => { applied++; } }; },
		async organizeImports() { return undefined; }
	};
	const context = { root, backend, inScope: (file: string) => file.startsWith('internal/') };
	assert.deepEqual([
		await runEditorTool(context, 'definition', { file: 'internal/app/app.go', line: 1, character: 1 }),
		await runEditorTool(context, 'diagnostics', {}),
		await runEditorTool(context, 'rename', { file: 'internal/app/app.go', line: 10, character: 5, newName: 'Start' }),
		await runEditorTool(context, 'rename', { file: 'internal/app/app.go', line: 10, character: 5, newName: 'Outside' }),
		applied
	], ['internal/app/app.go:10:5  func Run()', 'a.go:1 error: undefined: x', 'Applied to 2 files:\ninternal/app/app.go\ninternal/app/app_test.go', 'POLICY_DENIED: edit-outside-scope (cmd/main.go)', 1]);
	await assert.rejects(runEditorTool(context, 'hover', { file: '../etc/passwd', line: 1, character: 1 }), /HARNESS_PATH_ESCAPE/);
});

test('development secrets reach only allowed commands and are redacted in every common encoding', async () => {
	const keychain = new Map<string, string>();
	let metadata: SecretMeta[] = [];
	const secrets = new KeychainDevSecrets({ get: async key => keychain.get(key), store: async (key, value) => { keychain.set(key, value); }, delete: async key => { keychain.delete(key); }, metadata: () => metadata, saveMetadata: async value => { metadata = value; } });
	const dsn = 'postgres://app:s3cr3t-p4ss@127.0.0.1:5432/e2e';
	await secrets.set('p', 'APP_E2E_DSN', dsn, ['go test @apps/api']);
	const allowed = await secrets.forCommand('p', 'go', ['test', './...'], 'apps/api');
	const denied = await secrets.forCommand('p', 'go', ['run', '.'], 'apps/api');
	const output = 'fail: ' + dsn + ' / ' + encodeURIComponent(dsn) + ' / ' + Buffer.from(dsn).toString('base64');
	assert.deepEqual({ allowed, denied, redacted: secrets.redact(output), metadataHasValue: JSON.stringify(metadata).includes('s3cr3t'), uses: metadata[0].uses, other: commandAllowed(['go test @apps/api'], 'go', ['test'], 'apps/web') },
		{ allowed: { APP_E2E_DSN: dsn }, denied: {}, redacted: 'fail: [REDACTED] / [REDACTED] / [REDACTED]', metadataHasValue: false, uses: 1, other: false });
});

test('the tool channel answers only requests that carry the run token', async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-channel-'));
	const channel = await openToolChannel(storage, async (method, params) => method === 'echo' ? params : undefined);
	try {
		assert.deepEqual(await callToolChannel(channel.address, channel.token, 'echo', { a: 1 }), { a: 1 });
		await assert.rejects(callToolChannel(channel.address, 'wrong-token', 'echo', {}), /HARNESS_UNTRUSTED_OR_CANCELLED/);
	} finally { await channel.close(); await fs.rm(storage, { recursive: true, force: true }); }
});

test('the machine doctor reports each problem with its action, and environments avoid ports Windows reserves', async () => {
	const ranges = parseExcludedPorts('Start Port    End Port\n----------    --------\n      5357        5357\n     15400       15499\n');
	const exec: Exec = async (command, args) => command === 'docker' ? { code: 1, output: '' } : command === 'netsh' ? { code: 0, output: '15400 15499' } : command === 'git' && args[1] === 'user.name' ? { code: 0, output: 'Dev' } : command === 'git' && args[1] === 'user.email' ? { code: 0, output: 'dev@example.com' } : command === 'go' ? { code: 0, output: 'go version go1.25' } : { code: 1, output: '' };
	const checks = await runDoctor({ exec, platform: 'win32', projectRoot: os.tmpdir(), ports: [15432, 6379], toolchains: [{ command: 'go', args: ['version'], label: 'Go' }, { command: 'cargo', args: ['--version'], label: 'Rust' }], serverDate: async () => Date.now() - 600_000 });
	assert.deepEqual({
		ranges, pick: pickPort(15400, ranges), statuses: Object.fromEntries(checks.map(check => [check.id, check.status])), portAction: !!checks.find(check => check.id === 'ports')?.action
	}, {
		ranges: [{ start: 5357, end: 5357 }, { start: 15400, end: 15499 }], pick: 15500, portAction: true,
		statuses: { docker: 'warning', wsl: 'warning', ports: 'problem', disk: 'ok', 'tool-go': 'ok', 'tool-cargo': 'problem', git: 'ok', 'git-longpaths': 'warning', clock: 'problem' }
	});
});

test('an ephemeral environment is created labeled, waits for its service, exports variables and leaves nothing behind', async () => {
	const server = net.createServer(socket => socket.on('data', () => socket.write('N')));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as net.AddressInfo).port;
	const calls: string[][] = [];
	const containers = new Set<string>();
	const exec: Exec = async (command, args) => {
		calls.push([command, ...args]);
		if (args[0] === 'run') { containers.add('c1'); return { code: 0, output: 'c1' }; }
		if (args[0] === 'rm') { containers.delete(args.at(-1)!); return { code: 0, output: '' }; }
		if (args[0] === 'ps') { return { code: 0, output: 'c1 goal-a\nc9 goal-live\n' }; }
		return { code: 0, output: '' };
	};
	try {
		const environment = await createEnvironment({
			goalId: 'goal-a', exec, excludedPorts: [{ start: 0, end: port - 1 }, { start: port + 1, end: 65535 }], sleep: async () => undefined,
			template: { name: 'pg', services: [{ name: 'db', image: 'postgres:16.4', containerPort: 5432, kind: 'postgres', env: { POSTGRES_PASSWORD: 'postgres' } }], exports: { APP_E2E_DSN: 'postgres://postgres:postgres@127.0.0.1:{port:db}/postgres' } }
		});
		const run = calls.find(call => call[1] === 'run')!;
		assert.deepEqual({ labels: run.filter(arg => arg.startsWith('ats.')), bind: run.includes('127.0.0.1:' + port + ':5432'), exported: environment.exports.APP_E2E_DSN.endsWith(':' + port + '/postgres') }, { labels: ['ats.managed=1', 'ats.goal=goal-a'], bind: true, exported: true });
		await environment.destroy();
		containers.add('c1');
		assert.deepEqual({ left: containers.size, collected: await collectOrphans(exec, new Set(['goal-live'])) }, { left: 1, collected: ['c1'] });
		await assert.rejects(createEnvironment({ goalId: 'x', exec, excludedPorts: [], template: { name: 'bad', services: [{ name: 'db', image: 'postgres:latest', containerPort: 5432, kind: 'postgres' }], exports: {} } }), /HARNESS_CONFIG_SCHEMA/);
	} finally { await new Promise(resolve => server.close(resolve)); }
});

test('decisions supersede by title, reach agents and export as ADRs only on request; budgets estimate and warn', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-decisions-'));
	try {
		const log = new DecisionLog(directory);
		await log.record({ title: 'Redis', context: 'caché', decision: 'El primero que responda', alternatives: ['Uno fijo'], scope: [], source: 'answer' });
		await log.record({ title: 'redis', context: 'caché', decision: 'Sólo loopback', alternatives: [], scope: ['apps/api/**'], source: 'user' });
		const relevant = await log.relevant(['apps/api/x.go']);
		const written = await log.exportAdrs(path.join(directory, 'adr'));
		assert.deepEqual({ active: relevant.map(item => item.decision), prompt: decisionsPrompt(relevant).includes('Sólo loopback'), written: written.length, statuses: (await log.list()).map(item => item.status) },
			{ active: ['Sólo loopback'], prompt: true, written: 2, statuses: ['superseded', 'active'] });
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
	const history = [10, 12, 14, 30].map(calls => ({ size: 'goal' as const, tasks: 3, calls, at: '' }));
	assert.deepEqual({ estimate: estimateCalls('goal', 3, history), fits: quotaCheck({ low: 10, high: 30, basis: 'history' }, 40, 100, 20), levels: [budgetLevel(5, 12), budgetLevel(10, 12), budgetLevel(12, 12)] },
		{ estimate: { low: 10, high: 14, basis: 'history' }, fits: { fits: false, available: 20, advice: 'split-or-other-provider' }, levels: ['ok', 'warning', 'exhausted'] });
});

test('long processes are followed from their progress file, stalls are flagged and ends are reported once', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-processes-'));
	try {
		const log = path.join(directory, 'build.log');
		await fs.writeFile(log, 'stage 1\nstage 2: compiling\n');
		await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify({ title: 'Release r5', phase: 'build-all', percent: 40, log, pid: process.pid, state: 'running' }));
		const feed = createActivityFeed(callback => { callback(); return { cancel() { } }; });
		const states = new Map();
		const running = await readProcesses(directory, 15);
		const stalled = await readProcesses(directory, 15, Date.now() + 20 * 60_000);
		assert.deepEqual({ running: running.map(view => [view.state, view.logTail.at(-1)]), stalled: stalled[0].state, firstEnd: publishProcesses(feed, running, 'IDE', states).length }, { running: [['running', 'stage 2: compiling']], stalled: 'stalled', firstEnd: 0 });
		await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify({ title: 'Release r5', state: 'completed', log }));
		const finished = publishProcesses(feed, await readProcesses(directory, 15), 'IDE', states);
		assert.deepEqual({ finished: finished.map(view => view.state), item: feed.snapshot()[0].state }, { finished: ['completed'], item: 'completed' });
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('multi-repo order, cards and inline review become concrete tasks', async () => {
	const order = integrationOrder([{ name: 'ide', root: '/a', dependsOn: ['redevent'] }, { name: 'redevent', root: '/b', dependsOn: [] }]);
	assert.deepEqual(order.map(part => part.name), ['redevent', 'ide']);
	assert.throws(() => integrationOrder([{ name: 'a', root: '', dependsOn: ['b'] }, { name: 'b', root: '', dependsOn: ['a'] }]), /HARNESS_CYCLE/);
	assert.match(linkedPullRequestsSection([{ name: 'redevent', branch: 'harness/x' }, { name: 'ide', branch: 'harness/x' }], 'ide'), /1\. redevent[\s\S]*2\. ide .*este PR/);
	const client = { tools: async () => [{ name: 'get_issue_context' }], call: async () => ({ structuredContent: { issue: { title: 'Exportar clientes', description: 'Contexto.\n\n## Criterios de aceptación\n- Exporta CSV con todos los clientes\n- Respeta el tenant\n\n## Notas\nx' } } }) };
	const card = await readCard(client, 'RED-001-257');
	assert.deepEqual({ key: cardKeyOf('Implementá RED-001-257 hoy'), criteria: card.criteria, comment: card.canComment, plain: cardCriteria('- [ ] uno dos tres\n- [x] cuatro cinco') },
		{ key: 'RED-001-257', criteria: ['Exporta CSV con todos los clientes', 'Respeta el tenant'], comment: false, plain: ['uno dos tres', 'cuatro cinco'] });
	const comments = [{ id: '1', file: 'a.go', line: 3, text: 'Falta el caso de error', lineText: 'return nil' }, { id: '2', file: 'b.go', line: 8, text: 'Renombrá esto', lineText: 'x := 1' }, { id: '3', file: 'c.go', line: 1, text: ' ' }];
	assert.deepEqual({ tasks: reviewTasks(comments).map(task => task.title), states: threadStates(comments, new Set(['a.go']), true, comment => comment.id === '2' ? 'y := 1' : comment.lineText) },
		{ tasks: ['a.go:3', 'b.go:8'], states: { 1: 'resolved', 2: 'outdated', 3: 'open' } });
});
