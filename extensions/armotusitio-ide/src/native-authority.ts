/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface HarnessAuthority {
	engine: 'project' | 'ide-native';
	entry?: '.harness/core.mts' | '.harness/core.mjs' | 'harness/scripts/ide.mjs';
	reason: 'project-entry' | 'project-marker' | 'project-path-unsafe' | 'no-project-harness';
}

/** Folder holding a project Harness' manifests: `harness/` for the ArmoTuSitio layout, `.harness/` for every other one. */
export function harnessDirectory(entry: HarnessAuthority['entry']): 'harness' | '.harness' {
	return entry?.startsWith('harness/') ? 'harness' : '.harness';
}

/** Detection never executes a producer. Unknown or unsafe project Harnesses retain authority. */
export async function inspectHarnessAuthority(root: string): Promise<HarnessAuthority> {
	const canonical = await fs.realpath(root);
	let marker = false;
	for (const name of ['.harness', 'harness']) {
		try {
			const info = await fs.lstat(path.join(canonical, name));
			marker = true;
			if (!info.isDirectory() || info.isSymbolicLink()) { return { engine: 'project', reason: 'project-path-unsafe' }; }
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
	}
	for (const entry of ['.harness/core.mts', '.harness/core.mjs', 'harness/scripts/ide.mjs'] as const) {
		try {
			const target = path.join(canonical, entry);
			const info = await fs.lstat(target);
			if (!info.isFile() || info.isSymbolicLink() || await fs.realpath(target) !== target) { return { engine: 'project', reason: 'project-path-unsafe' }; }
			return { engine: 'project', entry, reason: 'project-entry' };
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
	}
	return marker ? { engine: 'project', reason: 'project-marker' } : { engine: 'ide-native', reason: 'no-project-harness' };
}
