/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Project preferences are data, never authority: every launch still needs the parent's approval. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { samePath } from './native-path.ts';
import { validModel } from './native-providers.ts';

export interface AgentProfile {
	id: string;
	role: 'planner' | 'reviewer';
	instruction: string;
	enabled: boolean;
	model?: string;
	maxTurns: number;
}
export interface AgentProfiles {
	digest: string;
	maxConcurrent: number;
	maxLaunches: number;
	profiles: AgentProfile[];
}
const invalid = (): never => { throw Error('HARNESS_AGENT_PROFILES_INVALID'); };

/** Only lower existing limits; filesystem, shell, MCP and nested delegation are always unavailable. */
export function parseAgentProfiles(text: string): AgentProfiles {
	if (Buffer.byteLength(text) > 65536) { return invalid(); }
	let raw: Record<string, unknown>;
	try { raw = JSON.parse(text); } catch { return invalid(); }
	if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1
		|| Object.keys(raw).some(key => !['schemaVersion', 'maxConcurrent', 'maxLaunches', 'agents'].includes(key))
		|| !Array.isArray(raw.agents) || raw.agents.length > 16) { return invalid(); }
	const limit = (value: unknown): number => {
		if (value === undefined) { return 2; }
		if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2) { return invalid(); }
		return Number(value);
	};
	const ids = new Set<string>();
	const profiles: AgentProfile[] = raw.agents.map((value: Record<string, unknown>) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)
			|| Object.keys(value).some(key => !['id', 'role', 'instruction', 'enabled', 'model', 'maxTurns', 'tools'].includes(key))
			|| typeof value.id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(value.id) || ids.has(value.id)
			|| (value.role !== 'planner' && value.role !== 'reviewer')
			|| typeof value.instruction !== 'string' || !value.instruction.trim() || value.instruction.length > 2000 || value.instruction.includes('\0')
			|| (value.enabled !== undefined && typeof value.enabled !== 'boolean')
			|| (value.model !== undefined && !validModel(value.model))
			|| (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length !== 0))
			|| (value.maxTurns !== undefined && (!Number.isSafeInteger(value.maxTurns) || Number(value.maxTurns) < 1 || Number(value.maxTurns) > 6))) { return invalid(); }
		ids.add(value.id);
		return {
			id: value.id, role: value.role, instruction: value.instruction, enabled: value.enabled === true,
			maxTurns: value.maxTurns === undefined ? 6 : Number(value.maxTurns), ...(value.model ? { model: value.model as string } : {})
		};
	});
	return { digest: createHash('sha256').update(text).digest('hex'), maxConcurrent: limit(raw.maxConcurrent), maxLaunches: limit(raw.maxLaunches), profiles };
}

/** Refuse redirects and oversized files before reading project-supplied configuration. */
export async function loadAgentProfiles(root: string): Promise<AgentProfiles> {
	const directory = path.join(root, '.armotusitio');
	const file = path.join(directory, 'agents.json');
	try {
		for (const entry of [root, directory, file]) {
			const stat = await fs.lstat(entry);
			if (stat.isSymbolicLink() || !samePath(await fs.realpath(entry), path.resolve(entry))
				|| (entry === file ? !stat.isFile() || stat.size > 65536 : !stat.isDirectory())) { return invalid(); }
		}
		const bytes = await fs.readFile(file);
		if (bytes.length > 65536 || !samePath(await fs.realpath(file), path.resolve(file))) { return invalid(); }
		return parseAgentProfiles(bytes.toString('utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { digest: 'absent', maxConcurrent: 2, maxLaunches: 2, profiles: [] }; }
		throw error;
	}
}
