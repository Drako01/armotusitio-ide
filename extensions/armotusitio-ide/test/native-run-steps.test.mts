/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ClaudeEventAccumulator, CodexEventAccumulator } from '../src/native-provider-output.ts';
import { MAX_STEPS, MAX_STEP_DETAIL, MAX_STEP_LABEL, MAX_SUMMARY_STEPS, relativeStepPath, summarizeSteps, upsertStep, validChatSteps, type ChatStep } from '../src/native-run-steps.ts';

const root = path.resolve('/work/project');
const at = (...parts: string[]) => path.join(root, ...parts);
const lines = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n';

/** Runs a stream through the real accumulator and returns the latest state of every step, in order of creation. */
function collect(accumulator: typeof ClaudeEventAccumulator | typeof CodexEventAccumulator, stream: string) {
	const seen: ChatStep[] = [];
	const events = new accumulator(undefined, undefined, { root, emit: step => seen.push(step) });
	events.push(stream);
	events.finish();
	const latest = new Map<string, ChatStep>();
	for (const step of seen) { latest.set(step.id, step); }
	return { latest: [...latest.values()], seen };
}

test('Claude stream-json becomes read, edit, command, search and tool steps whose result updates the same step', () => {
	const { latest, seen } = collect(ClaudeEventAccumulator, lines(
		{ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' },
		{ type: 'assistant', message: { content: [{ type: 'text', text: 'Reviso el modelo.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: at('src', 'model.ts') } }] } },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const FILE_CONTENT_MUST_NOT_LEAK = 1;' }] } },
		{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: at('src', 'model.ts'), old_string: 'OLD_BODY', new_string: 'NEW_BODY' } }] } },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] } },
		{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'npm test', description: 'Run the unit tests' } }] } },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_3', is_error: true, content: [{ type: 'text', text: '1 test failed\nstack line 1\nstack line 2' }] }] } },
		{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_4', name: 'Grep', input: { pattern: 'clientes' } }, { type: 'tool_use', id: 'toolu_5', name: 'mcp__ats-runner__run', input: { huge: 'x'.repeat(10000) } }] } },
		{ type: 'result', subtype: 'success', result: 'Listo', session_id: '11111111-1111-4111-8111-111111111111' }
	));
	assert.deepEqual(latest, [
		{ id: 'message-1', kind: 'message', label: 'Reviso el modelo.', status: 'ok' },
		{ id: 'toolu_1', kind: 'read', label: 'src/model.ts', status: 'ok' },
		{ id: 'toolu_2', kind: 'edit', label: 'src/model.ts', status: 'ok' },
		{ id: 'toolu_3', kind: 'command', label: 'npm test', status: 'error', detail: '1 test failed' },
		{ id: 'toolu_4', kind: 'search', label: 'clientes', status: 'running' },
		{ id: 'toolu_5', kind: 'tool', label: 'mcp__ats-runner__run', status: 'running' }
	]);
	// The first sighting of a tool call is "running"; file contents and edit bodies never appear anywhere.
	assert.equal(seen.find(step => step.id === 'toolu_1')?.status, 'running');
	const everything = JSON.stringify(seen);
	assert.ok(!everything.includes('FILE_CONTENT_MUST_NOT_LEAK') && !everything.includes('OLD_BODY') && !everything.includes('NEW_BODY') && !everything.includes('xxxx'));
});

test('Codex --json items become command, edit, tool, search and message steps with their final status', () => {
	const { latest } = collect(CodexEventAccumulator, lines(
		{ type: 'thread.started', thread_id: 't' },
		{ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'npm run lint', status: 'in_progress' } },
		{ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'npm run lint', aggregated_output: 'LINT_OUTPUT_MUST_NOT_LEAK', exit_code: 2, status: 'failed' } },
		{ type: 'item.completed', item: { id: 'item_1', type: 'file_change', status: 'completed', changes: [{ path: at('src', 'a.ts'), kind: 'update' }, { path: at('src', 'b.ts'), kind: 'add' }, { path: at('c.ts'), kind: 'add' }, { path: at('d.ts'), kind: 'add' }] } },
		{ type: 'item.started', item: { id: 'item_2', type: 'mcp_tool_call', server: 'ats-runner', tool: 'run', status: 'in_progress' } },
		{ type: 'item.completed', item: { id: 'item_3', type: 'web_search', query: 'zod discriminated union' } },
		{ type: 'item.completed', item: { id: 'item_4', type: 'reasoning', text: 'Pienso en el esquema.' } },
		{ type: 'item.completed', item: { id: 'item_5', type: 'agent_message', text: 'Terminado.' } },
		{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
	));
	assert.deepEqual(latest, [
		{ id: 'item_0', kind: 'command', label: 'npm run lint', status: 'error', detail: 'exit 2' },
		{ id: 'item_1', kind: 'edit', label: 'src/a.ts, src/b.ts, c.ts +1', status: 'ok' },
		{ id: 'item_2', kind: 'tool', label: 'ats-runner.run', status: 'running' },
		{ id: 'item_3', kind: 'search', label: 'zod discriminated union', status: 'ok' },
		{ id: 'message-1', kind: 'message', label: 'Pienso en el esquema.', status: 'ok' },
		{ id: 'message-2', kind: 'message', label: 'Terminado.', status: 'ok' }
	]);
	assert.ok(!JSON.stringify(latest).includes('LINT_OUTPUT_MUST_NOT_LEAK'));
});

