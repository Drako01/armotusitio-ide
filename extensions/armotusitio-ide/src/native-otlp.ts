/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Optional OTLP/HTTP JSON export of the traces the IDE already derives locally. Nothing is sent unless the
 * user configured an endpoint and confirmed the export; the payload carries span structure and counters only
 * (the attributes the trace module emits, filtered again here), never prompts, model output, paths or credentials.
 * The endpoint is https, or http to this machine only, without embedded credentials and without redirects.
 */
import { redactSecrets } from './native-redact.ts';
import type { SpanStatus, TraceSpan } from './native-trace.ts';

const MAX_SPANS = 500;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const EXPORT_TIMEOUT_MS = 10_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** OTLP status codes: 0 unset, 1 ok, 2 error. Anything that is not clearly healthy is not reported as ok. */
const STATUS_CODE: Record<SpanStatus, number> = { ok: 1, error: 2, cancelled: 0, running: 0, interrupted: 2, pending: 0 };
const ALLOWED_ATTRIBUTE = /^(harness\.[a-z0-9_.]+|process\.exit\.code)$/i;

/** The traces endpoint, or an error: validated before any data is prepared. */
export function validateOtlpEndpoint(value: unknown): URL {
	let url: URL;
	try { url = new URL(String(value)); } catch { throw Error('HARNESS_OTLP_ENDPOINT_INVALID'); }
	const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
	if (!secure || url.username || url.password || url.hash) { throw Error('HARNESS_OTLP_ENDPOINT_INVALID'); }
	return url;
}

const attribute = (key: string, value: string | number | boolean): { key: string; value: Record<string, string | number | boolean> } => ({
	key, value: typeof value === 'string' ? { stringValue: redactSecrets(value).slice(0, 256) } : typeof value === 'boolean' ? { boolValue: value } : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
});
const nanos = (iso?: string): string => (Number.isFinite(Date.parse(iso ?? '')) ? String(BigInt(Date.parse(iso as string)) * 1_000_000n) : '0');

/** OTLP/JSON `ExportTraceServiceRequest` for the spans, with only allowlisted attributes. */
export function otlpPayload(spans: readonly TraceSpan[], serviceVersion: string): object {
	if (spans.length > MAX_SPANS) { throw Error('HARNESS_OTLP_TOO_MANY_SPANS'); }
	return {
		resourceSpans: [{
			resource: { attributes: [attribute('service.name', 'armotusitio-ide-harness'), attribute('service.version', serviceVersion)] },
			scopeSpans: [{
				scope: { name: 'armotusitio.harness' },
				spans: spans.map(span => ({
					traceId: span.traceId, spanId: span.spanId, ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
					name: span.name, kind: 1, startTimeUnixNano: nanos(span.startTime), endTimeUnixNano: nanos(span.endTime),
					attributes: [
						...Object.entries(span.attributes).filter(([key]) => ALLOWED_ATTRIBUTE.test(key)).map(([key, value]) => attribute(key, value)),
						attribute('harness.span.status', span.status)
					],
					status: { code: STATUS_CODE[span.status] }
				}))
			}]
		}]
	};
}

/** POST the spans to the traces endpoint. Resolves with the HTTP status; any failure throws a stable code. */
export async function exportOtlp(
	spans: readonly TraceSpan[], endpoint: unknown, serviceVersion: string, send: typeof fetch = fetch
): Promise<{ status: number; spans: number }> {
	const url = validateOtlpEndpoint(endpoint);
	const body = JSON.stringify(otlpPayload(spans, serviceVersion));
	if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) { throw Error('HARNESS_OTLP_PAYLOAD_TOO_LARGE'); }
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
	try {
		const response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: controller.signal });
		if (!response.ok) { throw Error('HARNESS_OTLP_REJECTED'); }
		return { status: response.status, spans: spans.length };
	} catch (error) {
		throw Error(error instanceof Error && error.message === 'HARNESS_OTLP_REJECTED' ? error.message : 'HARNESS_OTLP_UNREACHABLE');
	} finally { clearTimeout(timer); }
}
