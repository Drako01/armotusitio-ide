/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sensitiveScopeDigest } from '../src/native-sensitive-scope.ts';

test('detects nested ignored credentials with identical size', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-scope-'));
  try {
    const canonical = await fs.realpath(root);
    await fs.mkdir(path.join(root, 'apps', 'backend'), { recursive: true });
    await fs.writeFile(path.join(root, 'apps', 'backend', '.env'), 'KEY=abc');
    const before = await sensitiveScopeDigest(canonical);
    await fs.writeFile(path.join(root, 'apps', 'backend', '.env'), 'KEY=xyz');
    const after = await sensitiveScopeDigest(canonical);
    assert.equal(before.entries, 1);
    assert.notEqual(before.digest, after.digest);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('ignores dependency directories but fails closed on oversized secrets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sensitive-limits-'));
  try {
    const canonical = await fs.realpath(root);
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'node_modules', '.env'), 'not part of source');
    assert.equal((await sensitiveScopeDigest(canonical)).entries, 0);
    await fs.writeFile(path.join(root, '.env'), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(sensitiveScopeDigest(canonical), /HARNESS_SENSITIVE_FILE_TOO_LARGE/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