test('corrupt, unknown and incomplete lines are ignored without losing the final answer', () => {
	const stream = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"a.ts"}}]}}\n' +
		lines({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', id: 'x'.repeat(200), name: 'Read' }, 'junk', null, { type: 'weird' }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'never-seen' }] } },
			{ type: 'brand_new_event', payload: [1, 2, 3] },
			{ type: 'result', subtype: 'success', result: 'Hecho' });
	const seen: ChatStep[] = [];
	const events = new ClaudeEventAccumulator(undefined, undefined, { root, emit: step => seen.push(step) });
	events.push(stream);
	assert.equal(events.finish()?.message, 'Hecho');
	assert.deepEqual(seen, [{ id: 'toolu_1', kind: 'read', label: 'a.ts', status: 'running' }]);
	// A throwing observer never breaks parsing, and its first failure of the run is reported once instead of vanishing.
	const warn = mock.method(console, 'warn', () => undefined);
	try {
		const hostile = new CodexEventAccumulator(undefined, undefined, { root, emit: () => { throw Error('observer'); } });
		hostile.push(lines(
			{ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } },
			{ type: 'item.completed', item: { id: 'j', type: 'agent_message', text: 'again' } }));
		assert.equal(hostile.finish()?.message, 'again');
		assert.deepEqual(warn.mock.calls.map(call => call.arguments), [['[armotusitio] step observer failed:', 'observer']]);
	} finally { warn.mock.restore(); }
});

test('labels and details are redacted, flattened and bounded; paths are project relative', () => {
	const secret = 'sk-' + 'a1B2c3D4'.repeat(6);
	const { latest } = collect(ClaudeEventAccumulator, lines(
		{ type: 'assistant', message: { content: [
			{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer ' + secret + '" https://example.com\n&& echo ' + 'y'.repeat(500), description: 'd'.repeat(900) } },
			{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: path.resolve('/elsewhere/outside/secret.txt') } }
		] } },
		{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'failed with ' + secret + ' ' + 'z'.repeat(900) }] } }
	));
	const [command, outside] = latest;
	assert.ok(!JSON.stringify(latest).includes(secret));
	assert.ok(command.label.length <= MAX_STEP_LABEL && !command.label.includes('\n') && command.label.endsWith('...'));
	assert.ok(command.detail!.length <= MAX_STEP_DETAIL);
	assert.equal(outside.label, '.../secret.txt');
	assert.equal(outside.status, 'error');
	assert.ok(outside.detail!.length <= MAX_STEP_DETAIL);
	assert.equal(relativeStepPath(root, at('a', 'b.ts')), 'a/b.ts');
	assert.equal(relativeStepPath(root, './rel\\file.ts'), 'rel/file.ts');
	assert.equal(relativeStepPath(root, 'bad\0path'), '');
});

test('a stream never produces more than MAX_STEPS steps and the stored summary keeps the latest 50 without detail', () => {
	const events = Array.from({ length: MAX_STEPS + 50 }, (_, index) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_' + index, name: 'Read', input: { file_path: 'f' + index + '.ts' } }] } }));
	const { latest } = collect(ClaudeEventAccumulator, lines(...events));
	assert.equal(latest.length, MAX_STEPS);
	const running = [...latest.slice(0, 3), { id: 'e', kind: 'command' as const, label: 'x', status: 'error' as const, detail: 'boom' }];
	assert.deepEqual(summarizeSteps(running), [
		...latest.slice(0, 3).map(step => ({ id: step.id, kind: 'read', label: step.label, status: 'error' })),
		{ id: 'e', kind: 'command', label: 'x', status: 'error' }
	]);
	const summary = summarizeSteps(latest);
	assert.equal(summary.length, MAX_SUMMARY_STEPS);
	assert.equal(summary.at(-1)?.id, 'toolu_' + (MAX_STEPS - 1));
	assert.ok(summary.every(step => step.detail === undefined && step.status !== 'running'));
	assert.equal(upsertStep(latest, { id: 'brand-new', kind: 'tool', label: 'x', status: 'ok' }).length, MAX_STEPS);
	assert.equal(upsertStep(latest, { ...latest[0], status: 'ok' })[0].status, 'ok');
});

test('stored step summaries are validated before they are trusted', () => {
	const good: ChatStep = { id: 'a', kind: 'read', label: 'src/a.ts', status: 'ok' };
	assert.deepEqual([undefined, [good], [{ ...good, kind: 'launch' }], [{ ...good, status: 'weird' }], [{ ...good, label: 'x'.repeat(MAX_STEP_LABEL + 1) }], 'steps', Array(MAX_SUMMARY_STEPS + 1).fill(good)].map(validChatSteps),
		[true, true, false, false, false, false, false]);
});
