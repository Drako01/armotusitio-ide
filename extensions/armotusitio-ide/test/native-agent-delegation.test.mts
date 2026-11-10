/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegationBroker, type ReadOnlyDelegation } from '../src/native-agent-delegation.ts';
import { buildAgentInvocation, executeReviewedAgent, type AgentExecution, type AgentOutcome } from '../src/native-agent-execution.ts';
import type { ChatStep } from '../src/native-run-steps.ts';
import { spawn } from 'node:child_process';
import { stopProcess, terminateOwnedProcess } from '../src/native-runtime.ts';
import { reviewAgentDraft, type AgentDraft } from '../src/native-providers.ts';
import { installFakeCli } from './native-runtime-fakes.mts';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcConnection } from '../src/runtime/json-rpc.ts';
import { openToolChannel } from '../src/native-tool-server.ts';

const request: ReadOnlyDelegation = { role: 'reviewer', instruction: 'Review authentication without making changes.' };
const passed = (): AgentOutcome => ({ status: 'passed', exitCode: 0, durationMs: 1, output: 'reviewed private-fixture-value', truncated: false, scopeVerified: true });
const completed = (): AgentExecution => ({ outcome: Promise.resolve(passed()), cancel() { assert.fail('completed child must not be cancelled'); } });

test('role fallback records one lifecycle and redacts the bounded result without claiming native subagents', async () => {
	const launched: ReadOnlyDelegation[] = [], steps: ChatStep[] = [];
	const broker = createDelegationBroker({
		enabled: () => true, authorize: async () => true,
		launch: async input => { launched.push(input); return completed(); }, step: step => steps.push(step), redact: value => value.replace('private-fixture-value', '[REDACTED]')
	});
	const result = await broker.call(request);
	assert.deepEqual(launched, [request]);
	assert.deepEqual(steps.map(step => [step.kind, step.status]), [['tool', 'running'], ['tool', 'ok']]);
	assert.equal(steps[0].id, steps[1].id);
	assert.ok(JSON.stringify(result).includes('ide-readonly-role') && !JSON.stringify(result).includes('private-fixture-value'));
	broker.dispose();
});

test('an observer exception is diagnosed without controlling a child or leaking observer error text', async () => {
	const broker = createDelegationBroker({ enabled: () => true, authorize: async () => true, launch: async () => completed(), step: () => { throw Error('private observer text'); } });
	const result = await broker.call(request) as { content: { text: string }[] };
	const detail = JSON.parse(result.content[0].text) as { diagnostic: string; observerFailures: number };
	assert.deepEqual([detail.diagnostic, detail.observerFailures], ['HARNESS_DELEGATION_OBSERVER_FAILED', 2]);
	assert.ok(!JSON.stringify(result).includes('private observer text'));
	broker.dispose();
});

test('owned-handle termination failures have bounded diagnostics without throwing raw errors', () => {
	const diagnostics: string[] = [];
	for (const kill of [() => false, () => { throw Error('private native error'); }]) {
		terminateOwnedProcess({ exitCode: null, signalCode: null, kill }, code => diagnostics.push(code));
	}
	assert.deepEqual(diagnostics, ['HARNESS_PROCESS_TERMINATION_FAILED', 'HARNESS_PROCESS_TERMINATION_FAILED']);
});

test('child invocation has an empty tool surface and denies unsupported provider isolation', () => {
	const draft: AgentDraft = { schemaVersion: 1, provider: 'claude', role: 'reviewer', projectRoot: path.resolve('.'), instruction: 'Analyze supplied context', readOnly: true };
	const invocation = buildAgentInvocation(draft, [], undefined, true);
	assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], '');
	assert.equal(invocation.args[invocation.args.indexOf('--setting-sources') + 1], '');
	assert.equal(invocation.args[invocation.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
	assert.ok(invocation.args.includes('--strict-mcp-config'));
	assert.match(invocation.stdin, /no tools/);
	assert.throws(() => buildAgentInvocation({ ...draft, provider: 'codex' }, [], undefined, true), /ISOLATION_UNSUPPORTED/);
});

