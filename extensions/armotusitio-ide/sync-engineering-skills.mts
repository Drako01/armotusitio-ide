/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Reproducible, dependency-free metadata index. Skill bodies remain the single source of truth. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ENGINEERING_SKILL_NAMES } from './src/native-engineering-skills.ts';

const directory = path.join(import.meta.dirname, 'resources', 'engineering-skills');
const skills = [];
for (const name of ENGINEERING_SKILL_NAMES) {
	const file = path.join(directory, name, 'SKILL.md');
	const data = await fs.readFile(file);
	const text = data.toString('utf8');
	const metadata = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n/.exec(text);
	if (!metadata || metadata[1] !== name || metadata[2].length > 500 || data.length > 10 * 1024 || text.includes('\u0000')) { throw Error('HARNESS_NATIVE_SKILL_CONTENT_INVALID: ' + name); }
	skills.push({ name, source: 'native', description: metadata[2], digest: createHash('sha256').update(data).digest('hex') });
}
const expected = JSON.stringify({ version: 1, skills }, null, '\t') + '\n';
const index = path.join(directory, 'catalog.json');
if (process.argv.includes('--write')) { await fs.writeFile(index, expected); }
else if (await fs.readFile(index, 'utf8') !== expected) { throw Error('HARNESS_NATIVE_SKILL_INDEX_STALE: run node sync-engineering-skills.mts --write'); }
process.stdout.write('Native engineering skill index: PASS (10 skills)\n');
