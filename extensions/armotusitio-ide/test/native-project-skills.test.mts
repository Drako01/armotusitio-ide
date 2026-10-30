/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { listProjectSkills, readProjectSkill } from '../src/native-project-skills.ts';

test('discovers project skills read-only with bounded content and rejects modified skills', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-skill-catalog-'));
	try {
		const canonical = await fs.realpath(root);
		const directory = path.join(root, '.agents', 'skills', 'go-api');
		await fs.mkdir(directory, { recursive: true });
		const file = path.join(directory, 'SKILL.md');
		await fs.writeFile(file, '# API conventions');
		const skills = await listProjectSkills(canonical);
		assert.deepEqual(skills.map(skill => skill.name), ['go-api']);
		assert.equal(await readProjectSkill(canonical, skills[0]), '# API conventions');
		await fs.writeFile(file, '# Changed');
		await assert.rejects(readProjectSkill(canonical, skills[0]), /HARNESS_PROJECT_SKILL_CHANGED/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('linked Claude skill aliases are not traversed or duplicated', async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-skill-alias-'));
	try {
		const canonical = await fs.realpath(root);
		await fs.mkdir(path.join(root, '.agents', 'skills', 'testing'), { recursive: true });
		await fs.writeFile(path.join(root, '.agents', 'skills', 'testing', 'SKILL.md'), '# Testing');
		await fs.mkdir(path.join(root, '.claude'));
		try {
			await fs.symlink(path.join(root, '.agents', 'skills'), path.join(root, '.claude', 'skills'),
				process.platform === 'win32' ? 'junction' : 'dir');
		} catch (error) {
			if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) {
				t.skip('Directory link creation requires OS privileges');
				return;
			}
			throw error;
		}
		assert.deepEqual((await listProjectSkills(canonical)).map(skill => skill.name), ['testing']);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('oversized project skills fail closed without exposing content', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-skill-oversize-'));
	try {
		const directory = path.join(root, '.agents', 'skills', 'unsafe');
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(path.join(directory, 'SKILL.md'), 'A'.repeat(64 * 1024 + 1));
		await assert.rejects(listProjectSkills(await fs.realpath(root)), /HARNESS_PROJECT_SKILL_UNSAFE/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('symlinked top-level skill parent is rejected instead of following outside workspace', async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-skills-parent-'));
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-skills-outside-'));
	try {
		const canonical = await fs.realpath(root);
		const dir = path.join(outside, 'skills', 'security');
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, 'SKILL.md'), '# Outside root');
		try {
			await fs.symlink(outside, path.join(root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
		} catch (error) {
			if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) {
				t.skip('Directory links unavailable on this machine');
				return;
			}
			throw error;
		}
		await assert.rejects(listProjectSkills(canonical), /HARNESS_PROJECT_SKILL_UNSAFE/);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	}
});

test('Codex-only project skills are discovered without any project Harness', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-codex-skills-'));
	try {
		const canonical = await fs.realpath(root);
		const directory = path.join(root, '.codex', 'skills', 'database-migrations');
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(path.join(directory, 'SKILL.md'), '# Codex migration conventions');
		const skills = await listProjectSkills(canonical);
		assert.deepEqual(skills.map(skill => [skill.name, skill.source]), [['database-migrations', '.codex/skills']]);
		assert.equal(await readProjectSkill(canonical, skills[0]), '# Codex migration conventions');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shared project skill takes precedence over duplicate Codex and Claude names', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-skill-precedence-'));
	try {
		for (const source of ['.agents', '.codex', '.claude']) {
			const directory = path.join(root, source, 'skills', 'go-api');
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(path.join(directory, 'SKILL.md'), source);
		}
		const canonical = await fs.realpath(root);
		const skills = await listProjectSkills(canonical);
		assert.equal(skills.length, 1);
		assert.equal(skills[0].source, '.agents/skills');
		assert.equal(await readProjectSkill(canonical, skills[0]), '.agents');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Codex skills directory symlink is never traversed', async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-codex-link-'));
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-codex-outside-'));
	try {
		await fs.mkdir(path.join(root, '.codex'));
		await fs.mkdir(path.join(outside, 'hidden'), { recursive: true });
		await fs.writeFile(path.join(outside, 'hidden', 'SKILL.md'), '# Outside');
		try {
			await fs.symlink(outside, path.join(root, '.codex', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
		} catch (error) {
			if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) {
				t.skip('Directory links unavailable on this machine');
				return;
			}
			throw error;
		}
		assert.deepEqual(await listProjectSkills(await fs.realpath(root)), []);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	}
});
