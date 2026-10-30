/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
/** Explicitly approved, bounded agent CLI execution. No shell, no bypass-permissions modes. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveNativeCommand } from './native-runtime.ts';
import { reviewAgentDraft, validateReviewedAgent, type AgentDraft, type AgentReview } from './native-providers.ts';

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_DURATION_MS = 30 * 60 * 1000;
const AUTH_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
export interface AgentInvocation { executable: 'codex' | 'claude'; args: string[]; stdin: string; }
export interface AgentOutcome { status: 'passed' | 'failed' | 'cancelled' | 'timeout'; exitCode: number | null; durationMs: number; output: string; truncated: boolean; }
export interface AgentExecution { outcome: Promise<AgentOutcome>; cancel(): void; }

export function buildAgentInvocation(draft: AgentDraft): AgentInvocation {
  reviewAgentDraft(draft);
  if (draft.role !== 'implementer' && !draft.readOnly) { throw Error('HARNESS_READ_ONLY_ROLE_REQUIRED'); }
  if (draft.role === 'implementer' && draft.readOnly) { throw Error('HARNESS_IMPLEMENTER_MODE_MISMATCH'); }
  const instruction = [
    'You are a scoped software engineering agent. Operate only in the supplied project root.',
    'Do not commit, push, publish, deploy, modify secrets or alter files outside the project.',
    draft.role === 'implementer'
      ? 'Make only changes required by the instruction; report files touched and validation.'
      : 'This is a read-only assignment. Do not modify project files.',
    draft.instruction
  ].join('\n\n');
  if (draft.provider === 'codex') {
    return {
      executable: 'codex',
      args: ['exec', '--sandbox', draft.readOnly ? 'read-only' : 'workspace-write', '--skip-git-repo-check', '-'],
      stdin: instruction
    };
  }
  // dontAsk denies tools that are not explicitly allowed, rather than silently bypassing permissions.
  // plan mode is strictly read-only; don'tAsk is fail-closed if required tools lack an allow rule.
  return {
    executable: 'claude',
    args: ['--print', '--permission-mode', draft.readOnly ? 'plan' : 'dontAsk', '--max-turns', '12', '--output-format', 'text'],
    stdin: instruction
  };
}

function redactOutput(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED]');
}

function stopProcess(child: ChildProcess): void {
  if (!child.pid) { return; }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { /* Cannot terminate unavailable process. */ });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* exited */ } }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* exited */ }
    }, 1500);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
}

/** Caller MUST verify Workspace Trust, project authority and consent immediately before invoking. */
export async function executeReviewedAgent(review: AgentReview, current: AgentDraft, durationMs = MAX_DURATION_MS): Promise<AgentExecution> {
  validateReviewedAgent(review, current);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > MAX_DURATION_MS) { throw Error('HARNESS_AGENT_TIMEOUT_INVALID'); }
  const canonical = await fs.realpath(current.projectRoot);
  if (canonical !== current.projectRoot || !(await fs.stat(canonical)).isDirectory()) { throw Error('HARNESS_AGENT_ROOT_CHANGED'); }
  const invocation = buildAgentInvocation(current);
  const command = await resolveNativeCommand(invocation.executable, invocation.args);
  const env: NodeJS.ProcessEnv = {};
  for (const key of AUTH_ENV) { if (process.env[key]) { env[key] = process.env[key]; } }
  if (command.embeddedNode) { env.ELECTRON_RUN_AS_NODE = '1'; }
  const started = Date.now();
  let cancelled = false, timedOut = false, truncated = false;
  let output = '', size = 0;
  const child = spawn(command.executable, command.args, {
    cwd: canonical, env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const cancel = (): void => { cancelled = true; stopProcess(child); };
  const collect = (chunk: Buffer): void => {
    size += chunk.length;
    if (size > MAX_OUTPUT_BYTES) { truncated = true; cancel(); return; }
    output += chunk.toString('utf8');
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const outcome = new Promise<AgentOutcome>(resolve => {
    const timer = setTimeout(() => { timedOut = true; cancel(); }, durationMs);
    timer.unref();
    let ended = false;
    const finish = (exitCode: number | null): void => {
      if (ended) { return; }
      ended = true; clearTimeout(timer);
      resolve({ status: timedOut ? 'timeout' : cancelled ? 'cancelled' : exitCode === 0 ? 'passed' : 'failed',
        exitCode, durationMs: Date.now() - started, truncated, output: redactOutput(output) });
    };
    child.once('error', () => finish(null));
    child.once('close', finish);
  });
  child.stdin?.on('error', () => { /* The provider may exit before consuming the prompt. */ });
  child.stdin?.end(invocation.stdin);
  return { cancel, outcome };
}
