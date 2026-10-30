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
import { fingerprintEvidence, evidenceKey, saveEvidenceMetadata, readEvidenceMetadata, type EvidenceFingerprint } from './native-evidence.ts';
import { inspectHarnessAuthority } from './native-authority.ts';
import { resolveNativeCommand } from './native-runtime.ts';
import { acquireSharedExecutionFence, type SharedExecutionFence } from './native-shared-fence.ts';
import { offlineSandboxInvocation, OFFLINE_SANDBOX_POLICIES, type OfflineSandboxPolicy } from './native-os-sandbox.ts';
import { adaptiveWorkerBudget, sampleHostLoad } from './native-performance.ts';

export type Gate = { id: string; executable: string; args: string[]; cwd?: string; timeoutMs?: number; dependsOn?: string[]; parallelSafe?: boolean; resources?: string[]; sandbox?: OfflineSandboxPolicy };
export type Plan = { schemaVersion: 1; gates: Gate[]; inputs?: string[] };
export type GateResult = { id: string; exitCode: number | null; status: 'passed' | 'failed' | 'cancelled'; output: string; startedAt: string; endedAt: string; reusedFrom?: string };
export type Attempt = { id: string; startedAt: string; endedAt?: string; status: 'running' | 'passed' | 'failed' | 'interrupted' | 'cancelled'; results: GateResult[]; revision: string; approval: string; evidence?: { fingerprint?: EvidenceFingerprint; key?: string; state: 'recorded' | 'changed' | 'unavailable'; error?: string } };
export type Task = { schemaVersion: 1; id: string; title: string; createdAt: string; plan: Plan; revision: string; attempts: Attempt[] };
export type Progress = { task: Task; active: boolean; reconciliationRequired: boolean };
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const EXEC = /^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,99}$/;
const MAX_OUTPUT = 64 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_MS = 10 * 60 * 1000;
// Per-user cache directories (paths, never secrets) let Go, npm and Composer toolchains run on every OS.
const ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'APPDATA', 'XDG_CACHE_HOME'];
function assertId(id: string): void { if (typeof id !== 'string' || !ID.test(id)) { throw Error('HARNESS_INVALID_ID'); } }
export function nativePlanRevision(plan: Plan): string { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }
export function approvalDigest(plan: Plan, project: string, configuration?: string): string { return createHash('sha256').update(JSON.stringify(configuration === undefined ? [nativePlanRevision(plan), project] : [nativePlanRevision(plan), project, configuration])).digest('hex'); }
export function validateNativePlan(plan: Plan): void {
	if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.gates) || plan.gates.length === 0 || plan.gates.length > 64) { throw Error('HARNESS_PLAN_SCHEMA'); }
	if (plan.inputs !== undefined && (!Array.isArray(plan.inputs) || plan.inputs.length > 64 || new Set(plan.inputs).size !== plan.inputs.length || !plan.inputs.every(input => typeof input === 'string' && input.length <= 4096 && input.length > 0 && !input.includes('\0') && !input.includes('\\') && !path.isAbsolute(input) && !input.split('/').some(part => !part || part === '.' || part === '..')))) { throw Error('HARNESS_EVIDENCE_INPUTS'); }
	const seen = new Map<string, Gate>();
	for (const gate of plan.gates) {
		if (!gate || typeof gate !== 'object') { throw Error('HARNESS_INVALID_COMMAND'); }
		assertId(gate.id); if (seen.has(gate.id)) { throw Error('HARNESS_DUPLICATE_GATE'); } seen.set(gate.id, gate);
		if (!EXEC.test(gate.executable) || !Array.isArray(gate.args) || gate.args.length > 64 || !gate.args.every(a => typeof a === 'string' && a.length <= 4096 && !a.includes('\0')) || (gate.timeoutMs !== undefined && (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs < 100 || gate.timeoutMs > MAX_MS))) { throw Error('HARNESS_INVALID_COMMAND'); }
		if (gate.cwd !== undefined && (typeof gate.cwd !== 'string' || gate.cwd.length > 4096 || gate.cwd.includes('\0'))) { throw Error('HARNESS_INVALID_CWD'); }
		if (gate.dependsOn !== undefined && (!Array.isArray(gate.dependsOn) || !gate.dependsOn.every(x => typeof x === 'string'))) { throw Error('HARNESS_INVALID_DEPENDENCY'); }
		if (gate.parallelSafe !== undefined && typeof gate.parallelSafe !== 'boolean') { throw Error('HARNESS_INVALID_PARALLEL_POLICY'); }
		if (gate.sandbox !== undefined && !OFFLINE_SANDBOX_POLICIES.includes(gate.sandbox)) { throw Error('HARNESS_INVALID_SANDBOX_POLICY'); }
		if (gate.resources !== undefined && (!Array.isArray(gate.resources) || gate.resources.length > 16 || new Set(gate.resources).size !== gate.resources.length || !gate.resources.every(x => typeof x === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,99}$/i.test(x)))) { throw Error('HARNESS_INVALID_RESOURCES'); }
	}
	const done = new Set<string>(), active = new Set<string>();
	const visit = (id: string): void => { if (active.has(id)) { throw Error('HARNESS_CYCLE'); } if (done.has(id)) { return; } const g = seen.get(id); if (!g) { throw Error('HARNESS_INVALID_DEPENDENCY'); } active.add(id); for (const d of g.dependsOn || []) { visit(d); } active.delete(id); done.add(id); };
	for (const id of seen.keys()) { visit(id); }
}

