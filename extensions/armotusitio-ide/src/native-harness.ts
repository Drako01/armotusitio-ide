/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Native, project-independent Harness service owned by ArmoTuSitio IDE. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';

export type Gate = { id: string; executable: string; args: string[]; cwd?: string; timeoutMs?: number; dependsOn?: string[] };
export type Plan = { schemaVersion: 1; gates: Gate[] };
export type GateResult = { id: string; exitCode: number | null; status: 'passed' | 'failed' | 'cancelled'; output: string; startedAt: string; endedAt: string };
export type Attempt = { id: string; startedAt: string; endedAt?: string; status: 'running' | 'passed' | 'failed' | 'interrupted' | 'cancelled'; results: GateResult[]; revision: string; approval: string };
export type Task = { schemaVersion: 1; id: string; title: string; createdAt: string; plan: Plan; revision: string; attempts: Attempt[] };
export type Progress = { task: Task; active: boolean; reconciliationRequired: boolean };
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const EXEC = /^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,99}$/;
const MAX_OUTPUT = 64 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_MS = 10 * 60 * 1000;
const ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];
function assertId(id: string): void { if (typeof id !== 'string' || !ID.test(id)) { throw Error('HARNESS_INVALID_ID'); } }
export function nativePlanRevision(plan: Plan): string { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }
export function approvalDigest(plan: Plan, project: string): string { return createHash('sha256').update(JSON.stringify([nativePlanRevision(plan), project])).digest('hex'); }
export function validateNativePlan(plan: Plan): void {
	if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.gates) || plan.gates.length === 0 || plan.gates.length > 64) { throw Error('HARNESS_PLAN_SCHEMA'); }
	const seen = new Map<string, Gate>();
	for (const gate of plan.gates) {
		assertId(gate.id); if (seen.has(gate.id)) { throw Error('HARNESS_DUPLICATE_GATE'); } seen.set(gate.id, gate);
		if (!EXEC.test(gate.executable) || !Array.isArray(gate.args) || gate.args.length > 64 || !gate.args.every(a => typeof a === 'string' && a.length <= 4096 && !a.includes('\0')) || (gate.timeoutMs !== undefined && (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs < 100 || gate.timeoutMs > MAX_MS))) { throw Error('HARNESS_INVALID_COMMAND'); }
		if (gate.cwd !== undefined && (typeof gate.cwd !== 'string' || gate.cwd.length > 4096 || gate.cwd.includes('\0'))) { throw Error('HARNESS_INVALID_CWD'); }
		if (gate.dependsOn !== undefined && (!Array.isArray(gate.dependsOn) || !gate.dependsOn.every(x => typeof x === 'string'))) { throw Error('HARNESS_INVALID_DEPENDENCY'); }
	}
	const done = new Set<string>(), active = new Set<string>();
	const visit = (id: string): void => { if (active.has(id)) { throw Error('HARNESS_CYCLE'); } if (done.has(id)) { return; } const g = seen.get(id); if (!g) { throw Error('HARNESS_INVALID_DEPENDENCY'); } active.add(id); for (const d of g.dependsOn || []) { visit(d); } active.delete(id); done.add(id); };
	for (const id of seen.keys()) { visit(id); }
}
function redact(value: string): string {
	return value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
		.replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
		.slice(-MAX_OUTPUT);
}
async function writeAtomic(file: string, value: unknown): Promise<void> {
	const payload = JSON.stringify(value, null, 2);
	if (Buffer.byteLength(payload) > MAX_STATE_BYTES) { throw Error('HARNESS_STATE_TOO_LARGE'); }
	const tmp = `${file}.${randomUUID()}.tmp`;
	try { await fs.writeFile(tmp, payload, { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
	finally { await fs.rm(tmp, { force: true }); }
}
async function contained(root: string, cwd = '.'): Promise<string> {
	if (path.isAbsolute(cwd)) { throw Error('HARNESS_PATH_ABSOLUTE'); }
	const target = await fs.realpath(path.resolve(root, cwd));
	const rel = path.relative(root, target);
	if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) { throw Error('HARNESS_PATH_ESCAPE'); }
	return target;
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
export class NativeHarness {
	private readonly project: string; private readonly storage: string;
	private active = new Set<ChildProcess>(); private abortController?: AbortController;
	constructor(projectRoot: string, storageRoot: string) { this.project = projectRoot; this.storage = storageRoot; }
	private async root(): Promise<string> { return fs.realpath(this.project); }
	private file(id: string): string { assertId(id); return path.join(this.storage, 'tasks', `${id}.json`); }
	private lockFile(): string { return path.join(this.storage, 'execution.lock'); }
	async diagnose(): Promise<{ root: string; operations: string[]; requiresAI: false; lock: 'none' | 'active' | 'stale' | 'unknown' }> {
		await this.root(); let lock: 'none' | 'active' | 'stale' | 'unknown' = 'none';
		try { const info = JSON.parse(await fs.readFile(this.lockFile(), 'utf8')); lock = typeof info.pid === 'number' && info.pid > 0 && info.hostname === os.hostname() ? (processAlive(info.pid) ? 'active' : 'stale') : 'unknown'; }
		catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { lock = 'unknown'; } }
		return { root: await this.root(), operations: ['diagnose', 'create', 'list', 'status', 'execute', 'cancel', 'reconcile'], requiresAI: false, lock };
	}
	async create(title: string, plan: Plan): Promise<Task> {
		validateNativePlan(plan);
		if (typeof title !== 'string' || !title.trim() || title.length > 300) { throw Error('HARNESS_INVALID_TITLE'); }
		const root = await this.root(); for (const gate of plan.gates) { await contained(root, gate.cwd); }
		const task: Task = { schemaVersion: 1, id: randomUUID(), title, plan, revision: nativePlanRevision(plan), createdAt: new Date().toISOString(), attempts: [] };
		await fs.mkdir(path.join(this.storage, 'tasks'), { recursive: true });
		await fs.writeFile(this.file(task.id), JSON.stringify(task, null, 2), { flag: 'wx', mode: 0o600 });
		return task;
	}
	async get(id: string): Promise<Task> {
		const stat = await fs.lstat(this.file(id));
		if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STATE_BYTES) { throw Error('HARNESS_INVALID_TASK_FILE'); }
		const data = JSON.parse(await fs.readFile(this.file(id), 'utf8')) as Task;
		if (data.schemaVersion !== 1) { throw Error('HARNESS_INCOMPATIBLE_SCHEMA'); }
		if (data.id !== id || !Array.isArray(data.attempts) || data.attempts.length > 2048 || !data.attempts.every(a => a && typeof a.id === 'string' && ['running', 'passed', 'failed', 'interrupted', 'cancelled'].includes(a.status) && Array.isArray(a.results))) { throw Error('HARNESS_INVALID_TASK_STATE'); }
		validateNativePlan(data.plan); if (data.revision !== nativePlanRevision(data.plan)) { throw Error('HARNESS_PLAN_CHANGED'); }
		return data;
	}
	async list(): Promise<Task[]> {
		let names: string[]; try { names = await fs.readdir(path.join(this.storage, 'tasks')); }
		catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw e; }
		const tasks: Task[] = []; for (const name of names.filter(n => /^[a-z0-9_-]+\.json$/i.test(n))) { tasks.push(await this.get(name.slice(0, -5))); }
		return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
	async status(id: string): Promise<Progress> {
		const task = await this.get(id); const lock = await this.diagnose();
		const running = task.attempts.some(a => a.status === 'running');
		return { task, active: running && lock.lock === 'active', reconciliationRequired: running && lock.lock !== 'active' };
	}
	cancel(): void { this.abortController?.abort(); for (const child of this.active) { this.stopChild(child); } }
	private stopChild(child: ChildProcess): void {
		if (!child.pid) { return; }
		if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGTERM'); return; } catch { /* process may be gone */ } }
		else { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => { }); }
		try { child.kill('SIGTERM'); } catch { /* already stopped */ }
	}
	/** A stale lock is never silently stolen. Reconciliation requires an explicit operator decision. */
	async reconcile(): Promise<boolean> {
		if ((await this.diagnose()).lock !== 'stale') { return false; }
		const info = JSON.parse(await fs.readFile(this.lockFile(), 'utf8')) as { pid?: number; hostname?: string; attempt?: string; task?: string; startedAt?: string };
		if (info.hostname !== os.hostname() || !Number.isInteger(info.pid) || (info.pid ?? 0) <= 0) { throw Error('HARNESS_LOCK_UNCERTAIN'); }
		if (processAlive(info.pid!)) { throw Error('HARNESS_LOCK_ACTIVE'); }
		// Confirm ownership before modifying task state; a replaced lock must never authorize writes.
		const before = JSON.parse(await fs.readFile(this.lockFile(), 'utf8'));
		if (before.pid !== info.pid || before.hostname !== info.hostname || before.attempt !== info.attempt || before.task !== info.task || before.startedAt !== info.startedAt || processAlive(info.pid!)) { throw Error('HARNESS_LOCK_CHANGED'); }
		const tasks = await this.list();
		for (const task of tasks) {
			let changed = false;
			for (const attempt of task.attempts) { if (attempt.status === 'running') { attempt.status = 'interrupted'; attempt.endedAt = new Date().toISOString(); changed = true; } }
			if (changed) { await writeAtomic(this.file(task.id), task); }
		}
		// Reject a lock whose identity changed during reconciliation.
		const current = JSON.parse(await fs.readFile(this.lockFile(), 'utf8'));
		if (current.pid !== info.pid || current.hostname !== info.hostname || current.attempt !== info.attempt || current.task !== info.task || current.startedAt !== info.startedAt || processAlive(info.pid!)) { throw Error('HARNESS_LOCK_CHANGED'); }
		await fs.rm(this.lockFile()); return true;
	}
	async execute(id: string, approved: string, trust: () => boolean, signal?: AbortSignal): Promise<Task> {
		if (!trust()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
		const task = await this.get(id); const root = await this.root();
		if (signal?.aborted) { throw Error('HARNESS_CANCELLED_BEFORE_START'); }
		if (task.attempts.some(a => a.status === 'running')) { throw Error('HARNESS_RECONCILIATION_REQUIRED'); }
		if (this.abortController) { throw Error('HARNESS_ALREADY_RUNNING'); }
		for (const gate of task.plan.gates) { await contained(root, gate.cwd); }
		if (approved !== approvalDigest(task.plan, root)) { throw Error('HARNESS_APPROVAL_EXPIRED'); }
		await fs.mkdir(this.storage, { recursive: true });
		const handle = await fs.open(this.lockFile(), 'wx').catch((e: NodeJS.ErrnoException) => { if (e.code === 'EEXIST') { throw Error('HARNESS_LOCKED_REQUIRES_RECONCILIATION'); } throw e; });
		const controller = new AbortController(); this.abortController = controller;
		const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
		const onLocalAbort = () => { for (const child of this.active) { this.stopChild(child); } };
		controller.signal.addEventListener('abort', onLocalAbort, { once: true });
		try {
			if (signal?.aborted || !trust()) { throw Error('HARNESS_UNTRUSTED_OR_CANCELLED'); }
			// A completed gate is a prerequisite only when it passed. Failed steps stop the DAG.
			const attempt: Attempt = { id: randomUUID(), startedAt: new Date().toISOString(), revision: task.revision, approval: approved, results: [], status: 'running' };
			await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: os.hostname(), task: id, attempt: attempt.id, startedAt: attempt.startedAt }));
			task.attempts.push(attempt); await writeAtomic(this.file(id), task);
			try {
				const completed = new Set<string>();
				// A bounded wave runs only independent gates. Preserve the plan order in persisted evidence.
				// The first failed/cancelled wave stops the DAG; no dependent gate is started.
				while (completed.size < task.plan.gates.length) {
					if (!trust() || controller.signal.aborted) { attempt.status = 'cancelled'; break; }
					const ready = task.plan.gates.filter(g => !completed.has(g.id) && (g.dependsOn || []).every(d => completed.has(d)));
					if (!ready.length) { throw Error('HARNESS_DEPENDENCY_UNRESOLVED'); }
					const wave = ready.slice(0, 2);
					const results = await Promise.all(wave.map(async gate => {
						const cwd = await contained(root, gate.cwd);
						if (!trust() || controller.signal.aborted) { return { id: gate.id, exitCode: null, status: 'cancelled' as const, output: '', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }; }
						return this.runGate(gate, cwd, controller.signal);
					}));
					for (const result of results) { attempt.results.push(result); completed.add(result.id); }
					await writeAtomic(this.file(id), task);
					if (results.some(r => r.status !== 'passed')) {
						attempt.status = results.some(r => r.status === 'cancelled') || controller.signal.aborted ? 'cancelled' : 'failed';
						break;
					}
				}
				if (attempt.status === 'running') { attempt.status = 'passed'; }
			} catch (e) { attempt.status = controller.signal.aborted ? 'cancelled' : 'failed'; throw e; }
			finally { attempt.endedAt = new Date().toISOString(); await writeAtomic(this.file(id), task); }
			return task;
		} finally {
			signal?.removeEventListener('abort', onAbort); controller.signal.removeEventListener('abort', onLocalAbort);
			this.abortController = undefined; await handle.close(); await fs.rm(this.lockFile(), { force: true });
		}
	}
	private runGate(gate: Gate, cwd: string, signal: AbortSignal): Promise<GateResult> {
		const startedAt = new Date().toISOString(); const env: NodeJS.ProcessEnv = {};
		for (const k of ENV_KEYS) { if (process.env[k]) { env[k] = process.env[k]; } }
		return new Promise(resolve => {
			let output = '', finished = false, wasCancelled = false;
			const child = spawn(gate.executable, gate.args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env });
			this.active.add(child);
			let captured = 0;
			const collect = (chunk: Buffer): void => { captured += chunk.length; if (captured > MAX_OUTPUT) { wasCancelled = true; this.stopChild(child); } else { output = redact(output + chunk.toString('utf8')); } };
			child.stdout?.on('data', collect); child.stderr?.on('data', collect);
			const onAbort = () => { wasCancelled = true; this.stopChild(child); };
			signal.addEventListener('abort', onAbort, { once: true });
			const timer = setTimeout(() => { wasCancelled = true; this.stopChild(child); }, gate.timeoutMs || 120000);
			timer.unref();
			const finish = (code: number | null): void => {
				if (finished) { return; } finished = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); this.active.delete(child);
				resolve({ id: gate.id, exitCode: code, status: wasCancelled ? 'cancelled' : code === 0 ? 'passed' : 'failed', output, startedAt, endedAt: new Date().toISOString() });
			};
			child.once('error', () => finish(null)); child.once('close', finish);
			if (signal.aborted) { onAbort(); }
		});
	}
}
