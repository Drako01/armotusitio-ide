/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Path equality as the host file system defines it. Windows paths are case-insensitive and VS Code
 * reports `Uri.fsPath` with a lower-case drive letter, while `fs.realpath` returns an upper-case one.
 */
export function samePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** True when `directory` resolves to itself: no symlinked or junctioned ancestor redirects it elsewhere. */
export async function isCanonicalDirectory(directory: string): Promise<boolean> {
	return samePath(await fs.realpath(directory), path.resolve(directory));
}
