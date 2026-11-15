/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Task intent router of the chat (JUN-001). Stable rules over the request text only: no model call is spent to classify,
 * the router never grants a permission and never widens what the user asked. It only decides which existing path runs it.
 */

export type TaskRoute = 'question' | 'simple-edit' | 'compound-goal' | 'ambiguous-or-risky';
export interface TaskRouting {
	route: TaskRoute;
	/** Rule names that decided the route, shown to the user as the visible assumption. */
	reasons: string[];
}

/** Operations whose wrong guess is expensive or irreversible: they get a reviewed plan instead of a direct writer. */
const RISKY: ReadonlyArray<[string, RegExp]> = [
	['production', /\b(producci[o\u00f3]n|production|prod)\b/i],
	// Verb stems use \S* because accented endings (deploy-a, borr-a with an accent) are not \w characters.
	['deploy', /\b(deploy\S*|despleg\S*|despliegue|publish\b|public\S*\s+(?:en|a)\s+(?:npm|el\s+store|la\s+tienda))/i],
	['delete-data', /\b(drop\s+(?:table|database|schema)|truncate\b|borr\S*\s+(?:(?:toda\s+)?la\s+|(?:todos\s+)?los\s+|las\s+)?(?:base\s+de\s+datos|datos|registros|tablas?|usuarios)|delete\s+(?:all|the\s+database|every))/i],
	['history-rewrite', /(force[- ]push|push\s+--force|reset\s+--hard|reescrib\S*\s+(?:el\s+)?historial)/i],
	['secrets', /\b(rot\S*\s+(?:las?\s+)?(?:claves?|credenciales|secrets?|tokens?)|credenciales\s+de\s+producci[o\u00f3]n)/i],
	['data-migration', /\b(migr\S*\s+(?:los\s+)?datos|data\s+migration|backfill\b)/i]
];

/** Questions and read-only requests: Ask semantics even when the composer is in Act. */
const QUESTION_START = /^(?:\u00bf|qu[e\u00e9]\b|c[o\u00f3]mo\b|por\s*qu[e\u00e9]\b|cu[a\u00e1]l(?:es)?\b|cu[a\u00e1]ndo\b|d[o\u00f3]nde\b|qui[e\u00e9]n\b|explic|describ|resum|analiz|what\b|why\b|how\b|which\b|where\b|when\b|who\b|explain\b|describe\b|summarize\b|is\s+there\b|does\b|do\s+we\b)/i;
const WRITE_VERB = /(?:cre[a\u00e1]|agreg|a\u00f1ad|implement|hac|arm[a\u00e1]|constru|correg|arregl|cambi|modific|renombr|refactoriz|elimin|quit|sac[a\u00e1]|actualiz|instal|configur|migr|escrib|gener|mov[e\u00e9]|dej[a\u00e1]|pon[e\u00e9]|add\b|create\b|build\b|implement\b|fix\b|change\b|rename\b|refactor\b|remove\b|delete\b|update\b|install\b|configure\b|write\b|generate\b|make\b|move\b|set\s+up\b)/i;
/** "Can you ..." asks for work, not for an explanation. */
const REQUEST_START = /^(?:\u00bf\s*)?(?:pod[e\u00e9]s|podr[i\u00ed]as|puedes|quiero\s+que|necesito\s+que|could\s+you|can\s+you|would\s+you|please)\b/i;
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

/** A request this short and with one target is a single focused edit. */
const SHORT_REQUEST_CHARS = 160;
/** Compound signals needed before the multi-stage engine is worth its planning, review and budget. */
const COMPOUND_THRESHOLD = 2;
/** Two layers of a stack or an explicit list of three deliverables are compound on their own. */
const STRONG: ReadonlySet<string> = new Set(['full-stack', 'multi-step']);

const matched = (rules: ReadonlyArray<[string, RegExp]>, text: string): string[] => rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

/**
 * Route one chat request. `mode` is the composer mode: in Ask nothing is ever routed to a writer.
 * Risk wins over size: a request that touches production or deletes data always gets a reviewed plan first.
 */
export function routeTask(text: string, mode: 'ask' | 'act'): TaskRouting {
	const body = text.trim();
	if (mode === 'ask') { return { route: 'question', reasons: ['ask-mode'] }; }
	const risky = matched(RISKY, body);
	if (risky.length) { return { route: 'ambiguous-or-risky', reasons: risky }; }
	const asksForWork = REQUEST_START.test(body) || IMPERATIVE_START.test(body);
	if (!asksForWork && (QUESTION_START.test(body) || /\?\s*$/.test(body))) { return { route: 'question', reasons: ['question'] }; }
	const compound = matched(COMPOUND, body);
	// One signal is not enough on a normal line: "agrega login al header" stays a simple edit.
	if (compound.length >= COMPOUND_THRESHOLD || compound.some(name => STRONG.has(name)) || (compound.length >= 1 && body.length > SHORT_REQUEST_CHARS * 3)) { return { route: 'compound-goal', reasons: compound }; }
	return { route: 'simple-edit', reasons: [body.length <= SHORT_REQUEST_CHARS ? 'short-request' : 'single-target'] };
}
