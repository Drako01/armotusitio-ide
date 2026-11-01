/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hasRecoveryHint, recoveryHint } from '../src/native-error-catalog.ts';

test('every HARNESS_* code in the sources has its own recovery hint, never the generic fallback', async () => {
	const source = path.join(import.meta.dirname, '..', 'src');
	const codes = new Set<string>();
	for (const file of await fs.readdir(source)) {
		if (!file.endsWith('.ts')) { continue; }
		// Complete codes only: prefixes such as 'HARNESS_PROVIDER_' are built into full codes elsewhere.
		for (const match of (await fs.readFile(path.join(source, file), 'utf8')).matchAll(/'(HARNESS_[A-Z_]*[A-Z])'/g)) { codes.add(match[1]); }
	}
	codes.delete('HARNESS_OPERATION_FAILED');
	const missing = [...codes].filter(code => !hasRecoveryHint(code)).sort();
	assert.deepEqual({ missing, enough: codes.size > 200 }, { missing: [], enough: true });
	const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);
	assert.match(recoveryHint(t, 'HARNESS_PROVIDER_QUOTA_EXCEEDED'), /cupo local/);
	assert.match(recoveryHint(t, 'HARNESS_NOT_A_REAL_CODE'), /podés reintentar/);
});
