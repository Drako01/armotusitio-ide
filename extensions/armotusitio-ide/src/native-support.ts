/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { NativeHarness, Task } from './native-harness.ts';
import { loadProjectConfig } from './native-project.ts';

export const SUPPORT_SCHEMA_VERSION = 1;
const MAX_REPORT_BYTES = 512 * 1024;
type AttemptState = 'running' | 'passed' | 'failed' | 'interrupted' | 'cancelled';

export interface SupportReport {
	schemaVersion: 1;
	generatedAt: string;
	projectKey: string;
	engine: 'ide-native';
	configuration: 'present' | 'absent';
	lock: 'none' | 'active' | 'stale' | 'unknown';
	tasks: Array<{ id: string; createdAt: string; attempts: Array<{ id: string; status: AttemptState; results: Array<{ id: string; status: string; exitCode: number | null }> }> }>;
}

export function assertSupportSchema(raw: unknown): asserts raw is SupportReport {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { schemaVersion?: unknown }).schemaVersion !== SUPPORT_SCHEMA_VERSION) {
		throw Error('HARNESS_SUPPORT_INCOMPATIBLE_SCHEMA');
	}
}

function summarize(tasks: Task[]): SupportReport['tasks'] {
	return tasks.slice(0, 250).map(task => ({
		id: task.id, createdAt: task.createdAt,
		attempts: task.attempts.slice(-25).map(attempt => ({
			id: attempt.id, status: attempt.status,
			results: attempt.results.slice(0, 64).map(result => ({ id: result.id, status: result.status, exitCode: result.exitCode })),
		})),
	}));
}

export async function buildSupportReport(root: string, harness: NativeHarness): Promise<SupportReport> {
	const canonical = await fs.realpath(root);
	const [diagnostic, tasks, config] = await Promise.all([harness.diagnose(), harness.list(), loadProjectConfig(canonical)]);
	const report: SupportReport = {
		schemaVersion: 1, generatedAt: new Date().toISOString(),
		projectKey: createHash('sha256').update(canonical).digest('hex').slice(0, 20),
		engine: 'ide-native', configuration: config ? 'present' : 'absent',
		lock: diagnostic.lock, tasks: summarize(tasks),
	};
	if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES) { throw Error('HARNESS_SUPPORT_TOO_LARGE'); }
	return report;
}

export async function exportSupportReport(target: string, report: SupportReport): Promise<void> {
	assertSupportSchema(report);
	if (path.extname(target).toLowerCase() !== '.json') { throw Error('HARNESS_SUPPORT_EXTENSION'); }
	const payload = JSON.stringify(report, null, 2) + '\n';
	if (Buffer.byteLength(payload) > MAX_REPORT_BYTES) { throw Error('HARNESS_SUPPORT_TOO_LARGE'); }
	const handle = await fs.open(target, 'wx', 0o600);
	try { await handle.writeFile(payload, 'utf8'); }
	finally { await handle.close(); }
}
