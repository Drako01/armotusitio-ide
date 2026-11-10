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
	source: '.agents/skills' | '.codex/skills' | '.claude/skills' | '.claude/commands';
	digest: string;
}
// Shared skills take precedence; provider-specific directories are fallback sources.
const SOURCES = ['.agents/skills', '.codex/skills', '.claude/skills', '.claude/commands'] as const;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_SKILLS = 64;
const MAX_SKILL_BYTES = 64 * 1024;

/** Shared bounded reader for project and shipped skills. Never follows a linked parent or leaf. */
export async function readSkillFile(root: string, file: string, digest?: string): Promise<Buffer> {
	if (await fs.realpath(root) !== root || !file.startsWith(root + path.sep)) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
	const validate = async () => {
		let directory = path.dirname(file);
		while (directory !== root) {
			if (!await canonicalDirectory(root, directory)) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
			directory = path.dirname(directory);
		}
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES || await fs.realpath(file) !== file) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
	};
	await validate();
	const handle = await fs.open(file, 'r');
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
		// A bounded read also covers files growing after stat, without allocating their entire contents.
		const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await handle.read(buffer, size, buffer.length - size, size);
			if (!read.bytesRead) { break; }
			size += read.bytesRead;
		}
		if (size > MAX_SKILL_BYTES) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
		await validate();
		const data = buffer.subarray(0, size);
		if (digest && createHash('sha256').update(data).digest('hex') !== digest) { throw Error('HARNESS_PROJECT_SKILL_CHANGED'); }
		return data;
	} finally { await handle.close(); }
}

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

/** Validate both the top-level folder and the skills leaf; a safe leaf may hide a linked parent. */
async function safeSource(root: string, source: ProjectSkill['source']): Promise<boolean> {
	const parent = path.join(root, source.split('/')[0]);
	if (!await canonicalDirectory(root, parent)) { return false; }
	return canonicalDirectory(root, path.join(root, source));
}

/** Returns metadata only. No file contents are included in discovery output. */
export async function listProjectSkills(root: string): Promise<ProjectSkill[]> {
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_PROJECT_SKILL_ROOT_CHANGED'); }
	const result: ProjectSkill[] = [];
	const seen = new Set<string>();
	for (const source of SOURCES) {
		const directory = path.join(canonical, source);
		// Provider directories may alias the shared skills folder. Never follow links.
		if (source !== '.agents/skills') {
			try {
				if ((await fs.lstat(directory)).isSymbolicLink()) { continue; }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
				throw error;
			}
		}
		if (!await safeSource(canonical, source)) { continue; }
		const entries = await fs.readdir(directory, { withFileTypes: true });
		if (entries.length > MAX_SKILLS) { throw Error('HARNESS_PROJECT_SKILLS_TOO_MANY'); }
		for (const entry of entries) {
			const command = source === '.claude/commands';
			const name = command && entry.name.endsWith('.md') ? entry.name.slice(0, -3) : entry.name;
			if (!SAFE_NAME.test(name) || entry.isSymbolicLink() || (command ? !entry.isFile() || !entry.name.endsWith('.md') : !entry.isDirectory())) { continue; }
			if (seen.has(name.toLowerCase())) { continue; }
			const skillDir = command ? directory : path.join(directory, name);
			if (!await canonicalDirectory(canonical, skillDir)) { continue; }
			const file = command ? path.join(directory, entry.name) : path.join(skillDir, 'SKILL.md');
			let stat;
			try { stat = await fs.lstat(file); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
				throw error;
			}
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES ||
				await fs.realpath(file) !== file) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
			const bytes = await readSkillFile(canonical, file);
			if (bytes.length > MAX_SKILL_BYTES) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
			result.push({ name, source, digest: createHash('sha256').update(bytes).digest('hex') });
			seen.add(name.toLowerCase());
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
	const command = skill.source === '.claude/commands';
	const dir = command ? path.join(canonical, skill.source) : path.join(canonical, skill.source, skill.name);
	if (!await safeSource(canonical, skill.source) ||
		!await canonicalDirectory(canonical, dir)) { throw Error('HARNESS_PROJECT_SKILL_CHANGED'); }
	const file = command ? path.join(dir, skill.name + '.md') : path.join(dir, 'SKILL.md');
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES ||
		await fs.realpath(file) !== file) { throw Error('HARNESS_PROJECT_SKILL_UNSAFE'); }
	const data = await readSkillFile(canonical, file, skill.digest);
	if (createHash('sha256').update(data).digest('hex') !== skill.digest) { throw Error('HARNESS_PROJECT_SKILL_CHANGED'); }
	return data.toString('utf8');
}
