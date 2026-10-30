/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createAgentWorktree, removeCleanAgentWorktree, listAgentWorktrees } from '../src/native-agent-worktree.ts';

test('isolated worktree preserves the primary checkout and refuses dirty disposal', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-worktree-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  try {
    execFileSync('git', ['init', '-q', root]);
    await fs.writeFile(path.join(root, 'file.txt'), 'original');
    execFileSync('git', ['-C', root, 'add', 'file.txt']);
    execFileSync('git', ['-C', root, '-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '-qm', 'initial']);
    await fs.writeFile(path.join(root, 'file.txt'), 'dirty local work');
    await assert.rejects(createAgentWorktree(await fs.realpath(root), path.join(directory, 'isolated')), /HARNESS_WORKTREE_SOURCE_DIRTY/);
    await fs.writeFile(path.join(root, 'file.txt'), 'original');
    const worktree = await createAgentWorktree(await fs.realpath(root), path.join(directory, 'isolated'));
    assert.equal(await fs.readFile(path.join(worktree.root, 'file.txt'), 'utf8'), 'original');
    assert.equal((await listAgentWorktrees(await fs.realpath(root), path.join(directory, 'isolated'))).length, 1);
    await fs.writeFile(path.join(worktree.root, 'file.txt'), 'agent change');
    assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'original');
    await assert.rejects(removeCleanAgentWorktree(worktree), /HARNESS_WORKTREE_DIRTY/);
    await fs.writeFile(path.join(worktree.root, 'file.txt'), 'original');
    await removeCleanAgentWorktree(worktree);
    await assert.rejects(fs.stat(worktree.root), { code: 'ENOENT' });
    assert.equal((await listAgentWorktrees(await fs.realpath(root), path.join(directory, 'isolated'))).length, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
