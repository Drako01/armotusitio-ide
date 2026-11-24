/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Task intent router of the chat (JUN-001). Stable rules over the request text only: no model call is spent to classify,
 * the router never grants a permission and never widens what the user asked. It only decides which existing path runs it.
 */

export type TaskRoute = 'question' | 'simple-edit' | 'compound-goal';
export interface TaskRouting {
	route: TaskRoute;
	/** Rule names that decided the route, shown to the user as the visible assumption. */
	reasons: string[];
}

/** A one-line question gets a read-only answer even in Act; imperatives such as "analiza" or "explica" are work, not questions. */
const QUESTION_START = /^(?:\u00bf|qu[e\u00e9]\b|c[o\u00f3]mo\b|por\s*qu[e\u00e9]\b|cu[a\u00e1]l(?:es)?\b|cu[a\u00e1]ndo\b|d[o\u00f3]nde\b|qui[e\u00e9]n\b|what\b|why\b|how\b|which\b|where\b|when\b|who\b|is\s+there\b|does\b|do\s+we\b)/i;
const WRITE_VERB = /(?:cre[a\u00e1]|agreg|a\u00f1ad|implement|hac|arm[a\u00e1]|constru|correg|arregl|cambi|modific|renombr|refactoriz|elimin|quit|sac[a\u00e1]|actualiz|instal|configur|migr|escrib|gener|mov[e\u00e9]|dej[a\u00e1]|pon[e\u00e9]|add\b|create\b|build\b|implement\b|fix\b|change\b|rename\b|refactor\b|remove\b|delete\b|update\b|install\b|configure\b|write\b|generate\b|make\b|move\b|set\s+up\b)/i;
/** "Can you ..." asks for work, also when it opens a later sentence or follows a pasted link ("https://... Necesito que ..."). */
const REQUEST_START = /(?:^|[.!?]\s+|\S+:\/\/\S+\s+)(?:\u00bf\s*)?(?:pod[e\u00e9]s|podr[i\u00ed]as|puedes|quiero\s+que|necesito\s+que|could\s+you|can\s+you|would\s+you|please)\b/i;
/** An imperative first word ("agrega" with an accent, "fix") is work even when the line ends with a question mark. */
const IMPERATIVE_START = new RegExp('^(?:por\\s+favor\\s+|please\\s+)?' + WRITE_VERB.source, 'i');

/** Signals of a multi-stage deliverable: an app or system from scratch, several layers, or a list of deliverables. */
const COMPOUND: ReadonlyArray<[string, RegExp]> = [
	['new-application', /\b(aplicaci[o\u00f3]n|app|sistema|plataforma|sitio|web\s*app|application|system|platform|website|mvp|saas)\b.{0,80}\b(complet\w*|nuev\w*|desde\s+cero|from\s+scratch|para\s+gestionar|to\s+manage)|\b(desde\s+cero|from\s+scratch)\b/i],
	['crud', /\bcrud\b/i],
	['auth', /\b(login|autenticaci[o\u00f3]n|authentication|registro\s+de\s+usuarios|sign[- ]?up|roles?\s+y\s+permisos|rbac)\b/i],
	['database', /\b(base\s+de\s+datos|database|postgres\w*|mysql|mongo\w*|sqlite|migraciones|migrations|esquema\s+de\s+datos)\b/i],
	['dashboard', /\b(dashboard|panel\s+de\s+(?:control|administraci[o\u00f3]n)|admin\s+panel|backoffice)\b/i],
	['full-stack', /\b(backend|api|servidor|server)\b.{0,80}\b(frontend|front|ui|interfaz|next(?:\.js)?|react|vue|angular)\b|\b(frontend|front|ui|interfaz|next(?:\.js)?|react|vue|angular)\b.{0,80}\b(backend|api|servidor|server|go|golang)\b/i],
	['tests-and-delivery', /\b(con\s+(?:sus\s+)?(?:tests?|pruebas)|with\s+tests|todo\s+funcionando|end[- ]to[- ]end|e2e)\b/i],
	['multi-step', /(?:^|\n)\s*(?:\d+[.)]|[-*])\s+\S.*(?:\n\s*(?:\d+[.)]|[-*])\s+\S.*){2,}/]
];

/**
 * A pasted failure report (a CI job, a test run, a stack trace) asks to fix what failed: its bullets and words such as
 * "database" or "tests" describe the failure, not deliverables, so it runs on the direct writer.
 */
const FAILURE_REPORT = /\b(?:job\s+\d+|ci|pipeline|workflow|checks?|tests?|suite|build|lint|prettier|tsc|migrati\w*)\b[^\n]{0,80}\b(?:failed|failing|fall[o\u00f3]|fallaron|fallan?)\b|\b(?:failed|fall[o\u00f3]|fallaron)\s+(?:because|porque)\b|^\s*(?:traceback\b|panic:|error:|FAIL\b)/im;
/** A report still names a new deliverable when it asks for an application or a CRUD from scratch. */
const NEW_DELIVERABLE: ReadonlySet<string> = new Set(['new-application', 'crud']);

/** A request this short and with one target is a single focused edit. */
const SHORT_REQUEST_CHARS = 160;
/** Compound signals needed before the multi-stage engine is worth its planning, review and budget. */
const COMPOUND_THRESHOLD = 2;
/** Two layers of a stack or an explicit list of three deliverables are compound on their own. */
const STRONG: ReadonlySet<string> = new Set(['full-stack', 'multi-step']);

const matched = (rules: ReadonlyArray<[string, RegExp]>, text: string): string[] => rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

/**
 * Route one chat request. `mode` is the composer mode: in Ask nothing is ever routed to a writer.
 * In Act every instruction runs: the route only picks the path. Risky operations are not gated here by words; the
 * permission broker and the command policy refuse or ask when the action itself is attempted.
 */
export function routeTask(text: string, mode: 'ask' | 'act'): TaskRouting {
	const body = text.trim();
	if (mode === 'ask') { return { route: 'question', reasons: ['ask-mode'] }; }
	const asksForWork = REQUEST_START.test(body) || IMPERATIVE_START.test(body);
	if (!asksForWork && !body.includes('\n') && (QUESTION_START.test(body) || /\?\s*$/.test(body))) { return { route: 'question', reasons: ['question'] }; }
	const compound = matched(COMPOUND, body);
	if (FAILURE_REPORT.test(body) && !compound.some(name => NEW_DELIVERABLE.has(name))) { return { route: 'simple-edit', reasons: ['failure-report'] }; }
	// One signal is not enough on a normal line: "agrega login al header" stays a simple edit.
	if (compound.length >= COMPOUND_THRESHOLD || compound.some(name => STRONG.has(name)) || (compound.length >= 1 && body.length > SHORT_REQUEST_CHARS * 3)) { return { route: 'compound-goal', reasons: compound }; }
	return { route: 'simple-edit', reasons: [body.length <= SHORT_REQUEST_CHARS ? 'short-request' : 'single-target'] };
}
