/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Role contracts of the goal team (block P): each agent returns one validated JSON block; prose never steers the orchestrator. */

export type GoalRole = 'analyst' | 'architect' | 'test-engineer' | 'implementer' | 'reviewer' | 'verifier';
export interface Criterion { id: string; given?: string; when?: string; then: string }
export interface Spec { size: 'question' | 'small' | 'goal'; criteria: Criterion[]; assumptions: string[]; risks: string[]; questions: string[]; impact: string[] }
export interface DesignTask { id: string; title: string; files: string[]; dependsOn: string[]; tests?: boolean }
export interface Design { tasks: DesignTask[]; decisions: string[] }
export interface Finding { severity: 'blocking' | 'suggestion'; text: string; file?: string }
export interface Review { findings: Finding[]; score: number }
export interface Verification { criteria: Array<{ id: string; test?: string; passed: boolean }> }

const strings = (value: unknown, max = 50): string[] | undefined =>
	Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length <= 2000) ? value as string[] : undefined;
const id = (value: unknown): value is string => typeof value === 'string' && /^[\w.-]{1,40}$/.test(value);

/** The last valid ```harness-<role>``` JSON block of an answer. */
function block(answer: string, name: string): Record<string, unknown> | undefined {
	let found: Record<string, unknown> | undefined;
	for (const match of answer.matchAll(new RegExp('```harness-' + name + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```', 'g'))) {
		try { const value = JSON.parse(match[1]); if (value && typeof value === 'object' && !Array.isArray(value)) { found = value; } } catch { /* Invalid blocks are ignored. */ }
	}
	return found;
}

export function parseSpec(answer: string): Spec | undefined {
	const value = block(answer, 'spec');
	if (!value || !['question', 'small', 'goal'].includes(value.size as string) || !Array.isArray(value.criteria)) { return undefined; }
	const criteria = value.criteria.filter((item): item is Criterion => !!item && id(item.id) && typeof item.then === 'string' && item.then.length <= 2000).slice(0, 30);
	const [assumptions, risks, questions, impact] = [value.assumptions ?? [], value.risks ?? [], value.questions ?? [], value.impact ?? []].map(item => strings(item));
	if (!assumptions || !risks || !questions || !impact) { return undefined; }
	return { size: value.size as Spec['size'], criteria, assumptions, risks, questions: questions.slice(0, 10), impact };
}

/** Tasks form a DAG whose dependencies exist; a file has one owning task, so parallel writers never collide. */
export function parseDesign(answer: string): Design | undefined {
	const value = block(answer, 'design');
	if (!value || !Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > 20) { return undefined; }
	const tasks: DesignTask[] = [];
	for (const item of value.tasks) {
		const files = strings(item?.files, 100), dependsOn = strings(item?.dependsOn ?? [], 20);
		if (!item || !id(item.id) || typeof item.title !== 'string' || !files || !dependsOn) { return undefined; }
		tasks.push({ id: item.id, title: item.title.slice(0, 300), files, dependsOn, ...(item.tests === true ? { tests: true } : {}) });
	}
	const ids = new Set(tasks.map(task => task.id));
	if (ids.size !== tasks.length || tasks.some(task => task.dependsOn.some(dependency => !ids.has(dependency)))) { return undefined; }
	const owners = new Map<string, string>();
	for (const task of tasks) { for (const file of task.files) { if (owners.has(file) && owners.get(file) !== task.id) { return undefined; } owners.set(file, task.id); } }
	return taskWaves(tasks) ? { tasks, decisions: strings(value.decisions ?? []) ?? [] } : undefined;
}

/** Tasks grouped in waves that can run together; undefined when the dependencies have a cycle. */
export function taskWaves(tasks: readonly DesignTask[]): DesignTask[][] | undefined {
	const done = new Set<string>();
	const waves: DesignTask[][] = [];
	while (done.size < tasks.length) {
		const wave = tasks.filter(task => !done.has(task.id) && task.dependsOn.every(dependency => done.has(dependency)));
		if (!wave.length) { return undefined; }
		wave.forEach(task => done.add(task.id));
		waves.push(wave);
	}
	return waves;
}

export function parseReview(answer: string): Review | undefined {
	const value = block(answer, 'review');
	if (!value || !Array.isArray(value.findings) || typeof value.score !== 'number' || value.score < 0 || value.score > 10) { return undefined; }
	const findings = value.findings.filter((item): item is Finding => !!item && ['blocking', 'suggestion'].includes(item.severity) && typeof item.text === 'string').slice(0, 50)
		.map(item => ({ severity: item.severity, text: item.text.slice(0, 2000), ...(typeof item.file === 'string' ? { file: item.file } : {}) }));
	return { findings, score: value.score };
}

export function parseVerification(answer: string): Verification | undefined {
	const value = block(answer, 'verification');
	if (!value || !Array.isArray(value.criteria)) { return undefined; }
	return { criteria: value.criteria.filter(item => item && id(item.id) && typeof item.passed === 'boolean').map(item => ({ id: item.id, passed: item.passed, ...(typeof item.test === 'string' ? { test: item.test } : {}) })) };
}

/** What each role must return, appended to its instruction. */
export function roleInstruction(role: GoalRole): string {
	const shapes: Record<GoalRole, string> = {
		analyst: 'Turn the request into a specification. Classify its size ("question", "small" or "goal"). Assume what is reasonable and list it as assumptions; ask only what changes the result and cannot be inferred, all at once. End with:\n```harness-spec\n{"size":"goal","criteria":[{"id":"C1","given":"...","when":"...","then":"..."}],"assumptions":[],"risks":[],"questions":[],"impact":["path/or/module"]}\n```',
		architect: 'Design the change following the project architecture, skills and guides. Split it into tasks with dependencies; each file belongs to exactly one task. End with:\n```harness-design\n{"tasks":[{"id":"T1","title":"...","files":["..."],"dependsOn":[],"tests":false}],"decisions":["decision and trade-off"]}\n```',
		'test-engineer': 'Write the acceptance tests from the specification criteria, not from the implementation. Name each test after its criterion id.',
		implementer: 'Implement only your task and its files. Do not touch files owned by other tasks.',
		reviewer: 'Review the change against the specification, the architecture, security, duplication and the project rules. Read only. Score the quality of new tests from 0 to 10. End with:\n```harness-review\n{"findings":[{"severity":"blocking","text":"...","file":"..."}],"score":8}\n```',
		verifier: 'Check every acceptance criterion against the tests that prove it and their results. Read only. End with:\n```harness-verification\n{"criteria":[{"id":"C1","test":"TestName","passed":true}]}\n```'
	};
	return shapes[role];
}
