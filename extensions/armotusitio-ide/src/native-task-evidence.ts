/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Evidence of a chat run (JUN-002, JUN-003, JUN-009): what the IDE itself executed and observed, never what the model said.
 * Gate results become ledger entries; failed gates are classified so only deterministic, in-scope failures are repaired.
 */
import { createHash } from 'node:crypto';
import { classifyFailure } from './native-failure-class.ts';
import { redactSecrets } from './native-redact.ts';

export type GateKind = 'test' | 'lint' | 'typecheck' | 'build' | 'format' | 'smoke' | 'e2e' | 'other';
const GATE_KINDS: readonly GateKind[] = ['test', 'lint', 'typecheck', 'build', 'format', 'smoke', 'e2e'];

/** Kind of a gate from its id: detected gates are named `<kind>` or `<kind>-<subproject>`; anything else is `other`. */
export function gateKind(id: string): GateKind {
	const head = id.toLowerCase().split(/[-_:.]/)[0];
	return (GATE_KINDS as readonly string[]).includes(head) ? head as GateKind : 'other';
}

/** Why a verification gate failed. Provider failures are not gate failures: the run outcome reports them (`provider`). */
export type GateFailureClass = 'syntax-typecheck' | 'test-failure' | 'dependency-missing' | 'toolchain' | 'service-down' | 'permission-denied' | 'environment' | 'regression' | 'unknown';
/** Failures a focused correction inside the authorized scope can fix; everything else needs the user or the environment. */
export const REPAIRABLE: ReadonlySet<GateFailureClass> = new Set(['syntax-typecheck', 'test-failure', 'regression']);

/**
 * Environment causes are checked first: a test that fails because the database is down is not a code defect. The shared tool
 * classifier decides the causes it states unambiguously (policy refusals, a full disk, an outdated lockfile); its network,
 * timeout and missing-file rules are not reused because gate output also carries test assertions ("expected 200, received
 * 503", "ENOENT: fixture.json") that are code defects, not environment.
 */
const SHARED_CAUSES: Readonly<Record<string, GateFailureClass>> = { policy: 'permission-denied', 'disk-full': 'environment', 'lockfile-out-of-date': 'dependency-missing' };
const ENVIRONMENT_RULES: ReadonlyArray<[GateFailureClass, RegExp]> = [
	// An installed dependency the tool cannot read (a broken or locked install, an antivirus scan): reinstall, never edit code.
	['dependency-missing', /(?:\bUNKNOWN: unknown error|\bEBUSY\b|\bEPERM\b|\bENOTEMPTY\b)[^\n]*node_modules/i],
	['permission-denied', /\b(EACCES|EPERM)\b|permission denied|operation not permitted|HARNESS_[A-Z_]*DENIED/i],
	['service-down', /\bECONNREFUSED\b|connection refused|could not connect to (?:the )?server|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|database .* does not exist|no route to host/i],
	['environment', /heap out of memory|JavaScript heap|killed\s+signal\s+9|out of memory/i],
	['toolchain', /is not recognized as an internal or external command|command not found|\bspawn \S+ ENOENT\b|executable file not found in \$PATH|no se reconoce como un comando/i],
	['dependency-missing', /\bERR_MODULE_NOT_FOUND\b|Cannot find (?:module|package) '[^./][^']*'|\bMODULE_NOT_FOUND\b|ModuleNotFoundError|no required module provides package|missing go\.sum entry|could not resolve dependencies|npm ERR! missing/i]
];
const CODE_RULES: ReadonlyArray<[GateFailureClass, RegExp]> = [
	['syntax-typecheck', /error TS\d{4}|SyntaxError|syntax error|Unexpected token|\.go:\d+:\d+:|error\[E\d{4}\]|\d+ problems? \(\d+ errors?|cannot find name|is not assignable to/i],
	['test-failure', /\bFAIL\b|\bfailing\b|AssertionError|not ok \d+|--- FAIL|\d+ (?:tests? )?failed|Expected[:\s].*Received|expected .* (?:to|but)/i]
];

export interface GateFailure { id: string; exitCode: number | null; output: string }
/**
 * `Cannot find module` naming a path of the project (relative, or absolute such as `C:\app\test`) is a wrong path in the
 * code or a script, not a dependency to install; a path inside node_modules still is a broken install.
 */
function missingProjectFile(output: string): boolean {
	const target = /Cannot find module '([^']+)'/.exec(output)?.[1];
	return !!target && /^(?:\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(target) && !/node_modules/.test(target);
}

