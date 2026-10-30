/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { captureAgentScope, scopeChanged } from '../src/native-agent-scope.ts';

test('protects sensitive root files even without Git metadata', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-scope-'));
	try {
		const canonical = await fs.realpath(root);
		const before = await captureAgentScope(canonical);
		assert.equal(before.source, 'none');
		await fs.writeFile(path.join(root, '.env'), 'API_KEY=dummy');
		const after = await captureAgentScope(canonical);
		assert.equal(scopeChanged(before, after), true);
		assert.equal(scopeChanged(after, after), false);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rejects noncanonical roots', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-scope-canonical-'));
	try {
		await assert.rejects(captureAgentScope(root + path.sep + '.'), /HARNESS_SCOPE_ROOT_CHANGED/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
