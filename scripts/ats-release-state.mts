/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

/** Fingerprint complete outputs, including names; never follow distribution symlinks. */
async function fingerprint(files: string[]): Promise<string> {
	const hash = createHash('sha256');
	async function visit(file: string): Promise<void> {
		const info = await lstat(file);
		hash.update(JSON.stringify([file, info.isDirectory() ? 'directory' : 'file']));
		if (info.isDirectory()) {
			for (const entry of (await readdir(file)).sort()) { await visit(path.join(file, entry)); }
		} else if (info.isFile()) {
			const content = createHash('sha256');
			for await (const chunk of createReadStream(file)) { content.update(chunk); }
			hash.update(content.digest());
		} else { throw new Error(`Unsupported release output: ${file}`); }
	}
	for (const file of files) { await visit(file); }
	return hash.digest('hex');
}

/** Cache only completed stages for this exact source/runtime identity and unchanged outputs. */
export async function releaseStages(directory: string, identity: string) {
	const file = path.join(directory, 'checkpoint.json');
	let stages: Record<string, string> = {};
	try {
		const previous = JSON.parse(await readFile(file, 'utf8'));
		if (previous.schema === 1 && previous.identity === identity && previous.stages && typeof previous.stages === 'object' && !Array.isArray(previous.stages)) { stages = previous.stages; }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
	}
	async function save() {
		await mkdir(directory, { recursive: true });
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify({ schema: 1, identity, stages }) + '\n', { flag: 'wx' });
			await rename(temporary, file);
		} finally { await rm(temporary, { force: true }); }
	}
	return async (name: string, outputs: string[], work: () => Promise<void>): Promise<void> => {
		if (Object.hasOwn(stages, name)) {
			try {
				if (stages[name] === await fingerprint(outputs)) { console.log(`Reusing verified stage: ${name}`); return; }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
			}
		}
		delete stages[name]; await save();
		await work();
		stages[name] = await fingerprint(outputs); await save();
	};
}
