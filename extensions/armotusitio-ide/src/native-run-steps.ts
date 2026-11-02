/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * What the agent is doing, step by step, read from the provider's event stream (Claude `stream-json`, Codex `--json`).
 * Pure and bounded: unknown events are ignored, labels carry only a target (a path, a command, a query) and never file
 * contents or tool output, everything passes through `redactSecrets`, and paths are shown relative to the project.
 */
import * as path from 'node:path';
import type { NativeProvider } from './native-providers.ts';
import { asObject as object } from './native-json.ts';
import { redactSecrets } from './native-redact.ts';

export type ChatStepKind = 'read' | 'edit' | 'command' | 'search' | 'tool' | 'message';
export type ChatStepStatus = 'running' | 'ok' | 'error';
export interface ChatStep {
	id: string;
	kind: ChatStepKind;
	label: string;
	status: ChatStepStatus;
	detail?: string;
}

export const MAX_STEPS = 200;
export const MAX_STEP_LABEL = 160;
export const MAX_STEP_DETAIL = 400;
/** Steps kept in the stored run summary; the live timeline holds up to MAX_STEPS. */
export const MAX_SUMMARY_STEPS = 50;
const MAX_STEP_ID = 64;
const STEP_KINDS: readonly string[] = ['read', 'edit', 'command', 'search', 'tool', 'message'];
const STEP_STATUSES: readonly string[] = ['running', 'ok', 'error'];


/** One line, secrets removed first so truncation can never cut a token in a way that defeats the redaction. */
function clip(value: unknown, max: number): string {
	if (typeof value !== 'string') { return ''; }
	const flat = redactSecrets(value).replace(/\s+/g, ' ').trim();
	return flat.length > max ? flat.slice(0, max - 3) + '...' : flat;
}

