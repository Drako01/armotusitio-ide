/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { listProjectGuides, validateProjectGuides } from '../src/native-project-guidance.ts';

test('project guidance inventory includes Codex and Claude metadata but not instructions', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-guides-'));
	try {
		const canonical = await fs.realpath(root);
		await fs.mkdir(path.join(root, '.codex'));
		await fs.writeFile(path.join(root, 'AGENTS.md'), 'Private project instruction');
		await fs.writeFile(path.join(root, '.codex', 'AGENTS.md'), '# Codex');
		await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Claude');
		const guides = await listProjectGuides(canonical);
		assert.deepEqual(guides.map(guide => guide.path), ['AGENTS.md', 'CLAUDE.md', '.codex/AGENTS.md']);
		assert.equal(JSON.stringify(guides).includes('Private project instruction'), false);
		await validateProjectGuides(canonical, guides);
		await fs.writeFile(path.join(root, 'AGENTS.md'), 'Changed instructions');
		await assert.rejects(validateProjectGuides(canonical, guides), /HARNESS_PROJECT_GUIDANCE_CHANGED/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('project guidance refuses oversized files without returning their contents', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-guides-oversize-'));
	try {
		await fs.writeFile(path.join(root, 'AGENTS.md'), 'X'.repeat(64 * 1024 + 1));
		await assert.rejects(listProjectGuides(await fs.realpath(root)), /HARNESS_PROJECT_GUIDE_UNSAFE/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('linked nested guidance directory cannot escape the project', async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-guides-link-'));
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-guides-outside-'));
	try {
		await fs.writeFile(path.join(outside, 'AGENTS.md'), '# Secret');
		try {
			await fs.symlink(outside, path.join(root, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
		} catch (error) {
			if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) {
				t.skip('Directory link creation requires OS privileges');
				return;
			}
			throw error;
		}
		await assert.rejects(listProjectGuides(await fs.realpath(root)), /HARNESS_PROJECT_GUIDE_UNSAFE/);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	}
});
