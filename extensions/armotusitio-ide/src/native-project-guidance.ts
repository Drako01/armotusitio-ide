/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Read-only project guidance inventory. Metadata is not permission to execute anything. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const KNOWN_GUIDES = ['AGENTS.md', 'CLAUDE.md', '.codex/AGENTS.md', '.github/copilot-instructions.md'] as const;
const MAX_GUIDE_BYTES = 64 * 1024;
export type ProjectGuidePath = typeof KNOWN_GUIDES[number];
export interface ProjectGuide { path: ProjectGuidePath; digest: string; bytes: number }

async function safeGuide(root: string, relative: ProjectGuidePath): Promise<Buffer | undefined> {
	const parts = relative.split('/');
	let current = root;
	for (const part of parts.slice(0, -1)) {
		current = path.join(current, part);
		let info;
		try { info = await fs.lstat(current); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
			throw error;
		}
		if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(current) !== current) {
			throw Error('HARNESS_PROJECT_GUIDE_UNSAFE');
		}
	}
	const file = path.join(root, relative);
	let info;
	try { info = await fs.lstat(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_GUIDE_BYTES ||
		await fs.realpath(file) !== file) { throw Error('HARNESS_PROJECT_GUIDE_UNSAFE'); }
	const bytes = await fs.readFile(file);
	if (bytes.length > MAX_GUIDE_BYTES) { throw Error('HARNESS_PROJECT_GUIDE_UNSAFE'); }
	return bytes;
}

export async function listProjectGuides(root: string): Promise<ProjectGuide[]> {
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_PROJECT_GUIDE_ROOT_CHANGED'); }
	const found: ProjectGuide[] = [];
	for (const relative of KNOWN_GUIDES) {
		const data = await safeGuide(canonical, relative);
		if (data) {
			found.push({ path: relative, digest: createHash('sha256').update(data).digest('hex'), bytes: data.length });
		}
	}
	return found;
}

/** Check a previously reviewed guide snapshot, without returning contents to any UI. */
export async function validateProjectGuides(root: string, expected: readonly ProjectGuide[]): Promise<void> {
	const actual = await listProjectGuides(root);
	if (JSON.stringify(actual) !== JSON.stringify(expected)) { throw Error('HARNESS_PROJECT_GUIDANCE_CHANGED'); }
}
