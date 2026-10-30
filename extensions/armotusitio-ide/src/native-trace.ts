/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Structured traces derived from already-persisted workflow and task records.
 * IDs are deterministic digests, so traces need no extra state and correlate
 * across reloads. Spans never carry prompts, output, paths or credentials.
 */
import { createHash } from 'node:crypto';
import type { Task } from './native-harness.ts';
import type { WorkflowRecord } from './native-agent-workflow.ts';

export type SpanStatus = 'ok' | 'error' | 'cancelled' | 'running' | 'interrupted' | 'pending';
/** OTLP-compatible span shape: 32-hex trace ID and 16-hex span IDs. */
export interface TraceSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: 'workflow' | 'agent' | 'verification' | 'task' | 'gate';
	status: SpanStatus;
	startTime?: string;
	endTime?: string;
	durationMs?: number;
	attributes: Record<string, string | number | boolean>;
}

const hex = (value: string, length: number): string => createHash('sha256').update(value).digest('hex').slice(0, length);
const SPAN_STATUS: Record<string, SpanStatus> = {
	passed: 'ok', failed: 'error', timeout: 'error', cancelled: 'cancelled',
	running: 'running', interrupted: 'interrupted', pending: 'pending'
};
/** Unknown states map to `error` so a trace never reports an unrecognized outcome as healthy. */
const status = (value: string): SpanStatus => SPAN_STATUS[value] ?? 'error';
const elapsed = (start?: string, end?: string): number | undefined => {
	const value = start && end ? Date.parse(end) - Date.parse(start) : Number.NaN;
	return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/** One trace per workflow: root span, one span per agent step, and verification. */
export function workflowTrace(record: WorkflowRecord): TraceSpan[] {
	const traceId = hex('workflow:' + record.id, 32);
	const root: TraceSpan = {
		traceId, spanId: hex(traceId + ':root', 16), name: 'workflow', kind: 'workflow', status: status(record.status),
		startTime: record.createdAt, endTime: record.endedAt, durationMs: elapsed(record.createdAt, record.endedAt),
		attributes: { 'harness.workflow.id': record.id, 'harness.project.key': record.projectKey.slice(0, 16), 'harness.steps': record.steps.length }
	};
	const spans = [root];
	for (const step of record.steps) {
		const bytes = (record.events || []).filter(event => event.stepId === step.id && event.kind === 'provider-progress')
			.reduce((max, event) => Math.max(max, event.observedBytes ?? 0), 0);
		spans.push({
			traceId, spanId: hex(traceId + ':step:' + step.id, 16), parentSpanId: root.spanId,
			name: step.role + ' (' + step.provider + ')', kind: 'agent', status: status(step.status),
			startTime: step.startedAt, endTime: step.endedAt, durationMs: step.durationMs ?? elapsed(step.startedAt, step.endedAt),
			attributes: {
				'harness.step.id': step.id, 'harness.agent.role': step.role, 'harness.agent.provider': step.provider,
				'harness.provider.observedBytes': bytes,
				...(typeof step.exitCode === 'number' ? { 'process.exit.code': step.exitCode } : {})
			}
		});
	}
	if (record.verification) {
		const finished = (record.events || []).find(event => event.kind === 'verification-finished');
		spans.push({
			traceId, spanId: hex(traceId + ':verification', 16), parentSpanId: root.spanId, name: 'verification', kind: 'verification',
			status: record.verification === 'passed' ? 'ok' : record.verification === 'failed' ? 'error' : 'pending',
			endTime: finished?.at, attributes: { 'harness.verification': record.verification }
		});
	}
	return spans;
}

/** One trace per task attempt: task span and one span per gate result. */
export function taskTrace(task: Task): TraceSpan[] {
	return task.attempts.flatMap(attempt => {
		const traceId = hex('task:' + task.id + ':' + attempt.id, 32);
		const root: TraceSpan = {
			traceId, spanId: hex(traceId + ':root', 16), name: 'task', kind: 'task', status: status(attempt.status),
			startTime: attempt.startedAt, endTime: attempt.endedAt, durationMs: elapsed(attempt.startedAt, attempt.endedAt),
			attributes: { 'harness.task.id': task.id, 'harness.attempt.id': attempt.id, 'harness.gates': task.plan.gates.length }
		};
		return [root, ...attempt.results.map((result): TraceSpan => {
			const gate = task.plan.gates.find(item => item.id === result.id);
			return {
				traceId, spanId: hex(traceId + ':gate:' + result.id, 16), parentSpanId: root.spanId, name: 'gate ' + result.id, kind: 'gate',
				status: status(result.status), startTime: result.startedAt, endTime: result.endedAt, durationMs: elapsed(result.startedAt, result.endedAt),
				attributes: {
					'harness.gate.id': result.id, 'harness.gate.parallelSafe': gate?.parallelSafe === true,
					'harness.gate.sandbox': gate?.sandbox ?? 'none',
					...(typeof result.exitCode === 'number' ? { 'process.exit.code': result.exitCode } : {})
				}
			};
		})];
	});
}

/** W3C Trace Context header for correlating a span with external tooling. */
export function traceparent(span: TraceSpan): string {
	return '00-' + span.traceId + '-' + span.spanId + '-01';
}

/** Human-readable progress lines: one per span, indented under its parent. */
export function describeTrace(spans: readonly TraceSpan[]): string[] {
	return spans.map(span => (span.parentSpanId ? '  ' : '') + span.name + ' \u00b7 ' + span.status +
		(span.durationMs === undefined ? '' : ' \u00b7 ' + (span.durationMs / 1000).toFixed(1) + 's'));
}
