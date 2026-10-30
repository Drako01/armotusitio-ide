/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeEngine } from '../src/native-engine-contract.ts';

test('native engine declares implemented features only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-engine-contract-'));
  try {
    const descriptor = await describeEngine(await fs.realpath(root));
    assert.equal(descriptor.schemaVersion, 2);
    assert.equal(descriptor.engine, 'ide-native');
    assert.ok(descriptor.supported.includes('agent-handoffs'));
    assert.ok(descriptor.unavailable.includes('os-sandbox'));
    assert.ok(descriptor.unavailable.includes('cost-accounting'));
    assert.equal(descriptor.executionEnabled, true);
    await fs.mkdir(path.join(root, '.harness'));
    const project = await describeEngine(await fs.realpath(root));
    assert.equal(project.engine, 'project');
    assert.equal(project.requiresExternalHandshake, true);
    assert.deepEqual(project.supported, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
