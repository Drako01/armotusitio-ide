/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * ApprovalBroker: the temporary grants of one project's chat ("esta tarea", "esta sesi\u00f3n"), shared by every provider. A
 * grant is the exact rule the IDE derived from the request (operation + tool + arguments/path + project), so allowing
 * `docker ps` never allows `aws`, and a project never inherits another's grants. Task grants end with the task, session
 * grants with the IDE or after `SESSION_GRANT_TTL_MS`, whichever comes first; all are revocable and audited. Permanent
 * rules ("siempre") live in the user's permissions file, not here.
 */
import { redactSecrets } from '../native-redact.ts';
import type { ApprovalAnswer } from '../native-permissions-types.ts';

/** A session grant never outlives a working day, even with the IDE open. */
export const SESSION_GRANT_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_AUDIT = 200;

export type GrantScope = 'task' | 'session';
export interface Grant { rule: string; scope: GrantScope; grantedAt: number; expiresAt?: number }
export interface AuditEntry {
	at: number;
	event: 'granted' | 'reused' | 'asked' | 'answered' | 'denied' | 'revoked' | 'expired';
	rule: string;
	scope?: GrantScope | ApprovalAnswer;
	provider?: string;
}

export class ApprovalBroker {
	private readonly grants = new Map<string, Grant>();
	private readonly audits: AuditEntry[] = [];
	private readonly now: () => number;
	private readonly sink?: (entry: AuditEntry) => void;

	constructor(options: { now?: () => number; sink?: (entry: AuditEntry) => void } = {}) {
		this.now = options.now ?? Date.now;
		this.sink = options.sink;
	}

	/** True when `rule` is covered by a live grant; an expired one is dropped and audited. */
	covers(rule: string, provider?: string): boolean {
		if (!rule) { return false; }
		const grant = this.grants.get(rule);
		if (!grant) { return false; }
		if (grant.expiresAt !== undefined && grant.expiresAt <= this.now()) {
			this.grants.delete(rule);
			this.audit({ event: 'expired', rule, scope: grant.scope, provider });
			return false;
		}
		this.audit({ event: 'reused', rule, scope: grant.scope, provider });
		return true;
	}

	/** Record the user's answer; only task and session answers create a grant here. */
	record(rule: string, answer: ApprovalAnswer, provider?: string): void {
		this.audit({ event: answer === 'deny' ? 'denied' : 'answered', rule, scope: answer, provider });
		if (!rule || (answer !== 'task' && answer !== 'session')) { return; }
		// A narrower answer never shortens a broader live grant.
		if (this.grants.get(rule)?.scope === 'session' && answer === 'task') { return; }
		const grantedAt = this.now();
		this.grants.set(rule, { rule, scope: answer, grantedAt, ...(answer === 'session' ? { expiresAt: grantedAt + SESSION_GRANT_TTL_MS } : {}) });
		this.audit({ event: 'granted', rule, scope: answer, provider });
	}

	/** The task ended (completed, failed or cancelled): its grants go. */
	endTask(): void {
		for (const [rule, grant] of this.grants) { if (grant.scope === 'task') { this.grants.delete(rule); } }
	}

	/** Revoke one rule, or every grant when `rule` is omitted. Returns how many were removed. */
	revoke(rule?: string): number {
		const removed = rule === undefined ? [...this.grants.keys()] : this.grants.has(rule) ? [rule] : [];
		for (const item of removed) {
			const scope = this.grants.get(item)?.scope;
			this.grants.delete(item);
			this.audit({ event: 'revoked', rule: item, scope });
		}
		return removed.length;
	}

	/** Live grants, oldest first. */
	list(): Grant[] {
		return [...this.grants.values()].filter(grant => grant.expiresAt === undefined || grant.expiresAt > this.now()).sort((left, right) => left.grantedAt - right.grantedAt);
	}

	/** Most recent audit entries (bounded), redacted. */
	auditTrail(): AuditEntry[] { return [...this.audits]; }

	private audit(entry: Omit<AuditEntry, 'at'>): void {
		const item: AuditEntry = { at: this.now(), ...entry, rule: redactSecrets(entry.rule) };
		this.audits.push(item);
		if (this.audits.length > MAX_AUDIT) { this.audits.splice(0, this.audits.length - MAX_AUDIT); }
		try { this.sink?.(item); }
		catch { /* The audit sink has no authority over decisions. */ }
	}
}
