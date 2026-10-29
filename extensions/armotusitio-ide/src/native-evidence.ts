/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface EvidenceFingerprint {
	schemaVersion: 1;
	planRevision: string;
	inputs: Array<{ relativePath: string; sha256: string }>;
}
export interface EvidenceRecord {
	schemaVersion: 1;
	fingerprint: string;
	taskId: string;
	attemptId: string;
	status: 'passed' | 'failed' | 'cancelled' | 'interrupted';
	recordedAt: string;
}
const MAX_INPUTS = 64;
const MAX_FILE = 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9_-]{1,100}$/i;

export async function fingerprintEvidence(root: string, planRevision: string, files: string[]): Promise<EvidenceFingerprint> {
	if (!HEX.test(planRevision) || files.length > MAX_INPUTS || new Set(files).size !== files.length) {
		throw Error('HARNESS_EVIDENCE_INPUTS');
	}
	const canonical = await fs.realpath(root);
	const inputs: EvidenceFingerprint['inputs'] = [];
	for (const relativePath of files.sort()) {
		if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some(part => part === '..' || part === '.' || part === '')) {
			throw Error('HARNESS_EVIDENCE_PATH');
		}
		const target = path.resolve(canonical, relativePath);
		const relative = path.relative(canonical, target);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { throw Error('HARNESS_EVIDENCE_ESCAPE'); }
		const parts = relative.split(path.sep);
		let cursor = canonical;
		for (const segment of parts) {
			cursor = path.join(cursor, segment);
			const entry = await fs.lstat(cursor);
			if (entry.isSymbolicLink()) { throw Error('HARNESS_EVIDENCE_SYMLINK'); }
		}
		const stat = await fs.stat(target);
		if (!stat.isFile() || stat.size > MAX_FILE) { throw Error('HARNESS_EVIDENCE_SIZE'); }
		inputs.push({ relativePath, sha256: createHash('sha256').update(await fs.readFile(target)).digest('hex') });
	}
	return { schemaVersion: 1, planRevision, inputs };
}

export function evidenceKey(fingerprint: EvidenceFingerprint): string {
	if (fingerprint.schemaVersion !== 1 || !HEX.test(fingerprint.planRevision) || !Array.isArray(fingerprint.inputs) || fingerprint.inputs.length > MAX_INPUTS
		|| !fingerprint.inputs.every(x => typeof x.relativePath === 'string' && HEX.test(x.sha256))) {
		throw Error('HARNESS_EVIDENCE_SCHEMA');
	}
	return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}

/** Advisory metadata only: never authorizes, skips, or retries a task. */
export async function saveEvidenceMetadata(storage: string, fingerprint: EvidenceFingerprint, record: Omit<EvidenceRecord, 'schemaVersion' | 'fingerprint' | 'recordedAt'>): Promise<void> {
	if (!IDENTIFIER.test(record.taskId) || !IDENTIFIER.test(record.attemptId) || !['passed', 'failed', 'cancelled', 'interrupted'].includes(record.status)) {
		throw Error('HARNESS_EVIDENCE_RECORD');
	}
	const key = evidenceKey(fingerprint);
	const target = path.join(storage, `${key}.json`);
	await fs.mkdir(storage, { recursive: true });
	const payload: EvidenceRecord = { schemaVersion: 1, fingerprint: key, ...record, recordedAt: new Date().toISOString() };
	const temp = `${target}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temp, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
		await fs.rename(temp, target);
	} finally {
		await fs.rm(temp, { force: true });
	}
}

export async function readEvidenceMetadata(storage: string, fingerprint: EvidenceFingerprint): Promise<EvidenceRecord | undefined> {
	const key = evidenceKey(fingerprint);
	const target = path.join(storage, `${key}.json`);
	let stat;
	try { stat = await fs.lstat(target); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) { throw Error('HARNESS_EVIDENCE_FILE'); }
	const data: unknown = JSON.parse(await fs.readFile(target, 'utf8'));
	if (!data || typeof data !== 'object' || (data as EvidenceRecord).schemaVersion !== 1 || (data as EvidenceRecord).fingerprint !== key
		|| !IDENTIFIER.test((data as EvidenceRecord).taskId) || !IDENTIFIER.test((data as EvidenceRecord).attemptId)) {
		throw Error('HARNESS_EVIDENCE_INCOMPATIBLE');
	}
	return data as EvidenceRecord;
}
