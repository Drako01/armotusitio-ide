/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Read-only, bounded project skills for native agent review; never executes project code. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface ProjectSkill {
	name: string;
	source: '.agents/skills' | '.claude/skills';
	digest: string;
}
const SOURCES = ['.agents/skills', '.claude/skills'] as const;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_SKILLS = 64;
const MAX_SKILL_BYTES = 4096;

async function canonicalDirectory(root: string, location: string): Promise<boolean> {
	let stat;
	try { stat = await fs.lstat(location); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false; }
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(location) !== location ||
		!(location === root || location.startsWith(root + path.sep))) {
		throw Error('HARNESS_PROJECT_SKILL_UNSAFE');
	}
	return true;
}

/** Returns metadata only. No file contents are included in discovery output. */
export async function listProjectSkills(root: string): Promise<ProjectSkill[]> {
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_PROJECT_SKILL_ROOT_CHANGED'); }
	const result: ProjectSkill[] = [];
	const seen = new Set<string>();
	for (const source of SOURCES) {
		const directory = path.join(canonical, source);
		// Legacy project setups may link .claude/skills to .agents/skills.
		// Never traverse that link; the canonical .agents source was already read.
		if (source === '.claude/skills') {
			try {
				if ((await fs.lstat(directory)).isSymbolicLink()) { continue; }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
				throw error;
			}
		}
		if (!await canonicalDirectory(canonical, directory)) { continue; }
		const entries = await fs.readdir(directory, { withFileTypes: true });
		if (entries.length > MAX_SKILLS) { throw Error('HARNESS_PROJECT_SKILLS_TOO_MANY'); }
		for (const entry of entries) {
			if (!SAFE_NAME.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) { continue; }
			if (seen.has(entry.name.toLowerCase())) { continue; }
			const skillDir = path.join(directory, entry.name);
			if (!await canonicalDirectory(canonical, skillDir)) { continue; }
			const file = path.join(skillDir, 'SKILL.md');
			let stat;
			try { stat = await fs.lstat(file); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
				throw error;
			}
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES ||
				await fs.realpath(file) !== file) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
			const bytes = await fs.readFile(file);
			if (bytes.length > MAX_SKILL_BYTES) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
			result.push({ name: entry.name, source, digest: createHash('sha256').update(bytes).digest('hex') });
			seen.add(entry.name.toLowerCase());
			if (result.length > MAX_SKILLS) { throw Error('HARNESS_PROJECT_SKILLS_TOO_MANY'); }
		}
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Revalidates the exact approved skill digest before passing it to a reviewed agent. */
export async function readProjectSkill(root: string, skill: ProjectSkill): Promise<string> {
	if (!SAFE_NAME.test(skill.name) || !SOURCES.includes(skill.source) || !/^[a-f0-9]{64}$/.test(skill.digest)) {
		throw Error('HARNESS_PROJECT_SKILL_INVALID');
	}
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_PROJECT_SKILL_ROOT_CHANGED'); }
	const dir = path.join(canonical, skill.source, skill.name);
	if (!await canonicalDirectory(canonical, path.join(canonical, skill.source)) ||
		!await canonicalDirectory(canonical, dir)) { throw Error('HARNESS_PROJECT_SKILL_CHANGED'); }
	const file = path.join(dir, 'SKILL.md');
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES ||
		await fs.realpath(file) !== file) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
	const data = await fs.readFile(file);
	if (createHash('sha256').update(data).digest('hex') !== skill.digest) { throw Error('HARNESS_PROJECT_SKILL_CHANGED'); }
	return data.toString('utf8');
}
