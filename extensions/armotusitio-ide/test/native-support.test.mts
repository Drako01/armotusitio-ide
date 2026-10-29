/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSupportReport, exportSupportReport, assertSupportSchema } from '../src/native-support.ts';

test('support evidence omits output, instructions and absolute root', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-evidence-'));
	try {
		const engine = {
			diagnose: async () => ({ lock: 'none' }),
			list: async () => [{ id: 'task01', createdAt: '2026-01-01', title: 'secret title',
				attempts: [{ id: 'attempt1', status: 'passed', approval: 'private-token',
					results: [{ id: 'gate', status: 'passed', exitCode: 0, output: 'password=secret' }] }] }],
		};
		const report = await buildSupportReport(root, engine as never);
		const serialized = JSON.stringify(report);
		assert.ok(!serialized.includes('secret'));
		assert.ok(!serialized.includes(root));
		assert.equal(report.tasks[0].attempts[0].results[0].exitCode, 0);
		const dest = path.join(root, 'report.json');
		await exportSupportReport(dest, report);
		assert.deepEqual(JSON.parse(await fs.readFile(dest, 'utf8')), report);
		await assert.rejects(exportSupportReport(dest, report), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EEXIST');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('future support schema fails closed', () => {
	assert.throws(() => assertSupportSchema({ schemaVersion: 2 }), /HARNESS_SUPPORT_INCOMPATIBLE_SCHEMA/);
});
