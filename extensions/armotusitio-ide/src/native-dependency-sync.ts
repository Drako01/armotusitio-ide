/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Dependencies synchronized by the IDE before a run (block B, decision D5): only from lockfiles and without install scripts
 * (third-party code outside any sandbox). Once synchronized, the agent's commands run with each toolchain's offline mode.
 */
import * as path from 'node:path';
import type { Subproject } from './native-ecosystems.ts';
import { pathExists as exists } from './native-toolchain-env.ts';

export interface SyncCommand { command: string; args: string[]; cwd: string; cacheOnly: boolean }

/**
 * The lockfile-respecting install of each subproject. `cacheOnly` commands fill a shared cache and never touch the
 * project folder, so they are safe in the user's own checkout; the others populate the folder (a delivery worktree).
 */
export async function syncCommands(root: string, subprojects: readonly Subproject[]): Promise<SyncCommand[]> {
	const commands: SyncCommand[] = [];
	for (const project of subprojects) {
		const folder = path.join(root, project.path);
		const cwd = project.path;
		switch (project.ecosystem) {
			case 'go': if (await exists(path.join(folder, 'go.sum'))) { commands.push({ command: 'go', args: ['mod', 'download'], cwd, cacheOnly: true }); } break;
			case 'rust': if (await exists(path.join(folder, 'Cargo.lock'))) { commands.push({ command: 'cargo', args: ['fetch', '--locked'], cwd, cacheOnly: true }); } break;
			case 'node': {
				const manager = project.packageManager ?? 'npm';
				const locked = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lockb' }[manager];
				if (!await exists(path.join(folder, locked)) && !(manager === 'bun' && await exists(path.join(folder, 'bun.lock')))) { break; }
				const args = { npm: ['ci', '--ignore-scripts'], pnpm: ['install', '--frozen-lockfile', '--ignore-scripts'], yarn: ['install', '--immutable', '--mode=skip-build'], bun: ['install', '--frozen-lockfile', '--ignore-scripts'] }[manager];
				commands.push({ command: manager, args, cwd, cacheOnly: false });
				break;
			}
			case 'dotnet': if (await exists(path.join(folder, 'packages.lock.json'))) { commands.push({ command: 'dotnet', args: ['restore', '--locked-mode'], cwd, cacheOnly: false }); } break;
			case 'python': if (await exists(path.join(folder, 'uv.lock'))) { commands.push({ command: 'uv', args: ['sync', '--frozen'], cwd, cacheOnly: false }); } break;
			case 'php': if (await exists(path.join(folder, 'composer.lock'))) { commands.push({ command: 'composer', args: ['install', '--no-scripts', '--no-interaction'], cwd, cacheOnly: false }); } break;
			default: break;
		}
	}
	return commands;
}

/** Offline modes once dependencies are in place: a missing module is reported, never downloaded mid-run. */
export function offlineEnvironment(): Record<string, string> {
	return { GOFLAGS: '-mod=readonly', GOPROXY: 'off', npm_config_offline: 'true', CARGO_NET_OFFLINE: 'true', PIP_NO_INDEX: '1', UV_OFFLINE: '1', COMPOSER_DISABLE_NETWORK: '1' };
}
