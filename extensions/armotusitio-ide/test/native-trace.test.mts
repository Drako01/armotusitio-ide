/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTrace, taskTrace, traceparent, workflowTrace } from '../src/native-trace.ts';
import type { WorkflowRecord } from '../src/native-agent-workflow.ts';
import type { Task } from '../src/native-harness.ts';

const workflow: WorkflowRecord = {
	schemaVersion: 1, id: 'wf-1', createdAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:10.000Z',
	projectKey: 'a'.repeat(64), planDigest: 'b'.repeat(64), status: 'failed', verification: 'failed',
	steps: [
		{ id: 'plan', role: 'planner', provider: 'codex', status: 'passed', startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:04.000Z', durationMs: 4000, exitCode: 0 },
		{ id: 'implement', role: 'implementer', provider: 'claude', status: 'failed', startedAt: '2026-10-30T10:00:04.000Z', endedAt: '2026-10-30T10:00:09.000Z', durationMs: 5000, exitCode: 1 }
	],
	events: [
		{ workflowId: 'wf-1', kind: 'provider-progress', at: '2026-10-30T10:00:01.000Z', stepId: 'plan', observedBytes: 100 },
		{ workflowId: 'wf-1', kind: 'provider-progress', at: '2026-10-30T10:00:02.000Z', stepId: 'plan', observedBytes: 900 },
		{ workflowId: 'wf-1', kind: 'verification-finished', at: '2026-10-30T10:00:10.000Z' }
	]
};

test('workflow trace links agent and verification spans to a deterministic root', () => {
	const spans = workflowTrace(workflow);
	assert.deepEqual(workflowTrace(workflow), spans);
	assert.deepEqual(spans.map(span => ({ name: span.name, kind: span.kind, status: span.status, parent: span.parentSpanId === spans[0].spanId, durationMs: span.durationMs })), [
		{ name: 'workflow', kind: 'workflow', status: 'error', parent: false, durationMs: 10000 },
		{ name: 'planner (codex)', kind: 'agent', status: 'ok', parent: true, durationMs: 4000 },
		{ name: 'implementer (claude)', kind: 'agent', status: 'error', parent: true, durationMs: 5000 },
		{ name: 'verification', kind: 'verification', status: 'error', parent: true, durationMs: undefined }
	]);
	assert.equal(spans[1].attributes['harness.provider.observedBytes'], 900);
	assert.match(traceparent(spans[0]), /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
	assert.equal(new Set(spans.map(span => span.spanId)).size, spans.length);
	assert.deepEqual(describeTrace(spans).slice(0, 2), ['workflow \u00b7 error \u00b7 10.0s', '  planner (codex) \u00b7 ok \u00b7 4.0s']);
});

test('task trace emits one trace per attempt with gate spans and no output content', () => {
	const task: Task = {
		schemaVersion: 1, id: 'task-1', title: 'secret title', createdAt: '2026-10-30T10:00:00.000Z', revision: 'r',
		plan: { schemaVersion: 1, gates: [{ id: 'lint', executable: 'npm', args: ['run', 'lint'], parallelSafe: true }] },
		attempts: ['a1', 'a2'].map(id => ({
			id, startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:02.000Z', status: 'passed' as const,
			revision: 'r', approval: 'x', results: [{ id: 'lint', exitCode: 0, status: 'passed' as const, output: 'TOKEN=abc', startedAt: '2026-10-30T10:00:00.000Z', endedAt: '2026-10-30T10:00:01.500Z' }]
		}))
	};
	const spans = taskTrace(task);
	assert.deepEqual({ traces: new Set(spans.map(span => span.traceId)).size, kinds: spans.map(span => span.kind), gate: spans[1].attributes },
		{ traces: 2, kinds: ['task', 'gate', 'task', 'gate'], gate: { 'harness.gate.id': 'lint', 'harness.gate.parallelSafe': true, 'harness.gate.sandbox': 'none', 'process.exit.code': 0 } });
	assert.equal(JSON.stringify(spans).includes('TOKEN') || JSON.stringify(spans).includes('secret'), false);
});
