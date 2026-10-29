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
	if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as SupportReport).schemaVersion !== SUPPORT_SCHEMA_VERSION) { throw Error('HARNESS_SUPPORT_INCOMPATIBLE_SCHEMA'); }
	const report = raw as SupportReport;
	const id = (value: string): boolean => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
	const date = (value: string): boolean => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
	if (report.engine !== 'ide-native' || !date(report.generatedAt) || !/^[a-f0-9]{20}$/.test(report.projectKey) || !['present', 'absent'].includes(report.configuration) || !['none', 'active', 'stale', 'unknown'].includes(report.lock)
		|| !Array.isArray(report.tasks) || report.tasks.length > 250 || !report.tasks.every(task => task && id(task.id) && date(task.createdAt) && Array.isArray(task.attempts) && task.attempts.length <= 25 && task.attempts.every(attempt => attempt && id(attempt.id) && ['running', 'passed', 'failed', 'interrupted', 'cancelled'].includes(attempt.status) && Array.isArray(attempt.results) && attempt.results.length <= 64 && attempt.results.every(result => result && id(result.id) && ['passed', 'failed', 'cancelled'].includes(result.status) && (result.exitCode === null || Number.isSafeInteger(result.exitCode)))))) { throw Error('HARNESS_SUPPORT_INVALID_REPORT'); }
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
	// Project only the support contract; extra caller properties must never enter exports.
	const safe: SupportReport = { schemaVersion: 1, generatedAt: report.generatedAt, projectKey: report.projectKey, engine: report.engine, configuration: report.configuration, lock: report.lock, tasks: report.tasks.map(task => ({ id: task.id, createdAt: task.createdAt, attempts: task.attempts.map(attempt => ({ id: attempt.id, status: attempt.status, results: attempt.results.map(result => ({ id: result.id, status: result.status, exitCode: result.exitCode })) })) })) };
	const payload = JSON.stringify(safe, null, 2) + '\n';
	if (Buffer.byteLength(payload) > MAX_REPORT_BYTES) { throw Error('HARNESS_SUPPORT_TOO_LARGE'); }
	const handle = await fs.open(target, 'wx', 0o600);
	try { await handle.writeFile(payload, 'utf8'); }
	finally { await handle.close(); }
}
