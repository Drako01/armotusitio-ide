/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * EventBridge: the only path from an adapter to the chat. It gives every event its identity (id, session, sequence, time),
 * drops replays of the same native event, bounds what it keeps and what it forwards, redacts text, and isolates observers:
 * a throwing listener never stops the provider stream.
 */
import { randomBytes } from 'node:crypto';
import { redactSecrets } from '../native-redact.ts';
import type { AdapterEvent, AgentEvent, AgentEventPayload } from './contracts.ts';

/** Events kept for late subscribers and for the recovery cursor. */
export const MAX_RETAINED_EVENTS = 2000;
/** Native keys remembered for dedup; older keys are forgotten first. */
const MAX_DEDUP_KEYS = 4096;
/** Diagnostics are for support, not for the chat: a few per turn, short. */
const MAX_DIAGNOSTICS_PER_TURN = 20;
const MAX_DIAGNOSTIC_CHARS = 500;
/** Longest free-text field an event carries; adapters stop accumulating at the same bound so memory and event size agree. */
export const MAX_TEXT_CHARS = 64 * 1024;

export type EventListener = (event: AgentEvent) => void;

const TEXT_FIELDS = new Set(['text', 'output', 'chunk', 'detail', 'error']);

function clipText(value: string, max: number): string { return value.length > max ? value.slice(0, max) : value; }

/** Copy with every free-text field redacted and bounded; structured fields stay as they are. */
function sanitize(payload: AgentEventPayload): AgentEventPayload {
	const copy: Record<string, unknown> = { ...payload };
	for (const [key, value] of Object.entries(copy)) {
		if (TEXT_FIELDS.has(key) && typeof value === 'string') { copy[key] = redactSecrets(clipText(value, payload.type === 'diagnostic' ? MAX_DIAGNOSTIC_CHARS : MAX_TEXT_CHARS)); }
	}
	if (payload.type === 'tool.started' || payload.type === 'approval.requested') {
		const call = { ...payload.call };
		if (call.command) { call.command = redactSecrets(clipText(call.command, 2000)); }
		if (call.reason) { call.reason = redactSecrets(clipText(call.reason, 1000)); }
		copy.call = call;
	}
	return copy as AgentEventPayload;
}

export class EventBridge {
	private sequence = 0;
	private readonly retained: AgentEvent[] = [];
	private readonly seen = new Set<string>();
	private readonly listeners = new Set<EventListener>();
	private diagnostics = 0;
	private listenerFailures = 0;
	readonly sessionId: string;

	constructor(sessionId: string, firstSequence = 0) {
		this.sessionId = sessionId;
		this.sequence = firstSequence;
	}

	/** Sequence of the latest event, persisted as the recovery cursor. */
	get cursor(): number { return this.sequence; }

	get failures(): number { return this.listenerFailures; }

	subscribe(listener: EventListener, replayAfter?: number): () => void {
		if (replayAfter !== undefined) {
			for (const event of this.retained) { if (event.sequence > replayAfter) { this.deliver(listener, event); } }
		}
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Events after `cursor` still in memory (oldest first). */
	since(cursor: number): AgentEvent[] { return this.retained.filter(event => event.sequence > cursor); }

	/** Forward one adapter event; returns it, or `undefined` when it was a replay or a capped diagnostic. */
	publish(input: AdapterEvent): AgentEvent | undefined {
		if (input.nativeKey) {
			if (this.seen.has(input.nativeKey)) { return undefined; }
			this.seen.add(input.nativeKey);
			if (this.seen.size > MAX_DEDUP_KEYS) { this.seen.delete(this.seen.values().next().value!); }
		}
		if (input.payload.type === 'turn.started') { this.diagnostics = 0; }
		if (input.payload.type === 'diagnostic' && ++this.diagnostics > MAX_DIAGNOSTICS_PER_TURN) { return undefined; }
		const event: AgentEvent = {
			eventId: randomBytes(8).toString('hex'), sessionId: this.sessionId, sequence: ++this.sequence, timestamp: Date.now(),
			...(input.turnId ? { turnId: input.turnId } : {}), ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
			payload: sanitize(input.payload)
		};
		// Deltas are transient: they are delivered but not retained, so a long answer never fills the buffer.
		if (event.payload.type !== 'message.delta' && event.payload.type !== 'tool.output') {
			this.retained.push(event);
			if (this.retained.length > MAX_RETAINED_EVENTS) { this.retained.splice(0, this.retained.length - MAX_RETAINED_EVENTS); }
		}
		for (const listener of this.listeners) { this.deliver(listener, event); }
		return event;
	}

	private deliver(listener: EventListener, event: AgentEvent): void {
		try { listener(event); }
		catch { this.listenerFailures++; }
	}
}
