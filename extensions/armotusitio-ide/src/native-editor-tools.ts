/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Editor intelligence for agents (block S): language-server queries the IDE already runs. Results are bounded and use
 * project-relative paths; `rename` and `organizeImports` edits are applied by the IDE only when every file is in scope.
 */
import * as path from 'node:path';

export interface EditorLocation { file: string; line: number; character: number; preview?: string }
export interface EditorEditPreview { files: string[]; apply(): Promise<void> }
/** Implemented by the integration with `vscode.execute*Provider`; paths here are absolute. */
export interface EditorBackend {
	locations(kind: 'definition' | 'references' | 'implementations' | 'typeDefinition', file: string, line: number, character: number): Promise<EditorLocation[]>;
	symbols(file: string | undefined, query: string): Promise<Array<{ name: string; kind: string; file: string; line: number }>>;
	hover(file: string, line: number, character: number): Promise<string[]>;
	calls(direction: 'incoming' | 'outgoing', file: string, line: number, character: number): Promise<EditorLocation[]>;
	diagnostics(file: string | undefined): Promise<Array<{ file: string; line: number; severity: string; message: string }>>;
	rename(file: string, line: number, character: number, name: string): Promise<EditorEditPreview | undefined>;
	organizeImports(file: string): Promise<EditorEditPreview | undefined>;
}

const MAX_RESULTS = 100;
const POSITION = { file: { type: 'string', description: 'Project-relative file.' }, line: { type: 'integer', minimum: 1, description: '1-based line.' }, character: { type: 'integer', minimum: 1, description: '1-based column.' } };
const at = (extra: Record<string, unknown> = {}) => ({ type: 'object', properties: { ...POSITION, ...extra }, required: ['file', 'line', 'character', ...Object.keys(extra)], additionalProperties: false });

/** MCP tool definitions served by `ats-runner` when the editor channel is available. */
export const EDITOR_TOOLS = [
	{ name: 'definition', description: 'Go to the definition of the symbol at a position.', inputSchema: at() },
	{ name: 'references', description: 'All references to the symbol at a position.', inputSchema: at() },
	{ name: 'implementations', description: 'Implementations of the interface or method at a position.', inputSchema: at() },
	{ name: 'typeDefinition', description: 'Definition of the type of the symbol at a position.', inputSchema: at() },
	{ name: 'symbols', description: 'Symbols of a file, or workspace symbols matching a query.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, query: { type: 'string' } }, additionalProperties: false } },
	{ name: 'hover', description: 'Type and documentation of the symbol at a position.', inputSchema: at() },
	{ name: 'callHierarchy', description: 'Incoming or outgoing calls of the function at a position.', inputSchema: at({ direction: { type: 'string', enum: ['incoming', 'outgoing'] } }) },
	{ name: 'diagnostics', description: 'Current errors and warnings, of one file or of the project.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false } },
	{ name: 'rename', description: 'Rename the symbol at a position everywhere it is used (safe refactor).', inputSchema: at({ newName: { type: 'string' } }) },
	{ name: 'organizeImports', description: 'Organize the imports of a file.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false } }
];

export interface EditorToolContext { root: string; backend: EditorBackend; inScope(file: string): boolean }

const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

/** A project-relative path that stays inside the project. */
function resolve(root: string, file: unknown): string {
	if (typeof file !== 'string' || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) { throw Error('HARNESS_PATH_ESCAPE'); }
	return path.join(root, file);
}
function position(input: Record<string, unknown>): [number, number] {
	const line = input.line, character = input.character;
	if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || (line as number) < 1 || (character as number) < 1) { throw Error('HARNESS_ARGUMENTS'); }
	return [(line as number) - 1, (character as number) - 1];
}
const listLocations = (root: string, items: EditorLocation[]) => items.slice(0, MAX_RESULTS).map(item => relative(root, item.file) + ':' + (item.line + 1) + ':' + (item.character + 1) + (item.preview ? '  ' + item.preview.trim().slice(0, 160) : '')).join('\n') + (items.length > MAX_RESULTS ? '\n(+' + (items.length - MAX_RESULTS) + ' more)' : '');

/** Run one editor tool; returns the text answer for the agent. */
export async function runEditorTool(context: EditorToolContext, name: string, input: Record<string, unknown>): Promise<string> {
	const { root, backend } = context;
	switch (name) {
		case 'definition': case 'references': case 'implementations': case 'typeDefinition': {
			const [line, character] = position(input);
			return listLocations(root, await backend.locations(name, resolve(root, input.file), line, character)) || '(no results)';
		}
		case 'symbols': {
			const symbols = await backend.symbols(input.file === undefined ? undefined : resolve(root, input.file), typeof input.query === 'string' ? input.query.slice(0, 200) : '');
			return symbols.slice(0, MAX_RESULTS).map(symbol => symbol.kind + ' ' + symbol.name + '  ' + relative(root, symbol.file) + ':' + (symbol.line + 1)).join('\n') || '(no symbols)';
		}
		case 'hover': { const [line, character] = position(input); return (await backend.hover(resolve(root, input.file), line, character)).join('\n').slice(0, 8000) || '(no information)'; }
		case 'callHierarchy': {
			const [line, character] = position(input);
			return listLocations(root, await backend.calls(input.direction === 'outgoing' ? 'outgoing' : 'incoming', resolve(root, input.file), line, character)) || '(no calls)';
		}
		case 'diagnostics': {
			const items = await backend.diagnostics(input.file === undefined ? undefined : resolve(root, input.file));
			return items.slice(0, MAX_RESULTS).map(item => relative(root, item.file) + ':' + (item.line + 1) + ' ' + item.severity + ': ' + item.message.slice(0, 300)).join('\n') || '(no diagnostics)';
		}
		case 'rename': case 'organizeImports': {
			const file = resolve(root, input.file);
			let preview: EditorEditPreview | undefined;
			if (name === 'rename') {
				const [line, character] = position(input);
				if (typeof input.newName !== 'string' || !/^[\p{L}_$][\p{L}\p{N}_$]{0,200}$/u.test(input.newName)) { throw Error('HARNESS_ARGUMENTS'); }
				preview = await backend.rename(file, line, character, input.newName);
			} else { preview = await backend.organizeImports(file); }
			if (!preview?.files.length) { return '(nothing to change)'; }
			const files = preview.files.map(item => relative(root, item));
			const outside = files.filter(item => item.startsWith('..') || !context.inScope(item));
			if (outside.length) { return 'POLICY_DENIED: edit-outside-scope (' + outside.slice(0, 10).join(', ') + ')'; }
			await preview.apply();
			return 'Applied to ' + files.length + ' files:\n' + files.slice(0, MAX_RESULTS).join('\n');
		}
	}
	throw Error('HARNESS_TOOL');
}
