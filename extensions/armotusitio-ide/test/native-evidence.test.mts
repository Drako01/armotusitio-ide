/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fingerprintEvidence, evidenceKey, saveEvidenceMetadata, readEvidenceMetadata } from '../src/native-evidence.ts';

test('evidence fingerprint changes with file contents and plan revision', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-evidence-'));
	try {
		await fs.writeFile(path.join(root, 'sample.txt'), 'alpha');
		const first = await fingerprintEvidence(root, 'a'.repeat(64), ['sample.txt']);
		const storage = path.join(root, 'evidence');
		await saveEvidenceMetadata(storage, first, { taskId: 'task1', attemptId: 'attempt1', status: 'passed' });
		assert.equal((await readEvidenceMetadata(storage, first))?.status, 'passed');
		await fs.writeFile(path.join(root, 'sample.txt'), 'beta');
		const second = await fingerprintEvidence(root, 'a'.repeat(64), ['sample.txt']);
		assert.notEqual(evidenceKey(first), evidenceKey(second));
		assert.equal(await readEvidenceMetadata(storage, second), undefined);
		assert.notEqual(evidenceKey(first), evidenceKey(await fingerprintEvidence(root, 'b'.repeat(64), ['sample.txt'])));
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rejects traversal, duplicated inputs and linked files', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-evidence-'));
	try {
		await fs.writeFile(path.join(root, 'file.txt'), 'safe');
		await assert.rejects(fingerprintEvidence(root, 'a'.repeat(64), ['../bad']), /HARNESS_EVIDENCE_PATH/);
		await assert.rejects(fingerprintEvidence(root, 'a'.repeat(64), ['file.txt', 'file.txt']), /HARNESS_EVIDENCE_INPUTS/);
		await fs.symlink(path.join(root, 'file.txt'), path.join(root, 'linked.txt'));
		await assert.rejects(fingerprintEvidence(root, 'a'.repeat(64), ['linked.txt']), /HARNESS_EVIDENCE_SYMLINK/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rejects incompatible persisted evidence without modifying its content', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-evidence-'));
	try {
		const fingerprint = { schemaVersion: 1 as const, planRevision: 'a'.repeat(64), inputs: [] };
		await fs.writeFile(path.join(root, `${evidenceKey(fingerprint)}.json`), JSON.stringify({ schemaVersion: 2 }));
		await assert.rejects(readEvidenceMetadata(root, fingerprint), /HARNESS_EVIDENCE_INCOMPATIBLE/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
