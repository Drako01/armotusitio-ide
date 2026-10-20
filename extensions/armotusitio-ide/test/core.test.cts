/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { detect, command, validatePlan } = require('../src/core.ts');
function fixture(name, dir) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-ide-')); fs.mkdirSync(path.join(root, dir)); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, packageManager: 'pnpm@11.23.0', scripts: { 'harness:check': 'node check', 'harness:verify': 'node verify' } })); return root; }
test('profiles distinguish actual harness roots', async () => { for (const [name, dir, id] of [['redevent', '.harness', 'redevent'], ['armotusitio-next', 'harness', 'armotusitio']]) { const root = fixture(name, dir); try { const p = await detect(root); assert.equal(p.id, id); assert.deepEqual(p.actions, ['check', 'verify']); assert.deepEqual(command(p, 'verify').args, ['harness:verify']); assert.throws(() => command(p, 'deploy')); } finally { fs.rmSync(root, { recursive: true, force: true }); } } });
test('reject malformed cyclic and dangerous agent plans', () => { const task = { id: 'a', host: 'codex', command: ['codex', 'exec'], scope: ['apps/api'], dependencies: [], budget: 100, resource: 'read' }; assert.deepEqual(validatePlan({ tasks: [task] }), { tasks: 1, budget: 100 }); assert.throws(() => validatePlan({ tasks: [{ ...task, command: ['codex', '--yolo'] }] })); assert.throws(() => validatePlan({ tasks: [{ ...task, dependencies: ['a'] }] })); assert.throws(() => validatePlan({ tasks: [task, { ...task, id: 'b', dependencies: ['a'] }, { ...task, id: 'c', dependencies: ['b', 'c'] }] })); });