export interface ClassifiedFailure { id: string; kind: GateKind; failure: GateFailureClass; exitCode: number | null; tail: string }

/** Last lines of a gate's output, redacted and bounded: enough to correct, never the whole log. */
export function outputTail(output: string, limit = 3000): string {
	const clean = redactSecrets(output).replace(/\r\n/g, '\n').trimEnd();
	return clean.length <= limit ? clean : '\u2026' + clean.slice(-limit);
}

/** Classify one failed gate from its observed exit code and output. A gate killed without exit code is environmental. */
export function classifyGateFailure(gate: GateFailure, passedBefore = false): ClassifiedFailure {
	const kind = gateKind(gate.id);
	const tail = outputTail(gate.output);
	const environment = SHARED_CAUSES[classifyFailure(gate.output).kind] ?? ENVIRONMENT_RULES.find(([cause, pattern]) => pattern.test(gate.output) && !(cause === 'dependency-missing' && missingProjectFile(gate.output)))?.[0];
	let failure: GateFailureClass;
	if (environment) { failure = environment; }
	else if (gate.exitCode === null) { failure = 'environment'; }
	else {
		const code = CODE_RULES.find(([, pattern]) => pattern.test(gate.output))?.[0];
		// The gate's kind is deterministic evidence too: a failing typecheck or lint is a code error, a failing test a test failure.
		failure = code ?? (kind === 'typecheck' || kind === 'lint' || kind === 'format' ? 'syntax-typecheck' : kind === 'test' ? 'test-failure' : 'unknown');
		if (failure === 'test-failure' && passedBefore) { failure = 'regression'; }
	}
	return { id: gate.id, kind, failure, exitCode: gate.exitCode, tail };
}

/**
 * Stable fingerprint of a set of failures: same gates, same classes and the same output once numbers (durations, line
 * counts, timestamps) are removed. Two consecutive equal fingerprints mean the correction made no progress.
 */
export function failureSignature(failures: readonly ClassifiedFailure[]): string {
	const normalized = [...failures].sort((a, b) => a.id.localeCompare(b.id)).map(item => item.id + '|' + item.failure + '|' + item.tail.replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim());
	return createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 32);
}

/** One verification the IDE executed for a run (EvidenceLedger entry). Output stays in the engine log, never here. */
export interface EvidenceEntry {
	gate: string;
	kind: GateKind;
	command?: string;
	cwd?: string;
	status: 'passed' | 'failed' | 'cancelled' | 'skipped' | 'not-run';
	exitCode?: number | null;
	startedAt?: string;
	finishedAt?: string;
	/** `ide-gate`: run by the IDE's verification engine; `cache`: an earlier identical result reused by the engine. */
	source: 'ide-gate' | 'cache';
	/** Verification plan revision the gate belonged to (the inputs it certified). */
	scope?: string;
	failure?: GateFailureClass;
	/** Why it did not run, for skipped and not-run entries. */
	reason?: string;
}
const ENTRY_STATUS: ReadonlyArray<EvidenceEntry['status']> = ['passed', 'failed', 'cancelled', 'skipped', 'not-run'];
const MAX_EVIDENCE = 64;

export function validEvidence(value: unknown): boolean {
	if (value === undefined) { return true; }
	if (!Array.isArray(value) || value.length > MAX_EVIDENCE) { return false; }
	return value.every((entry: EvidenceEntry) => !!entry && typeof entry === 'object' && typeof entry.gate === 'string' && entry.gate.length <= 128 &&
		(GATE_KINDS as readonly string[]).concat('other').includes(entry.kind) && ENTRY_STATUS.includes(entry.status) && ['ide-gate', 'cache'].includes(entry.source) &&
		(entry.command === undefined || (typeof entry.command === 'string' && entry.command.length <= 2000)) &&
		(entry.exitCode === undefined || entry.exitCode === null || Number.isSafeInteger(entry.exitCode)) &&
		(entry.reason === undefined || (typeof entry.reason === 'string' && entry.reason.length <= 500)));
}
