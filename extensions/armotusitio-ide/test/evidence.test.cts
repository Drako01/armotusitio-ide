/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readEvidence, logReference } = require('../src/evidence.ts');

test('evidence reads a bounded native log and rejects arbitrary relative or absolute paths', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-evidence-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(path.join(root, '.harness/logs'), { recursive: true });
	await fs.writeFile(path.join(root, '.harness/logs/gate.log'), 'x'.repeat(100000) + '\nresult');
	const text = await readEvidence(root, '.harness/logs/gate.log');
	assert.ok(Buffer.byteLength(text) <= 65536);
	assert.equal(text.endsWith('result'), true);
	for (const relative of ['../outside.log', '/absolute.log', '.harness/logs/../../.env', '.harness/logs/.env']) {
		assert.equal(logReference(relative), false);
		await assert.rejects(readEvidence(root, relative), /HARNESS_EVIDENCE/);
	}
});
