/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
/** Disposable Git worktree provisioning for explicitly approved local agent workflows. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveNativeCommand } from './native-runtime.ts';

const MAX_MESSAGE = 2048;
const GIT_TIMEOUT = 180_000;
export interface ManagedWorktree { root: string; parent: string; id: string; }

async function git(root: string, args: string[]): Promise<string> {
  const command = await resolveNativeCommand('git', args);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: root, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: {
        PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GIT_OPTIONAL_LOCKS: '0'
      }
    });
    let stdout = '', stderr = '', exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, GIT_TIMEOUT);
    timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8').slice(0, MAX_MESSAGE);
      if (stdout.length > MAX_MESSAGE) { exceeded = true; child.kill(); }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, MAX_MESSAGE);
      if (stderr.length > MAX_MESSAGE) { exceeded = true; child.kill(); }
    });
    child.once('error', () => { clearTimeout(timer); reject(Error('HARNESS_WORKTREE_GIT_UNAVAILABLE')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (exceeded || code !== 0) { reject(Error('HARNESS_WORKTREE_GIT_FAILED')); }
      else { resolve(stdout.trim()); }
    });
  });
}

export async function createAgentWorktree(root: string, storage: string): Promise<ManagedWorktree> {
  const canonical = await fs.realpath(root);
  if (canonical !== root) { throw Error('HARNESS_WORKTREE_ROOT_CHANGED'); }
  const topLevel = await git(canonical, ['rev-parse', '--show-toplevel']);
  const topCanonical = await fs.realpath(topLevel);
  if ((process.platform === 'win32' ? topCanonical.toLowerCase() : topCanonical) !== (process.platform === 'win32' ? canonical.toLowerCase() : canonical)) { throw Error('HARNESS_WORKTREE_NOT_REPOSITORY_ROOT'); }
  const commit = await git(canonical, ['rev-parse', '--verify', 'HEAD']);
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) { throw Error('HARNESS_WORKTREE_HEAD_UNAVAILABLE'); }
  await fs.mkdir(storage, { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(storage);
  const id = randomUUID();
  const target = path.join(parent, 'wt-' + id);
  try {
    await git(canonical, ['worktree', 'add', '--detach', target, commit]);
    const linked = await fs.realpath(target);
    if (linked !== target) { throw Error('HARNESS_WORKTREE_PATH_CHANGED'); }
    return { root: linked, parent: canonical, id };
  } catch (error) {
    // Leave a partially-created worktree for explicit repair; never force-remove user content.
    throw error;
  }
}

export async function removeCleanAgentWorktree(worktree: ManagedWorktree): Promise<void> {
  const root = await fs.realpath(worktree.root);
  if (root !== worktree.root) { throw Error('HARNESS_WORKTREE_PATH_CHANGED'); }
  const parent = await fs.realpath(worktree.parent);
  if (parent !== worktree.parent) { throw Error('HARNESS_WORKTREE_ROOT_CHANGED'); }
  const status = await git(root, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all']);
  if (status.length) { throw Error('HARNESS_WORKTREE_DIRTY'); }
  await git(parent, ['worktree', 'remove', root]);
}


/** Enumerate only names provisioned by this Harness. Never follow symlinked entries. */
export async function listAgentWorktrees(parent: string, storage: string): Promise<ManagedWorktree[]> {
  const canonical = await fs.realpath(parent);
  let entries;
  try { entries = await fs.readdir(storage, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
  if (entries.length > 500) { throw Error('HARNESS_WORKTREE_LIST_TOO_LARGE'); }
  const canonicalStorage = await fs.realpath(storage);
  const worktrees: ManagedWorktree[] = [];
  for (const entry of entries) {
    const match = /^wt-([a-f0-9-]{36})$/i.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) { continue; }
    const target = path.join(canonicalStorage, entry.name);
    if (await fs.realpath(target) !== target) { throw Error('HARNESS_WORKTREE_PATH_CHANGED'); }
    worktrees.push({ id: match[1], root: target, parent: canonical });
  }
  return worktrees.sort((a, b) => a.id.localeCompare(b.id));
}