/** Project-relative path with forward slashes; a path outside the project is reduced to its file name. */
export function relativeStepPath(root: string, file: unknown): string {
	if (typeof file !== 'string' || !file.trim() || file.includes('\0')) { return ''; }
	const absolute = path.isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file);
	if (!absolute) { return clip(file.replace(/\\/g, '/').replace(/^\.\//, ''), MAX_STEP_LABEL); }
	const relative = path.relative(root, file);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { return clip('.../' + file.split(/[\\/]/).filter(Boolean).at(-1), MAX_STEP_LABEL); }
	return clip(relative.replace(/\\/g, '/'), MAX_STEP_LABEL);
}

const CLAUDE_KINDS: Record<string, ChatStepKind> = {
	Read: 'read', NotebookRead: 'read', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
	Bash: 'command', Grep: 'search', Glob: 'search', WebSearch: 'search', WebFetch: 'search'
};

/**
 * Turns decoded provider events into steps and reports each creation or status change to `emit` (same id, new status).
 * Observers have no authority over parsing: a throwing `emit` never stops it, but the first failure of a run is reported.
 */
export class RunStepExtractor {
	private readonly steps = new Map<string, ChatStep>();
	private counter = 0;
	private observerFailed = false;
	private readonly provider: NativeProvider;
	private readonly root: string;
	private readonly emit: (step: ChatStep) => void;

	constructor(provider: NativeProvider, root: string, emit: (step: ChatStep) => void) {
		this.provider = provider; this.root = root; this.emit = emit;
	}

	accept(event: Record<string, unknown>): void {
		if (this.provider === 'claude') { this.acceptClaude(event); }
		else { this.acceptCodex(event); }
	}

	private put(step: ChatStep): void {
		const known = this.steps.get(step.id);
		if (!known && this.steps.size >= MAX_STEPS) { return; }
		const next: ChatStep = { ...known, ...step };
		this.steps.set(step.id, next);
		try { this.emit({ ...next }); }
		catch (error) {
			if (!this.observerFailed) {
				this.observerFailed = true;
				console.warn('[armotusitio] step observer failed:', redactSecrets(error instanceof Error ? error.message : String(error)));
			}
		}
	}

	private finish(id: unknown, failed: boolean, detail?: string): void {
		const known = typeof id === 'string' ? this.steps.get(id) : undefined;
		if (known) { this.put({ ...known, status: failed ? 'error' : 'ok', ...(failed && detail ? { detail } : {}) }); }
	}

	private message(label: string): void {
		const text = clip(label, MAX_STEP_LABEL);
		if (text) { this.put({ id: 'message-' + ++this.counter, kind: 'message', label: text, status: 'ok' }); }
	}

	private acceptClaude(event: Record<string, unknown>): void {
		const content = object(event.message)?.content;
		const blocks = (Array.isArray(content) ? content : []).map(block => object(block));
		if (event.type === 'assistant') {
			for (const block of blocks) {
				if (block?.type === 'text') { this.message(block.text as string); }
				if (block?.type !== 'tool_use' || typeof block.id !== 'string' || block.id.length > MAX_STEP_ID) { continue; }
				const name = typeof block.name === 'string' ? block.name : '';
				const input = object(block.input) ?? {};
				const kind = CLAUDE_KINDS[name] ?? 'tool';
				const label = kind === 'read' || kind === 'edit' ? relativeStepPath(this.root, input.file_path ?? input.notebook_path ?? input.path)
					: name === 'Bash' ? clip(input.command, MAX_STEP_LABEL)
						: name === 'Grep' || name === 'Glob' ? clip(input.pattern, MAX_STEP_LABEL)
							: name === 'WebSearch' ? clip(input.query, MAX_STEP_LABEL)
								: name === 'WebFetch' ? clip(input.url, MAX_STEP_LABEL) : clip(name, MAX_STEP_LABEL);
				const detail = name === 'Bash' ? clip(input.description, MAX_STEP_DETAIL) : '';
				this.put({ id: block.id, kind, label: label || clip(name, MAX_STEP_LABEL) || kind, status: 'running', ...(detail ? { detail } : {}) });
			}
		}
		if (event.type === 'user') {
			for (const block of blocks) {
				if (block?.type !== 'tool_result') { continue; }
				const failed = block.is_error === true;
				// Only the first line of a failure says why; a successful result's content is never read.
				const reason = failed ? clip(this.firstText(block.content), MAX_STEP_DETAIL) : '';
				this.finish(block.tool_use_id, failed, reason);
			}
		}
	}

	private firstText(content: unknown): string {
		if (typeof content === 'string') { return content.split('\n', 1)[0]; }
		const first = (Array.isArray(content) ? content : []).map(block => object(block)).find(block => block?.type === 'text' && typeof block.text === 'string');
		return first ? (first.text as string).split('\n', 1)[0] : '';
	}

	private acceptCodex(event: Record<string, unknown>): void {
		if (event.type !== 'item.started' && event.type !== 'item.completed') { return; }
		const item = object(event.item);
		if (!item) { return; }
		const done = event.type === 'item.completed';
		const id = typeof item.id === 'string' && item.id.length <= MAX_STEP_ID ? item.id : undefined;
		const failedStatus = item.status === 'failed' || item.status === 'declined';
		const base = { status: !done ? 'running' as const : failedStatus ? 'error' as const : 'ok' as const };
		if (item.type === 'agent_message' || item.type === 'assistant_message' || item.type === 'reasoning') {
			if (done && typeof item.text === 'string') { this.message(item.text); }
			return;
		}
		if (!id) { return; }
		if (item.type === 'command_execution') {
			const code = item.exit_code;
			const failed = failedStatus || (done && typeof code === 'number' && code !== 0);
			this.put({ id, kind: 'command', label: clip(item.command, MAX_STEP_LABEL) || 'command', status: done ? (failed ? 'error' : 'ok') : 'running', ...(failed && typeof code === 'number' ? { detail: 'exit ' + code } : {}) });
		} else if (item.type === 'file_change') {
			const changes = (Array.isArray(item.changes) ? item.changes : []).map(change => object(change)).filter(change => !!change);
			const files = changes.map(change => relativeStepPath(this.root, change!.path)).filter(Boolean);
			const label = clip(files.slice(0, 3).join(', ') + (files.length > 3 ? ' +' + (files.length - 3) : ''), MAX_STEP_LABEL);
			this.put({ id, kind: 'edit', label: label || 'files', ...base });
		} else if (item.type === 'mcp_tool_call') {
			const label = clip([item.server, item.tool].filter(part => typeof part === 'string' && part).join('.'), MAX_STEP_LABEL);
			const reason = failedStatus ? clip(object(item.error)?.message, MAX_STEP_DETAIL) : '';
			this.put({ id, kind: 'tool', label: label || 'mcp', ...base, ...(reason ? { detail: reason } : {}) });
		} else if (item.type === 'web_search') {
			this.put({ id, kind: 'search', label: clip(item.query, MAX_STEP_LABEL) || 'web', ...base });
		}
	}
}

/** The compact form stored with a finished run: the most recent steps, no detail, nothing left "running". */
export function summarizeSteps(steps: readonly ChatStep[]): ChatStep[] {
	return steps.slice(-MAX_SUMMARY_STEPS).map(step => ({ id: step.id, kind: step.kind, label: step.label, status: step.status === 'running' ? 'error' : step.status }));
}

/** Insert or update a step by id, keeping the list within MAX_STEPS. */
export function upsertStep(steps: ChatStep[], step: ChatStep): ChatStep[] {
	const index = steps.findIndex(item => item.id === step.id);
	if (index !== -1) { const next = steps.slice(); next[index] = step; return next; }
	return steps.length >= MAX_STEPS ? steps : [...steps, step];
}

/** A stored summary is display data; anything malformed is rejected instead of trusted. */
export function validChatSteps(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.length <= MAX_SUMMARY_STEPS && value.every(step => {
		const item = object(step);
		return !!item && typeof item.id === 'string' && item.id.length <= MAX_STEP_ID && STEP_KINDS.includes(item.kind as string) &&
			typeof item.label === 'string' && item.label.length <= MAX_STEP_LABEL && STEP_STATUSES.includes(item.status as string) &&
			(item.detail === undefined || (typeof item.detail === 'string' && item.detail.length <= MAX_STEP_DETAIL));
	}));
}