/**
 * Preserve legacy two-gate execution; allow up to four only when all candidates explicitly
 * declare safe parallelism, scaled down by observed CPU load and memory pressure.
 */
export function selectNativeWave(ready: Gate[], availableCpus = adaptiveWorkerBudget(sampleHostLoad())): Gate[] {
	if (!ready.length) { return []; }
	if (!ready.every(g => g.parallelSafe === true)) { return ready.slice(0, 2); }
	const maxWorkers = Math.max(1, Math.min(4, availableCpus));
	const selected: Gate[] = [];
	const claimed = new Set<string>();
	for (const gate of ready) {
		const resources = gate.resources?.length ? gate.resources : ['cwd:' + (gate.cwd || '.')];
		if (resources.some(resource => claimed.has(resource))) { continue; }
		selected.push(gate);
		for (const resource of resources) { claimed.add(resource); }
		if (selected.length === maxWorkers) { break; }
	}
	return selected;
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
	/** Bind authorization to the current shared configuration as well as the reviewed plan. */
	async reviewDigest(plan: Plan): Promise<string> {
		const root = await this.root();
		const file = path.join(root, '.ats-harness.json');
		let configuration: string | undefined;
		try {
			const stat = await fs.lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) { throw Error('HARNESS_CONFIG_UNSAFE'); }
			configuration = createHash('sha256').update(await fs.readFile(file)).digest('hex');
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
		return approvalDigest(plan, root, configuration);
	}
	async evidenceStatus(id: string): Promise<Array<{ attemptId: string; state: string }>> {
		const task = await this.get(id);
		return Promise.all(task.attempts.map(async attempt => {
			const fingerprint = attempt.evidence?.fingerprint;
			if (!fingerprint || attempt.evidence?.state !== 'recorded') { return { attemptId: attempt.id, state: attempt.evidence?.state || 'unavailable' }; }
			try {
				const record = await readEvidenceMetadata(path.join(this.storage, 'evidence'), fingerprint, { taskId: id, attemptId: attempt.id });
				if (!record || record.taskId !== id || record.attemptId !== attempt.id || record.status !== attempt.status) { return { attemptId: attempt.id, state: 'unavailable' }; }
				const current = await fingerprintEvidence(await this.root(), await this.reviewDigest(task.plan), fingerprint.inputs.map(input => input.relativePath));
				return { attemptId: attempt.id, state: evidenceKey(current) === attempt.evidence.key ? 'current-declared-inputs' : 'changed' };
			} catch { return { attemptId: attempt.id, state: 'unavailable' }; }
		}));
	}
	async diagnose(): Promise<{ root: string; operations: string[]; requiresAI: false; lock: 'none' | 'active' | 'stale' | 'unknown'; lockTask?: string; lockAttempt?: string; tools: Array<{ name: string; installed: boolean; verified: false }> }> {
		await this.root(); let lock: 'none' | 'active' | 'stale' | 'unknown' = 'none';
		let lockTask: string | undefined, lockAttempt: string | undefined;
		try {
			const stat = await fs.lstat(this.lockFile());
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) { throw Error('HARNESS_LOCK_UNSAFE'); }
			const info = JSON.parse(await fs.readFile(this.lockFile(), 'utf8'));
			lock = Number.isInteger(info.pid) && info.pid > 0 && info.hostname === os.hostname() ? (processAlive(info.pid) ? 'active' : 'stale') : 'unknown';
			lockTask = typeof info.task === 'string' && ID.test(info.task) ? info.task : undefined;
			lockAttempt = typeof info.attempt === 'string' && ID.test(info.attempt) ? info.attempt : undefined;
		}
		catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { lock = 'unknown'; } }
		const tools = await Promise.all(['node', 'npm', 'go', 'php', 'git'].map(async name => ({ name, installed: await resolveNativeCommand(name, []).then(() => true, () => false), verified: false as const })));
		return { root: await this.root(), operations: ['diagnose', 'create', 'list', 'status', 'execute', 'cancel', 'reconcile'], requiresAI: false, lock, lockTask, lockAttempt, tools };
	}
	async create(title: string, plan: Plan): Promise<Task> {
		if ((await inspectHarnessAuthority(this.project)).engine === 'project') { throw Error('HARNESS_PROJECT_AUTHORITY'); }
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
		if (typeof data.title !== 'string' || data.title.length > 300 || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt)) || !data.attempts.every(a => ID.test(a.id) && typeof a.startedAt === 'string' && Number.isFinite(Date.parse(a.startedAt)) && /^[a-f0-9]{64}$/.test(a.revision) && /^[a-f0-9]{64}$/.test(a.approval) && a.results.length <= 64 && a.results.every(r => r && ID.test(r.id) && ['passed', 'failed', 'cancelled'].includes(r.status) && (r.exitCode === null || Number.isSafeInteger(r.exitCode)) && typeof r.output === 'string' && Buffer.byteLength(r.output) <= MAX_OUTPUT && typeof r.startedAt === 'string' && typeof r.endedAt === 'string' && (r.reusedFrom === undefined || ID.test(r.reusedFrom))))) { throw Error('HARNESS_INVALID_TASK_STATE'); }
		validateNativePlan(data.plan); if (data.revision !== nativePlanRevision(data.plan)) { throw Error('HARNESS_PLAN_CHANGED'); }
		for (const attempt of data.attempts) { for (const result of attempt.results) { result.output = redact(result.output); } }
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
		const active = running && lock.lock === 'active' && lock.lockTask === task.id && task.attempts.some(a => a.status === 'running' && a.id === lock.lockAttempt);
		return { task, active, reconciliationRequired: running && !active };
	}
	cancel(): void { this.abortController?.abort(); for (const child of this.active) { this.stopChild(child); } }
	private stopChild(child: ChildProcess): void {
		if (!child.pid) { return; }
		if (process.platform !== 'win32') {
			try {
				process.kill(-child.pid, 'SIGTERM');
				const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group already stopped */ } }, 1000);
				timer.unref(); child.once('close', () => clearTimeout(timer)); return;
			} catch { /* process may be gone */ }
		}
		else { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => { }); }
		try { child.kill('SIGTERM'); } catch { /* already stopped */ }
	}
	/** A stale lock is never silently stolen. Reconciliation requires an explicit operator decision. */
	async reconcile(): Promise<boolean> {
		const diagnostic = await this.diagnose();
		if (diagnostic.lock === 'none') {
			if (this.abortController) { return false; }
			await fs.mkdir(this.storage, { recursive: true });
			const handle = await fs.open(this.lockFile(), 'wx');
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: os.hostname(), operation: 'reconcile' }));
				for (const task of await this.list()) {
					if (!task.attempts.some(attempt => attempt.status === 'running')) { continue; }
					for (const attempt of task.attempts) { if (attempt.status === 'running') { attempt.status = 'interrupted'; attempt.endedAt = new Date().toISOString(); } }
					await writeAtomic(this.file(task.id), task);
				}
			} finally { await handle.close(); await fs.rm(this.lockFile()); }
			return true;
		}
		if (diagnostic.lock !== 'stale') { return false; }
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
	/**
	 * Safe checkpoint of the latest unsuccessful attempt: its passed gates are reusable
	 * only for the same reviewed plan and configuration, with recorded evidence whose
	 * declared inputs are unchanged now. Interrupted attempts never qualify.
	 */
	async resumableGates(id: string): Promise<{ attemptId: string; gates: string[] } | null> {
		const task = await this.get(id);
		const last = task.attempts.at(-1);
		if (!last || (last.status !== 'failed' && last.status !== 'cancelled') || !task.plan.inputs?.length ||
			last.revision !== task.revision || last.approval !== await this.reviewDigest(task.plan)) {
			return null;
		}
		if ((await this.evidenceStatus(id)).find(entry => entry.attemptId === last.id)?.state !== 'current-declared-inputs') { return null; }
		const gates = last.results.filter(result => result.status === 'passed').map(result => result.id);
		return gates.length ? { attemptId: last.id, gates } : null;
	}
	async execute(id: string, approved: string, trust: () => boolean, signal?: AbortSignal, borrowedFence?: SharedExecutionFence, options: { resume?: boolean } = {}): Promise<Task> {
		if (!trust()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
		if ((await inspectHarnessAuthority(this.project)).engine === 'project') { throw Error('HARNESS_PROJECT_AUTHORITY'); }
		const task = await this.get(id); const root = await this.root();
		if (signal?.aborted) { throw Error('HARNESS_CANCELLED_BEFORE_START'); }
		if (task.attempts.some(a => a.status === 'running')) { throw Error('HARNESS_RECONCILIATION_REQUIRED'); }
		if (this.abortController) { throw Error('HARNESS_ALREADY_RUNNING'); }
		for (const gate of task.plan.gates) { await contained(root, gate.cwd); }
		if (approved !== await this.reviewDigest(task.plan)) { throw Error('HARNESS_APPROVAL_EXPIRED'); }
		await fs.mkdir(this.storage, { recursive: true });
		const handle = await fs.open(this.lockFile(), 'wx').catch((e: NodeJS.ErrnoException) => { if (e.code === 'EEXIST') { throw Error('HARNESS_LOCKED_REQUIRES_RECONCILIATION'); } throw e; });
		let shared: SharedExecutionFence;
		try {
			shared = borrowedFence || await acquireSharedExecutionFence(root, this.storage, 'native-task');
			await shared.assertCurrent();
		} catch (error) {
			await handle.close();
			await fs.rm(this.lockFile());
			throw error;
		}
		let attemptStarted = false;
		let terminalPersisted = false;
		const controller = new AbortController(); this.abortController = controller;
		const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
		const onLocalAbort = () => { for (const child of this.active) { this.stopChild(child); } };
		controller.signal.addEventListener('abort', onLocalAbort, { once: true });
		try {
			if (signal?.aborted || !trust()) { throw Error('HARNESS_UNTRUSTED_OR_CANCELLED'); }
			// A completed gate is a prerequisite only when it passed. Failed steps stop the DAG.
			const attempt: Attempt = { id: randomUUID(), startedAt: new Date().toISOString(), revision: task.revision, approval: approved, results: [], status: 'running' };
			let fingerprint: EvidenceFingerprint | undefined;
			try {
				if (task.plan.inputs?.length) { fingerprint = await fingerprintEvidence(root, approved, task.plan.inputs); }
			} catch { /* Missing or unsafe inputs disable evidence reuse, never execution checks. */ }
			const checkpoint = options.resume ? await this.resumableGates(id) : null;
			if (options.resume && !checkpoint) { throw Error('HARNESS_RESUME_UNAVAILABLE'); }
			const previous = checkpoint ? task.attempts.find(item => item.id === checkpoint.attemptId) : undefined;
			await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: os.hostname(), task: id, attempt: attempt.id, startedAt: attempt.startedAt }));
			task.attempts.push(attempt); attemptStarted = true;
			await shared.assertCurrent();
			await writeAtomic(this.file(id), task);
			try {
				const completed = new Set<string>();
				for (const result of previous?.results.filter(item => checkpoint?.gates.includes(item.id)) || []) {
					attempt.results.push({ ...result, reusedFrom: previous!.id }); completed.add(result.id);
				}
				// A bounded wave runs only independent gates. Preserve the plan order in persisted evidence.
				// The first failed/cancelled wave stops the DAG; no dependent gate is started.
				while (completed.size < task.plan.gates.length) {
					if (!trust() || controller.signal.aborted) { attempt.status = 'cancelled'; break; }
					if (approved !== await this.reviewDigest(task.plan)) { throw Error('HARNESS_APPROVAL_EXPIRED'); }
					if ((await inspectHarnessAuthority(root)).engine === 'project') { throw Error('HARNESS_PROJECT_AUTHORITY'); }
					const ready = task.plan.gates.filter(g => !completed.has(g.id) && (g.dependsOn || []).every(d => completed.has(d)));
					if (!ready.length) { throw Error('HARNESS_DEPENDENCY_UNRESOLVED'); }
					await shared.assertCurrent();
					const wave = selectNativeWave(ready);
					const settled = await Promise.allSettled(wave.map(async gate => {
						const cwd = await contained(root, gate.cwd);
						if (!trust() || controller.signal.aborted) { return { id: gate.id, exitCode: null, status: 'cancelled' as const, output: '', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }; }
						return this.runGate(gate, cwd, controller.signal);
					}));
					// Drain every owned child before releasing the execution lock, even if one cwd failed.
					const failure = settled.find(result => result.status === 'rejected');
					if (failure?.status === 'rejected') { throw failure.reason; }
					const results = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
					for (const result of results) { attempt.results.push(result); completed.add(result.id); }
					await writeAtomic(this.file(id), task);
					if (results.some(r => r.status !== 'passed')) {
						attempt.status = results.some(r => r.status === 'cancelled') || controller.signal.aborted ? 'cancelled' : 'failed';
						break;
					}
				}
				if (attempt.status === 'running') { attempt.status = controller.signal.aborted || !trust() ? 'cancelled' : 'passed'; }
			} catch (e) { attempt.status = controller.signal.aborted ? 'cancelled' : 'failed'; throw e; }
			finally {
				attempt.endedAt = new Date().toISOString();
				attempt.evidence = { state: 'unavailable' };
				if (fingerprint) {
					try {
						const current = await fingerprintEvidence(root, await this.reviewDigest(task.plan), task.plan.inputs!);
						if (evidenceKey(current) !== evidenceKey(fingerprint)) { attempt.evidence = { state: 'changed' }; }
						else {
							await saveEvidenceMetadata(path.join(this.storage, 'evidence'), fingerprint, { taskId: id, attemptId: attempt.id, status: attempt.status as 'passed' | 'failed' | 'cancelled' | 'interrupted' });
							attempt.evidence = { state: 'recorded', fingerprint, key: evidenceKey(fingerprint) };
						}
					} catch { attempt.evidence = { state: 'unavailable', error: 'HARNESS_EVIDENCE_PERSISTENCE' }; }
				}
				// Cancellation may arrive while persisting evidence after the final gate.
				// Never commit a successful terminal state after trust was revoked or abort won.
				if (attempt.status === 'passed' && (controller.signal.aborted || !trust())) { attempt.status = 'cancelled'; }
				await shared.assertCurrent();
				await writeAtomic(this.file(id), task);
				terminalPersisted = true;
			}
			return task;
		} finally {
			signal?.removeEventListener('abort', onAbort); controller.signal.removeEventListener('abort', onLocalAbort);
			this.abortController = undefined; await handle.close(); await fs.rm(this.lockFile(), { force: true });
			if (!borrowedFence && (!attemptStarted || terminalPersisted)) { await shared.release(); }
		}
	}
	private async runGate(gate: Gate, cwd: string, signal: AbortSignal): Promise<GateResult> {
		const startedAt = new Date().toISOString(); let env: NodeJS.ProcessEnv = {};
		for (const k of ENV_KEYS) { if (process.env[k]) { env[k] = process.env[k]; } }
		let command;
		let scratch: string | undefined;
		try {
			command = await resolveNativeCommand(gate.executable, gate.args);
			if (gate.sandbox) {
				const sandbox = await offlineSandboxInvocation(cwd, command.executable, command.args, gate.sandbox);
				command = { executable: sandbox.executable, args: sandbox.args, embeddedNode: false };
				if (sandbox.env) { env = { ...sandbox.env }; }
				scratch = sandbox.scratch;
			}
		} catch {
			return {
				id: gate.id, startedAt, endedAt: new Date().toISOString(),
				status: 'failed', exitCode: null,
				output: gate.sandbox ? 'HARNESS_OS_SANDBOX_UNAVAILABLE' : 'HARNESS_EXECUTABLE_UNAVAILABLE'
			};
		}
		try { return await this.spawnGate(gate, cwd, signal, command, env, startedAt); }
		finally { if (scratch) { await fs.rm(scratch, { recursive: true, force: true }); } }
	}
	private spawnGate(gate: Gate, cwd: string, signal: AbortSignal, command: { executable: string; args: string[]; embeddedNode: boolean }, env: NodeJS.ProcessEnv, startedAt: string): Promise<GateResult> {
		if (signal.aborted) { return Promise.resolve({ id: gate.id, startedAt, endedAt: new Date().toISOString(), status: 'cancelled', exitCode: null, output: '' }); }
		if (command.embeddedNode) { env.ELECTRON_RUN_AS_NODE = '1'; }
		return new Promise(resolve => {
			let output = '', finished = false, wasCancelled = false;
			const child = spawn(command.executable, command.args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env });
			this.active.add(child);
			let captured = 0;
			const collect = (chunk: Buffer): void => { captured += chunk.length; if (captured > MAX_OUTPUT) { wasCancelled = true; this.stopChild(child); } else { output += chunk.toString('utf8'); } };
			child.stdout?.on('data', collect); child.stderr?.on('data', collect);
			const onAbort = () => { wasCancelled = true; this.stopChild(child); };
			signal.addEventListener('abort', onAbort, { once: true });
			const timer = setTimeout(() => { wasCancelled = true; this.stopChild(child); }, gate.timeoutMs || 120000);
			timer.unref();
			const finish = (code: number | null): void => {
				if (finished) { return; } finished = true; clearTimeout(timer); signal.removeEventListener('abort', onAbort); this.active.delete(child);
				resolve({ id: gate.id, exitCode: code, status: wasCancelled ? 'cancelled' : code === 0 ? 'passed' : 'failed', output: redact(output), startedAt, endedAt: new Date().toISOString() });
			};
			child.once('error', () => finish(null)); child.once('close', finish);
			if (signal.aborted) { onAbort(); }
		});
	}
}
