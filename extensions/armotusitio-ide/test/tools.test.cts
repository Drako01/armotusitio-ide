/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { indexProject } = require('../src/context.ts');
const { validRef } = require('../src/git.ts');
test('context inventory excludes secrets, symlinks, and dependency directories', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-context-'));
	try {
		fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'node_modules'));
		fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
		fs.writeFileSync(path.join(root, '.env'), 'SECRET=not-to-index');
		fs.writeFileSync(path.join(root, 'node_modules', 'index.js'), '// dependency');
		const files = (await indexProject(root)).files;
		assert.deepEqual(files, ['src/index.ts']);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('worktree refs reject traversal and option injection', () => {
	for (const good of ['feat/work-123', 'bugfix', 'team/task_a']) { assert.equal(validRef(good), true); }
	for (const bad of ['../escape', '-option', 'feat/../escape', 'x.lock']) { assert.equal(validRef(bad), false); }
});
