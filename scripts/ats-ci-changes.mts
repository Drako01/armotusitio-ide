/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Inputs that can change the Harness, packaged product, updater or its validation. */
export function isAtsInput(file: string): boolean {
	return /^(extensions\/armotusitio-ide\/|extensions\/[^/]+\/package(-lock)?\.json$|scripts\/ats-|release\.sh$|\.github\/workflows\/ats-|package(-lock)?\.json$|pnpm-(lock|workspace)\.yaml$|\.pnpmfile\.mjs$|product\.json$|\.nvmrc$|\.npmrc$|build\/|remote\/(package(-lock)?\.json|pnpm-(lock|workspace)\.yaml|\.pnpmfile\.mjs|\.npmrc)$|resources\/(win32|linux|darwin)\/|src\/vs\/platform\/update\/|src\/vs\/workbench\/contrib\/update\/)/.test(file);
}

/** Validate the complete paginated API result; a renamed packaging input remains material. */
export function classifyAtsChanges(pages: unknown, expectedCount: number): boolean {
	if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || !Array.isArray(pages)
		|| pages.some(page => !Array.isArray(page))) {
		throw new Error('Invalid change detection response or expected file count.');
	}
	const files: unknown[] = pages.flat();
	if (files.length !== expectedCount) {
		throw new Error('Incomplete changed-files response; refusing to skip ATS contracts.');
	}
	const names = new Set<string>();
	let relevant = false;
	for (const file of files) {
		if (!file || typeof file !== 'object' || !('filename' in file) || typeof file.filename !== 'string'
			|| !file.filename || names.has(file.filename)
			|| ('previous_filename' in file && typeof file.previous_filename !== 'string')) {
			throw new Error('Malformed or duplicate changed file.');
		}
		names.add(file.filename);
		relevant = relevant || isAtsInput(file.filename)
			|| ('previous_filename' in file && typeof file.previous_filename === 'string' && isAtsInput(file.previous_filename));
	}
	return relevant;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [file, count, ...extra] = process.argv.slice(2);
		if (!file || !count || extra.length || !process.env.GITHUB_OUTPUT) {
			throw new Error('Usage: ats-ci-changes.mts <paginated-files.json> <expected-count>, with GITHUB_OUTPUT.');
		}
		const relevant = classifyAtsChanges(JSON.parse(await readFile(file, 'utf8')), Number(count));
		await appendFile(process.env.GITHUB_OUTPUT, `relevant=${relevant}\n`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'ATS change detection failed.');
		process.exitCode = 1;
	}
}
