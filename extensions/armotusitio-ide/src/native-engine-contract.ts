/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
/** Conservative v2 capability contract. A project runner is never executed merely to inspect it. */
import { inspectHarnessAuthority } from './native-authority.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const ENGINE_CONTRACT_VERSION = 2 as const;
export type Capability =
  | 'verification-gates' | 'durable-tasks' | 'durable-workflows' | 'provider-execution'
  | 'agent-handoffs' | 'reconciliation' | 'bounded-processes' | 'parallel-gates'
  | 'worktree-isolation' | 'os-sandbox' | 'network-policy' | 'token-accounting'
  | 'cost-accounting' | 'autonomous-repair';
export interface EngineCapabilities {
  schemaVersion: typeof ENGINE_CONTRACT_VERSION;
  engine: 'ide-native' | 'project';
  authority: 'ide' | 'project';
  supported: Capability[];
  projectDeclared?: Capability[];
  unavailable: Capability[];
  requiresExternalHandshake: boolean;
  executionEnabled: boolean;
}

const ALL: Capability[] = [
  'verification-gates', 'durable-tasks', 'durable-workflows', 'provider-execution',
  'agent-handoffs', 'reconciliation', 'bounded-processes', 'parallel-gates',
  'worktree-isolation', 'os-sandbox', 'network-policy', 'token-accounting',
  'cost-accounting', 'autonomous-repair'
];
const VERIFIED_NATIVE: Capability[] = [
  'verification-gates', 'durable-tasks', 'durable-workflows', 'provider-execution',
  'agent-handoffs', 'reconciliation', 'bounded-processes', 'parallel-gates', 'worktree-isolation'
];

/** Read-only disclosure; a declaration never grants execution authority or counts as verified support. */
export async function readProjectCapabilities(root: string): Promise<Capability[]> {
  const canonical = await fs.realpath(root);
  if (canonical !== root) { throw Error('HARNESS_CAPABILITIES_ROOT_CHANGED'); }
  const directory = path.join(canonical, '.harness', 'manifests');
  const target = path.join(directory, 'ide-capabilities.json');
  let info;
  try { info = await fs.lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 ||
    (await fs.realpath(directory)) !== directory || (await fs.realpath(target)) !== target) {
    throw Error('HARNESS_CAPABILITIES_UNSAFE');
  }
  const value: unknown = JSON.parse(await fs.readFile(target, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw Error('HARNESS_CAPABILITIES_INVALID'); }
  const manifest = value as { schemaVersion?: number; engine?: string; capabilities?: unknown };
  if (manifest.schemaVersion !== ENGINE_CONTRACT_VERSION || manifest.engine !== 'project' ||
    !Array.isArray(manifest.capabilities) || manifest.capabilities.length > ALL.length ||
    !manifest.capabilities.every(c => typeof c === 'string' && ALL.includes(c as Capability)) ||
    new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    throw Error('HARNESS_CAPABILITIES_INVALID');
  }
  return manifest.capabilities as Capability[];
}

export async function describeEngine(root: string): Promise<EngineCapabilities> {
  const authority = await inspectHarnessAuthority(root);
  const isProject = authority.engine === 'project';
  // Never infer project features from the presence of a directory. Only an explicit
  // versioned handshake can extend the supported set in a future protocol adapter.
  const supported = isProject ? [] : VERIFIED_NATIVE;
  const projectDeclared = isProject ? await readProjectCapabilities(root) : undefined;
  return {
    schemaVersion: ENGINE_CONTRACT_VERSION,
    engine: authority.engine,
    authority: isProject ? 'project' : 'ide',
    supported: [...supported],
    projectDeclared,
    unavailable: ALL.filter(capability => !supported.includes(capability)),
    requiresExternalHandshake: isProject,
    executionEnabled: !isProject
  };
}
