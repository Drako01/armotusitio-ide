/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Run-long integrity of the files the agent could rewrite to widen its own authority (plan r6, review M2): the project's
 * permission file is fixed when the run starts and every later change is a refusal, never a silent re-read.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** sha256 of the project permission file, `absent` when there is none and `unreadable` when it cannot be read. */
export async function projectPermissionsDigest(root: string): Promise<string> {
	try {
		const directory = path.join(root, '.armotusitio');
		const file = path.join(directory, 'permissions.json');
		if ((await fs.lstat(directory)).isSymbolicLink()) { return 'unreadable'; }
		const stat = await fs.lstat(file);
		if (!stat.isFile() || stat.size > 16 * 1024) { return 'unreadable'; }
		return createHash('sha256').update(await fs.readFile(file)).digest('hex');
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
	}
}