test('an installed CLI missing strict isolation flags is rejected before a model process is started', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-isolated-child-')));
	try {
		const bin = path.join(root, 'bin');
		const marker = path.join(root, 'model-started');
		await installFakeCli(bin, 'claude', `if (process.argv.includes('--help')) { console.log('--tools'); } else { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); }`);
		const pathName = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
		const env = { ...process.env, [pathName]: bin + path.delimiter + process.env[pathName] };
		const draft: AgentDraft = { schemaVersion: 1, provider: 'claude', role: 'reviewer', projectRoot: root, instruction: 'Analyze supplied context', readOnly: true };
		await assert.rejects(executeReviewedAgent(reviewAgentDraft(draft), draft, 10000, undefined, undefined, undefined, undefined, undefined, () => env, true), /ISOLATION_UNSUPPORTED/);
		await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('malformed or authority-widening delegation requests never launch a child', async () => {
	const broker = createDelegationBroker({ enabled: () => true, authorize: async () => assert.fail('must not ask'), launch: async () => assert.fail('must not launch') });
	for (const input of [null, [], {}, { ...request, role: 'implementer' }, { ...request, provider: 'other-account' }, { ...request, depth: 4 }, { ...request, instruction: ' ' }, { ...request, instruction: 'x'.repeat(8001) }]) {
		await assert.rejects(broker.call(input), /INPUT_INVALID/);
	}
});

test('a refusal is final for that exact task and does not consume a model call', async () => {
	let asked = 0;
	const broker = createDelegationBroker({ enabled: () => true, authorize: async () => { asked++; return false; }, launch: async () => assert.fail('must not launch') });
	await assert.rejects(broker.call(request), /DENIED/);
	await assert.rejects(broker.call(request), /DENIED/);
	assert.equal(asked, 1);
});

test('at most two launches are allowed across the parent session, including failed starts', async () => {
	let launched = 0;
	const broker = createDelegationBroker({ enabled: () => true, authorize: async () => true, launch: async () => { launched++; return completed(); } });
	await broker.call(request); await broker.call(request);
	await assert.rejects(broker.call(request), /LIMIT/);
	assert.equal(launched, 2);
	const failed = createDelegationBroker({ enabled: () => true, authorize: async () => true, launch: async () => { throw Error('HARNESS_QUOTA_EXHAUSTED'); } });
	await assert.rejects(failed.call(request), /QUOTA_EXHAUSTED/);
	await assert.rejects(failed.call(request), /QUOTA_EXHAUSTED/);
	await assert.rejects(failed.call(request), /LIMIT/);
});

test('pending approvals occupy the concurrency bound and cannot race the session budget', async () => {
	const approval = Promise.withResolvers<boolean>();
	let launched = 0;
	const broker = createDelegationBroker({ enabled: () => true, authorize: () => approval.promise, launch: async () => { launched++; return completed(); } });
	const a = broker.call(request), b = broker.call({ ...request, role: 'planner' });
	await assert.rejects(broker.call(request), /LIMIT/);
	approval.resolve(true);
	await Promise.all([a, b]);
	assert.equal(launched, 2);
});

test('parent cancellation during an approval prevents launch', async () => {
	const approval = Promise.withResolvers<boolean>();
	const broker = createDelegationBroker({ enabled: () => true, authorize: () => approval.promise, launch: async () => assert.fail('must not launch') });
	const call = broker.call(request);
	broker.dispose(); approval.resolve(true);
	await assert.rejects(call, /LIMIT_OR_DENIED/);
});

test('parent cancellation during async launch cancels the child as soon as its handle exists', async () => {
	const launch = Promise.withResolvers<AgentExecution>(), started = Promise.withResolvers<void>(), outcome = Promise.withResolvers<AgentOutcome>();
	let cancelled = 0;
	const broker = createDelegationBroker({ enabled: () => true, authorize: async () => true, launch: async () => { started.resolve(); return launch.promise; } });
	const call = broker.call(request);
	await started.promise; broker.dispose();
	launch.resolve({ outcome: outcome.promise, cancel() { cancelled++; outcome.resolve({ ...passed(), status: 'cancelled' }); } });
	const result = await call;
	assert.equal(cancelled, 1);
	assert.ok(JSON.stringify(result).includes('cancelled'));
});

test('a revoked parent cannot start a child and output remains bounded with unknown usage', async () => {
	let enabled = false;
	const broker = createDelegationBroker({ enabled: () => enabled, authorize: async () => true, launch: async () => ({ ...completed(), outcome: Promise.resolve({ ...passed(), output: 'x'.repeat(100000) }) }) });
	await assert.rejects(broker.call(request), /DENIED/);
	enabled = true;
	const result = await broker.call(request) as { content: { text: string }[] };
	const parsed = JSON.parse(result.content[0].text) as { output: string; usage: unknown };
	assert.deepEqual([parsed.output.length, parsed.usage], [16000, null]);
});

test('owned subprocess cancellation completes even when the host denies taskkill', async () => {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' });
	const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
	await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		stopProcess(child);
		await Promise.race([exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('owned process did not stop')), 5000); })]);
		assert.ok(child.exitCode !== null || child.signalCode !== null);
	} finally { clearTimeout(timer); child.kill(); await exited; }
});

test('a provider discovers and uses the bounded role through the authenticated runner, without model calls', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-delegate-'));
	let launches = 0;
	const broker = createDelegationBroker({ enabled: () => true, authorize: async () => true, launch: async () => { launches++; return completed(); } });
	const channel = await openToolChannel(root, async (method, input) => { assert.equal(method, 'delegate-readonly'); return broker.call(input); });
	const file = path.join(root, 'runner.json');
	await fs.writeFile(file, JSON.stringify({
		schemaVersion: 1, root, policy: { subprojects: [], delegate: false, extras: [] }, env: {}, logDirectory: root,
		channel: { address: channel.address, token: channel.token }, delegation: true
	}));
	const entry = process.env.ATS_TEST_RUNNER_ENTRY ?? fileURLToPath(new URL('../src/ats-runner.ts', import.meta.url));
	const child = spawn(process.execPath, [entry, file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
	child.stderr.resume();
	const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
	const rpc = new JsonRpcConnection(child.stdin, child.stdout, { request: async () => { throw Error('unexpected request'); }, notification: () => undefined, malformed: () => undefined });
	try {
		await rpc.request('initialize', {}, 60000);
		const catalog = await rpc.request<{ tools: { name: string }[] }>('tools/list', {});
		assert.ok(catalog.tools.some(tool => tool.name === 'delegate_readonly'));
		const result = await rpc.request<{ isError: boolean }>('tools/call', { name: 'delegate_readonly', arguments: request });
		assert.equal(result.isError, false);
		assert.equal(launches, 1);
		broker.dispose();
		const denied = await rpc.request<{ isError: boolean }>('tools/call', { name: 'delegate_readonly', arguments: request });
		assert.equal(denied.isError, true);
	} finally { broker.dispose(); rpc.close(); child.kill(); await exited; await channel.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
