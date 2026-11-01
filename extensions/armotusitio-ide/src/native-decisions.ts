/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Project decision memory (block AA): ADR-style entries fed by answers, approved charters, accepted design decisions and
 * review resolutions. Private to the IDE by default; exporting to the repository is an explicit action (D8).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { globPattern } from './native-goal.ts';

export interface Decision {
	id: string;
	title: string;
	context: string;
	decision: string;
	alternatives: string[];
	/** Project-relative globs the decision applies to; empty means the whole project. */
	scope: string[];
	source: 'answer' | 'charter' | 'design' | 'review' | 'user';
	status: 'active' | 'superseded' | 'archived';
	supersededBy?: string;
	at: string;
}

const MAX_DECISIONS = 500;
/** Decisions given to an agent, within the prompt budget (E2). */
const PROMPT_DECISIONS = 15;

export class DecisionLog {
	private readonly file: string;
	constructor(directory: string) { this.file = path.join(directory, 'decisions.json'); }

	async list(): Promise<Decision[]> {
		const raw = await fs.readFile(this.file, 'utf8').catch(() => undefined);
		if (!raw) { return []; }
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) ? value.filter((item): item is Decision => !!item && typeof item.id === 'string' && typeof item.decision === 'string') : [];
	}

	private async save(decisions: Decision[]): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const temporary = this.file + '.' + randomUUID() + '.tmp';
		await fs.writeFile(temporary, JSON.stringify(decisions.slice(-MAX_DECISIONS), null, 2), { mode: 0o600 });
		await fs.rename(temporary, this.file);
	}

	/** Record a decision; one with the same title replaces (supersedes) the earlier active one. */
	async record(entry: Omit<Decision, 'id' | 'status' | 'at'> & { at?: string }): Promise<Decision> {
		const decisions = await this.list();
		const decision: Decision = { ...entry, id: randomUUID(), status: 'active', at: entry.at ?? new Date().toISOString() };
		for (const previous of decisions) {
			if (previous.status === 'active' && previous.title.toLowerCase() === decision.title.toLowerCase()) { previous.status = 'superseded'; previous.supersededBy = decision.id; }
		}
		await this.save([...decisions, decision]);
		return decision;
	}

	async archive(id: string): Promise<void> {
		const decisions = await this.list();
		const target = decisions.find(item => item.id === id);
		if (target) { target.status = 'archived'; await this.save(decisions); }
	}

	/** Active decisions whose scope touches the given files (or the whole project), newest first. */
	async relevant(files: readonly string[] = []): Promise<Decision[]> {
		return (await this.list()).filter(item => item.status === 'active' && (!item.scope.length || !files.length || files.some(file => item.scope.some(glob => globPattern(glob).test(file)))))
			.sort((left, right) => right.at.localeCompare(left.at));
	}

	/** Markdown ADRs for an explicit export to the repository (`docs/adr/`). */
	async exportAdrs(directory: string): Promise<string[]> {
		const written: string[] = [];
		await fs.mkdir(directory, { recursive: true });
		for (const [index, item] of (await this.list()).filter(decision => decision.status !== 'archived').entries()) {
			const name = String(index + 1).padStart(4, '0') + '-' + item.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) + '.md';
			await fs.writeFile(path.join(directory, name), '# ' + item.title + '\n\n- Estado: ' + item.status + '\n- Fecha: ' + item.at.slice(0, 10) + '\n\n## Contexto\n\n' + item.context + '\n\n## Decisi\u00f3n\n\n' + item.decision + '\n' +
				(item.alternatives.length ? '\n## Alternativas descartadas\n\n' + item.alternatives.map(alternative => '- ' + alternative).join('\n') + '\n' : ''));
			written.push(name);
		}
		return written;
	}
}

/** What agents receive: the active decisions, and the instruction to ask (in the single round) when a request contradicts one. */
export function decisionsPrompt(decisions: readonly Decision[]): string {
	if (!decisions.length) { return ''; }
	return '\n\nProject decisions in force (follow them; if the request contradicts one, add a question about it instead of silently overriding it):\n' +
		decisions.slice(0, PROMPT_DECISIONS).map(item => '- ' + item.title + ': ' + item.decision.slice(0, 300)).join('\n');
}
