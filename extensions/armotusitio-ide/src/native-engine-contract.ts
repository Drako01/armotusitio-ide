/*---------------------------------------------------------------------------------------------
 * Copyright (c) ArmoTuSitio contributors. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
/** Conservative v2 capability contract. A project runner is never executed merely to inspect it. */
import { inspectHarnessAuthority } from './native-authority.ts';

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

export async function describeEngine(root: string): Promise<EngineCapabilities> {
  const authority = await inspectHarnessAuthority(root);
  const isProject = authority.engine === 'project';
  // Never infer project features from the presence of a directory. Only an explicit
  // versioned handshake can extend the supported set in a future protocol adapter.
  const supported = isProject ? [] : VERIFIED_NATIVE;
  return {
    schemaVersion: ENGINE_CONTRACT_VERSION,
    engine: authority.engine,
    authority: isProject ? 'project' : 'ide',
    supported: [...supported],
    unavailable: ALL.filter(capability => !supported.includes(capability)),
    requiresExternalHandshake: isProject,
    executionEnabled: !isProject
  };
}
