/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { readFile, readdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import * as path from 'node:path';
import { Script } from 'node:vm';

// Parse every webview resource without executing browser code in Node.
const directory = path.join(import.meta.dirname, 'resources');
for (const name of await readdir(directory)) {
	if (!name.endsWith('.ts')) { continue; }
	const filename = path.join(directory, name);
	new Script(stripTypeScriptTypes(await readFile(filename, 'utf8'), { sourceUrl: filename }), { filename });
}
