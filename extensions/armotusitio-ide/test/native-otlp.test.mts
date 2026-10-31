/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportOtlp, otlpPayload, validateOtlpEndpoint } from '../src/native-otlp.ts';
import type { TraceSpan } from '../src/native-trace.ts';

const spans: TraceSpan[] = [
	{
		traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'workflow', kind: 'workflow', status: 'ok', startTime: '2026-10-31T10:00:00.000Z', endTime: '2026-10-31T10:00:02.500Z', durationMs: 2500,
		attributes: { 'harness.workflow.id': 'wf-1', 'harness.steps': 3, 'harness.gate.parallelSafe': true, 'process.exit.code': 0, prompt: 'Implementa X con la clave sk-abcdefghijklmnopqrstuvwxyz123456', 'harness.note': 'token=abc123secretvalue' }
	},
	{ traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), parentSpanId: 'b'.repeat(16), name: 'implementer (codex)', kind: 'agent', status: 'interrupted', attributes: { 'harness.agent.role': 'implementer' } }
];

test('the payload is OTLP JSON with correlated IDs, honest statuses and only allowlisted, redacted attributes', () => {
	const payload = JSON.stringify(otlpPayload(spans, '0.6.0'));
	const root = otlpPayload(spans, '0.6.0') as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ spanId: string; parentSpanId?: string; startTimeUnixNano: string; endTimeUnixNano: string; status: { code: number }; attributes: Array<{ key: string }> }> }> }> };
	const [workflow, agent] = root.resourceSpans[0].scopeSpans[0].spans;
	assert.deepEqual({
		start: workflow.startTimeUnixNano, end: workflow.endTimeUnixNano, ok: workflow.status.code, interrupted: agent.status.code, parent: agent.parentSpanId === workflow.spanId,
		keys: workflow.attributes.map(item => item.key),
		leaked: /sk-abcdef|Implementa X|abc123secretvalue/.test(payload)
	}, {
		start: '1793440800000000000', end: '1793440802500000000', ok: 1, interrupted: 2, parent: true,
		keys: ['harness.workflow.id', 'harness.steps', 'harness.gate.parallelSafe', 'process.exit.code', 'harness.note', 'harness.span.status'],
		leaked: false
	});
});

test('only https or loopback http endpoints without credentials are accepted', () => {
	for (const bad of ['http://collector.example.com/v1/traces', 'ftp://127.0.0.1/', 'file:///etc/passwd', 'https://user:pass@collector.example.com/', 'https://collector.example.com/#x', 'not a url', '', undefined]) {
		assert.throws(() => validateOtlpEndpoint(bad), /HARNESS_OTLP_ENDPOINT_INVALID/, String(bad));
	}
	assert.deepEqual(['https://collector.example.com:4318/v1/traces', 'http://127.0.0.1:4318/v1/traces', 'http://localhost:4318/'].map(value => validateOtlpEndpoint(value).host), ['collector.example.com:4318', '127.0.0.1:4318', 'localhost:4318']);
});

test('export posts the payload to a real local collector, never follows redirects and reports stable errors', async () => {
	const received: Array<{ method?: string; type?: string; body: string }> = [];
	const server = http.createServer((request, response) => {
		let body = '';
		request.on('data', chunk => { body += chunk; });
		request.on('end', () => {
			received.push({ method: request.method, type: request.headers['content-type'], body });
			if (request.url === '/redirect') { response.writeHead(302, { location: 'http://127.0.0.1:1/steal' }).end(); }
			else if (request.url === '/reject') { response.writeHead(500).end(); }
			else { response.writeHead(200).end('{}'); }
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
	try {
		const ok = await exportOtlp(spans, base + '/v1/traces', '0.6.0');
		await assert.rejects(exportOtlp(spans, base + '/redirect', '0.6.0'), /HARNESS_OTLP_UNREACHABLE/);
		await assert.rejects(exportOtlp(spans, base + '/reject', '0.6.0'), /HARNESS_OTLP_REJECTED/);
		await assert.rejects(exportOtlp(spans, 'http://127.0.0.1:1/v1/traces', '0.6.0'), /HARNESS_OTLP_UNREACHABLE/);
		await assert.rejects(exportOtlp(spans, 'http://collector.example.com/', '0.6.0'), /HARNESS_OTLP_ENDPOINT_INVALID/);
		assert.deepEqual({ ok, first: [received[0].method, received[0].type], resources: JSON.parse(received[0].body).resourceSpans.length, secret: received[0].body.includes('sk-abcdef') },
			{ ok: { status: 200, spans: 2 }, first: ['POST', 'application/json'], resources: 1, secret: false });
		// The redirect target was never contacted: only the three requests that reached the collector are recorded.
		assert.equal(received.length, 3);
	} finally { await new Promise(resolve => server.close(resolve)); }
});
