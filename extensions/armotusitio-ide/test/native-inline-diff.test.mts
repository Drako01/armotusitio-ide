/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { inlineDiff } from '../src/native-inline-diff.ts';
import { parseAgentTodos, RunStepExtractor, type ChatStep } from '../src/native-run-steps.ts';

test('inline diff shows changed lines with nearby context and folds long unchanged runs', () => {
	const before = Array.from({ length: 20 }, (_, index) => 'line ' + (index + 1)).join('\n') + '\n';
	const after = before.replace('line 2\n', 'line two\n').replace('line 18\n', '');
	assert.deepEqual(inlineDiff(before, after), {
		status: 'ok', added: 1, removed: 2, truncated: false,
		lines: [
			{ kind: 'context', text: 'line 1', line: 1 },
			{ kind: 'add', text: 'line two', line: 2 },
			{ kind: 'del', text: 'line 2', line: 2 },
			{ kind: 'context', text: 'line 3', line: 3 },
			{ kind: 'context', text: 'line 4', line: 4 },
			{ kind: 'context', text: 'line 5', line: 5 },
			{ kind: 'gap', skipped: 9 },
			{ kind: 'context', text: 'line 15', line: 15 },
			{ kind: 'context', text: 'line 16', line: 16 },
			{ kind: 'context', text: 'line 17', line: 17 },
			{ kind: 'del', text: 'line 18', line: 18 },
			{ kind: 'context', text: 'line 19', line: 18 },
			{ kind: 'context', text: 'line 20', line: 19 }
		]
	});
	assert.deepEqual([inlineDiff('a\n', 'a\r\n'), inlineDiff('a\0', 'b'), inlineDiff('', 'x\n'.repeat(1600))].map(diff => diff.status), ['same', 'binary', 'too-large']);
});

test('the agent task list is read from Claude, Codex app-server and Codex exec shapes, redacted and bounded', () => {
	assert.deepEqual([
		parseAgentTodos({ todos: [{ content: 'Leer el formulario', status: 'completed', activeForm: 'Leyendo' }, { content: 'Validar email', status: 'in_progress' }, { content: '', status: 'pending' }] }),
		parseAgentTodos({ plan: [{ step: 'Correr tests', status: 'inProgress' }, { step: 'Revisar', status: 'pending' }] }),
		parseAgentTodos({ type: 'todo_list', items: [{ text: 'Hecho', completed: true }, { text: 'token sk-ant-api03-' + 'a'.repeat(40), completed: false }] }),
		parseAgentTodos({ other: [] })
	], [
		[{ text: 'Leer el formulario', status: 'completed' }, { text: 'Validar email', status: 'in_progress' }],
		[{ text: 'Correr tests', status: 'in_progress' }, { text: 'Revisar', status: 'pending' }],
		[{ text: 'Hecho', status: 'completed' }, { text: 'token [redacted]', status: 'pending' }],
		undefined
	]);
	assert.equal(parseAgentTodos({ todos: Array.from({ length: 50 }, (_, index) => ({ content: 'paso ' + index, status: 'pending' })) })!.length, 30);
});

test('structured streams publish the task list as a step carrying it, and Codex updates replace the list', () => {
	const steps: ChatStep[] = [];
	const claude = new RunStepExtractor('claude', '/repo', step => steps.push(step));
	claude.accept({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'TodoWrite', input: { todos: [{ content: 'Uno', status: 'in_progress' }] } }] } });
	const codex = new RunStepExtractor('codex', '/repo', step => steps.push(step));
	codex.accept({ type: 'item.started', item: { id: 'item_1', type: 'todo_list', items: [{ text: 'Dos', completed: false }] } });
	codex.accept({ type: 'item.updated', item: { id: 'item_1', type: 'todo_list', items: [{ text: 'Dos', completed: true }] } });
	assert.deepEqual(steps.map(step => step.todos), [[{ text: 'Uno', status: 'in_progress' }], [{ text: 'Dos', status: 'pending' }], [{ text: 'Dos', status: 'completed' }]]);
});
