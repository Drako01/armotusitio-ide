/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executeFile = promisify(execFile);
const { readProvider, providerRevision } = require('./provider.ts');
const { logReference } = require('./evidence.ts');
const { nativeEntry } = require('./adapter.ts');
const { createHash } = require('node:crypto');
const identityPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const phases = ['preparing', 'questions', 'review', 'creating', 'running', 'stopping', 'completed', 'failed', 'interrupted', 'blocked', 'cancelled', 'pending', 'unknown'];

type Question = { id: string; question?: string; prompt?: string; message?: string; options?: string[] };
type Plan = { domain?: string; dag?: { id?: string; agent?: string; kind?: string; dependsOn?: string[]; dependencies?: string[]; command?: string[] }[] };
type NativeNode = { attempt?: number; previousAttempt?: string; failure?: { category?: string; cause?: string; action?: string }; gates?: { done?: number; total?: number }; gateDetail?: { typicalMs?: number; elapsedMs?: number; slow?: boolean }; id?: string; agent?: string; domain?: string; status?: string; state?: string; elapsedMs?: number; durationMs?: number; log?: string; phase?: string; cause?: string; dependencies?: string[]; dependsOn?: string[] };
type NativeData = { eta?: { remainingMs?: number; basis?: string }; text?: string; complete?: boolean; domain?: string; planDigest?: string; outcome?: string; liveness?: string; aborted?: object | boolean; finishedAt?: string; startedAt?: string; createdAt?: string; updatedAt?: string; attempt?: { number?: number; outcome?: string; endedAt?: string }; attempts?: { number?: number; kind?: string; outcome?: string; startedAt?: string; endedAt?: string }[]; currentGate?: { node?: string; id?: string; domain?: string; elapsedMs?: number }; observation?: { generatedAt?: string; heartbeatAgeMs?: number }; finalGates?: NativeNode[] | { done?: number; total?: number; current?: string }; workers?: { id?: string; state?: string; agent?: string }[] | { active?: number; queued?: number; recommended?: number }; phases?: { id?: string; status?: string }[]; lastEvent?: { at?: string; event?: string; state?: string; gate?: string }; title?: string; id?: string; state?: string; status?: string; live?: boolean; percent?: number; elapsedMs?: number; cause?: string; children?: NativeData[]; nodes?: NativeNode[]; ready?: boolean; questions?: Question[]; plan?: Plan[]; checks?: { id?: string; status?: string; message?: string; action?: string; severity?: string }[]; warnings?: { id?: string; message?: string; title?: string; hint?: string; action?: string; severity?: string }[]; mode?: string };
type NativeOptions = { authorize?: () => boolean; node?: string; host?: string; timeout?: number; started?: (child: import('node:child_process').ChildProcess) => void; log?: (text: string) => void };
type Entry = { nodeStates?: Record<string, string>; evidence?: Record<string, string>; nativePlanRevision?: string; creationUncertain?: boolean; providerRevision?: string; logs?: string; issueKey?: string; planDigest?: string; reviewed?: string; previousPlan?: object[]; cancellation?: boolean; observedAt?: number; detectedEndedAt?: number; detectedAt?: number; origin?: string; timeline?: { phase: string; at: number; attempt?: number; unit?: string }[]; title?: string; id: string; project: string; profile: { id: string; root: string }; host: string; phase: string; startedAt: number; endedAt?: number; questions: Question[]; knownQuestions: Question[]; answers: Record<string, string>; file?: string; nativeId?: string; error?: string; mode?: string; ready?: boolean; plan?: { domain: string; nodes: { id: string; agent: string; kind?: string; dependencies?: string[] }[] }[]; warnings?: { id?: string; message: string; hint: string; blocking: boolean }[]; progress?: ReturnType<typeof progressView>; progressError?: boolean; checkedAt?: number; restored?: boolean };

/** Keep user prompts and credentials out of execution summaries and diagnostic output. */
const { redactSecrets: redact } = require('./native-redact.ts');

const sharedReads = new Map();
const rootReads = new Map();
const readQueue = [];
let activeReads = 0;

/** Share equivalent observations, serialize each root and bound read subprocesses across projects. */
async function nativeRun(profile, args, options: NativeOptions = {}): Promise<{ code: number; value?: NativeData; error: string; output?: string }> {
	if (options.authorize && !options.authorize()) { throw new Error('HARNESS_WORKSPACE'); }
	if (!['progress', 'list', 'status', 'metrics', 'source', 'version', 'capabilities', 'objective'].includes(args[0])) { return executeNative(profile, args, options); }
	const { root } = await nativeEntry(profile);
	const key = JSON.stringify([root, profile.id, args, options.node || 'node']);
	let reading = sharedReads.get(key);
	if (!reading) {
		const previous = rootReads.get(root) || Promise.resolve();
		reading = previous.catch(() => undefined).then(async () => {
			if (activeReads >= 2) { await new Promise(resolve => readQueue.push(resolve)); }
			else { activeReads++; }
			try { return await executeNative(profile, args, options); }
			finally { if (readQueue.length) { readQueue.shift()(); } else { activeReads--; } }
		});
		sharedReads.set(key, reading); rootReads.set(root, reading);
		void reading.finally(() => { sharedReads.delete(key); if (rootReads.get(root) === reading) { rootReads.delete(root); } }).catch(() => undefined);
	}
	const result = await reading;
	if (options.authorize && !options.authorize()) { throw new Error('HARNESS_WORKSPACE'); }
	return result;
}

/** Invoke only the native Harness entrypoint, with literal arguments and bounded output. */
async function executeNative(profile, args, options: NativeOptions = {}): Promise<{ code: number; value?: NativeData; error: string; output?: string }> {
	const { root, entry } = await nativeEntry(profile);
	if (profile.id !== 'redevent' && options.host && options.host !== 'project') { throw new Error('HARNESS_PROVIDER'); }
	if (options.host && profile.id === 'redevent') {
		const provider = await readProvider(profile);
		if (!['codex', 'claude'].includes(options.host) || provider.custom || provider.error) { throw new Error('HARNESS_PROVIDER'); }
	}
	if (options.authorize && !options.authorize()) { throw new Error('HARNESS_WORKSPACE'); }
	return new Promise((resolve, reject) => {
		const child = spawn(options.node || 'node', [entry, ...args], {
			cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32',
			env: { ...process.env, HARNESS_ORIGIN: 'ide', ...(profile.id !== 'redevent' ? { HARNESS_HOST: 'project' } : options.host ? { HARNESS_HOST: options.host } : {}) },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		options.started?.(child);
		let stdout = '', stderr = '', line = '', dropping = false, overflow = false, timedOut = false;
		const log = chunk => {
			for (const part of chunk.split(/(?<=\n)/)) {
				if (!dropping) { line += part; if (line.length > 65536) { line = ''; dropping = true; } }
				if (part.endsWith('\n')) { if (!dropping) { const safe = redact(line); stderr = (stderr + safe).slice(-65536); options.log?.(safe); } line = ''; dropping = false; }
			}
		};
		const limit = 4 * 1024 * 1024;
		const timer = options.timeout ? setTimeout(() => { timedOut = true; void terminateChild(child); }, options.timeout) : undefined;
		child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => { if (overflow) { return; } if (stdout.length + chunk.length > limit) { overflow = true; void terminateChild(child); } else { stdout += chunk; } });
		child.stderr.on('data', chunk => { log(chunk); });
		child.once('error', error => { clearTimeout(timer); reject(error); });
		child.once('close', code => {
			clearTimeout(timer);
			if (line && !dropping) { const safe = redact(line); stderr = (stderr + safe).slice(-65536); options.log?.(safe); }
			if (overflow || timedOut) { reject(new Error(overflow ? 'HARNESS_OUTPUT_LIMIT' : 'HARNESS_TIMEOUT')); return; }
			let value;
			try { value = JSON.parse(stdout); } catch { /* Native errors may contain only stderr. */ }
			resolve({ code, value, output: redact(stdout).slice(-24000), error: redact(stderr).slice(-4000) });
		});
	});
}

/** Terminate only a subprocess tree started by this instance, never a PID found in another task's state. */
async function terminateChild(child) {
	if (!child?.pid) { return false; }
	if (child.exitCode !== null || child.signalCode) { return true; }
	if (process.platform === 'win32') {
		await executeFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
	} else {
		try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The owned process may already have exited. */ }
	}
	if (child.exitCode !== null || child.signalCode) { return true; }
	return new Promise<boolean>(resolve => {
		const finish = () => { clearTimeout(timer); child.removeListener('exit', exited); resolve(child.exitCode !== null || !!child.signalCode); };
		const exited = () => finish();
		const timer = setTimeout(finish, 2000);
		child.once('exit', exited);
	});
}

/** Only pass answers to question IDs actually raised by the native preflight. */
function answerArgs(questions, answers) {
	if (!answers || typeof answers !== 'object' || Array.isArray(answers)) { throw new Error('HARNESS_ANSWERS'); }
	const allowed = new Set(questions.map(question => question.id));
	return Object.entries(answers).flatMap(([id, value]) => {
		if (!allowed.has(id) || !/^[a-z0-9_-]{1,100}$/i.test(id) || typeof value !== 'string' || !value.trim() || value.length > 4000 || /\0|,(?=[a-z0-9_-]+=)/i.test(value)) { throw new Error('HARNESS_ANSWERS'); }
		return ['--answer', `${id}=${value.trim()}`];
	});
}

/** Expose measured native progress, including the units, without leaking raw task sources or tool output. */
function progressView(value: NativeData) {
	if (!value || !identityPattern.test(value.id || '') || !['running', 'stalled', 'completed', 'failed'].includes(value.state)) { throw new Error('HARNESS_PROGRESS'); }
	const clean = (text, limit = 180) => typeof text === 'string' ? redact(text).slice(0, limit) : undefined;
	const time = text => typeof text === 'string' && Number.isFinite(Date.parse(text)) ? Date.parse(text) : undefined;
	const normalizeNodes = (nodes: NativeNode[], domain = '') => (Array.isArray(nodes) ? nodes : []).slice(0, 150).map(node => ({
		id: clean(node.id || node.agent || '', 100), agent: clean(node.agent || node.id || '', 100), domain: clean(node.domain || domain, 80),
		status: ['pending', 'running', 'passed', 'failed', 'blocked', 'skipped', 'cancelled', 'aborted'].includes(node.status || node.state) ? node.status || node.state : 'unknown',
		elapsedMs: Number.isFinite(node.elapsedMs ?? node.durationMs) && (node.elapsedMs ?? node.durationMs) >= 0 ? node.elapsedMs ?? node.durationMs : undefined,
		gateDetail: node.gateDetail && Number.isFinite(node.gateDetail.typicalMs) && node.gateDetail.typicalMs > 0 ? { typicalMs: node.gateDetail.typicalMs, elapsedMs: Number.isFinite(node.gateDetail.elapsedMs) ? Math.max(0, node.gateDetail.elapsedMs) : undefined, slow: node.gateDetail.slow === true } : undefined,
		gates: node.gates && Number.isSafeInteger(node.gates.done) && Number.isSafeInteger(node.gates.total) && node.gates.done >= 0 && node.gates.total > 0 ? { done: node.gates.done, total: node.gates.total } : undefined,
		attempt: Number.isSafeInteger(node.attempt) ? node.attempt : undefined, previousAttempt: clean(node.previousAttempt, 500), failure: node.failure ? { category: clean(node.failure.category, 80), cause: clean(node.failure.cause, 1000), action: clean(node.failure.action, 1000) } : undefined,
		evidence: logReference(node.log),
		cause: clean(node.cause, 1200), phase: clean(node.phase, 80),
		dependencies: (Array.isArray(node.dependencies || node.dependsOn) ? node.dependencies || node.dependsOn : []).slice(0, 50).map(item => clean(item, 100))
	}));
	const children = (Array.isArray(value.children) ? value.children : []).slice(0, 30).map(child => ({ domain: clean(child.domain || child.id, 80), nodes: normalizeNodes(child.nodes, child.domain || child.id) }));
	const unique = new Map();
	for (const node of [...normalizeNodes(value.nodes, value.domain), ...children.flatMap(child => child.nodes)]) { unique.set(`${node.domain || ''}/${node.id}`, node); }
	const final = value.finalGates;
	const finalGates = Array.isArray(final) ? normalizeNodes(final, 'final') : final && Number.isSafeInteger(final.total) && final.total > 0 ? normalizeNodes([{ id: 'final-gates', domain: 'final', agent: 'verifier', status: final.done >= final.total ? 'passed' : value.live ? 'running' : 'unknown', gates: { done: final.done, total: final.total } }], 'final') : [];
	const gate = value.currentGate;
	const currentNode = [...unique.values()].find(node => node.id === (gate?.id || gate?.node)) || [...unique.values()].find(node => node.status === 'running');
	const outcome = ['pending', 'running', 'interrupted', 'unknown', 'retry-pending', 'completed', 'failed', 'cancelled'].includes(value.outcome) ? value.outcome : value.aborted && value.state === 'failed' ? 'cancelled' : undefined;
	return {
		id: value.id, title: clean(value.title), state: value.state, live: value.live === true, outcome,
		liveness: ['alive', 'dead', 'foreign', 'unknown', 'not-running'].includes(value.liveness) ? value.liveness : undefined,
		percent: Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100 ? value.percent : undefined,
		elapsedMs: Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : undefined,
		eta: value.eta && Number.isFinite(value.eta.remainingMs) && value.eta.remainingMs > 0 ? { remainingMs: value.eta.remainingMs, basis: clean(value.eta.basis, 400) } : undefined,
		cause: clean(value.cause, 1200), nodes: [...unique.values()].slice(0, 200), children, finalGates,
		attempt: Number.isSafeInteger(value.attempt?.number) ? value.attempt.number : undefined,
		attempts: (Array.isArray(value.attempts) ? value.attempts : []).slice(-30).map(item => ({ number: item.number, kind: clean(item.kind, 30), outcome: clean(item.outcome, 30), startedAt: time(item.startedAt), endedAt: time(item.endedAt) })),
		finishedAt: time(value.finishedAt || value.attempt?.endedAt), startedAt: time(value.startedAt || value.createdAt),
		currentGate: gate || currentNode ? { id: clean(gate?.id || gate?.node || currentNode?.id, 100), domain: clean(gate?.domain || currentNode?.domain || value.domain, 80), elapsedMs: Number.isFinite(gate?.elapsedMs ?? currentNode?.elapsedMs) ? Math.max(0, gate?.elapsedMs ?? currentNode?.elapsedMs) : undefined } : undefined,
		workerSummary: value.workers && !Array.isArray(value.workers) ? { active: Number.isSafeInteger(value.workers.active) ? value.workers.active : undefined, queued: Number.isSafeInteger(value.workers.queued) ? value.workers.queued : undefined, recommended: Number.isSafeInteger(value.workers.recommended) ? value.workers.recommended : undefined } : undefined,
		workers: (Array.isArray(value.workers) ? value.workers : []).slice(0, 30).map(item => ({ id: clean(item.id, 100), state: clean(item.state, 40), agent: clean(item.agent, 80) })),
		heartbeatAgeMs: Number.isFinite(value.observation?.heartbeatAgeMs) ? Math.max(0, value.observation.heartbeatAgeMs) : undefined,
		lastEvent: value.lastEvent ? { at: time(value.lastEvent.at), event: clean(value.lastEvent.event || value.lastEvent.state, 100), gate: clean(value.lastEvent.gate, 100) } : undefined
	};
}

/** Thin lifecycle adapter: native preflight, native persisted plan, native execution and native recovery. */
class HarnessWorkflow {
	options;
	run;
	entries = new Map<string, Entry>();
	busy = new Set();
	stops = new Set();
	children = new Map();
	readings = new Map<string, Promise<void>>();
	persist = Promise.resolve();
	lastSaved = '';
	disposed = false;
	constructor(options) {
		this.options = options;
		this.run = options.run || nativeRun;
		const stored = options.storage.get('atsHarness.workflows.v1', []);
		for (const saved of (Array.isArray(stored) ? stored : [])) {
			if (saved && identityPattern.test(saved.id || '') && typeof saved.project === 'string' && (identityPattern.test(saved.nativeId || '') || saved.creationUncertain === true) && ['codex', 'claude', 'project'].includes(saved.host)) {
				this.entries.set(saved.id, { id: saved.id, project: saved.project, nativeId: saved.nativeId, host: saved.host, startedAt: Number.isSafeInteger(saved.startedAt) ? saved.startedAt : 0, profile: undefined, questions: [], knownQuestions: [], answers: {}, restored: true, creationUncertain: saved.creationUncertain === true, phase: saved.creationUncertain ? 'unknown' : phases.includes(saved.phase) && ['completed', 'failed', 'cancelled'].includes(saved.phase) ? saved.phase : 'interrupted', endedAt: Number.isFinite(saved.endedAt) ? saved.endedAt : undefined, cancellation: saved.cancellation === true, issueKey: typeof saved.issueKey === 'string' && /^[a-z][a-z0-9-]*-\d+$/i.test(saved.issueKey) ? saved.issueKey : undefined, origin: saved.origin === 'ide' ? 'ide' : 'external' });
			}
		}
	}
	all() { return [...this.entries.values()]; }
	view(entry) {
		const { file, profile, answers, questions, knownQuestions, reviewed, providerRevision, nativePlanRevision, evidence, nodeStates, logs, ...publicValue } = entry;
		return { ...publicValue, owned: this.children.has(entry.id), editable: !!entry.file && !entry.nativeId && !entry.creationUncertain && !this.busy.has(entry.project), questions: (questions || []).map(question => ({ id: question.id, question: question.question || question.prompt || question.message || question.id, options: Array.isArray(question.options) ? question.options.filter(item => typeof item === 'string').slice(0, 8) : [] })) };
	}
	changed() {
		for (const entry of this.entries.values()) {
			entry.timeline ||= [];
			if (entry.timeline.at(-1)?.phase !== entry.phase || entry.timeline.at(-1)?.attempt !== entry.progress?.attempt) {
				entry.timeline.push({ phase: entry.phase, at: Date.now(), attempt: entry.progress?.attempt });
				entry.timeline = entry.timeline.slice(-50);
			}
			entry.nodeStates ||= {};
			for (const node of [...(entry.progress?.nodes || []), ...(entry.progress?.finalGates || [])]) {
				const key = `${node.domain || ''}/${node.id}`; const state = `${node.status}/${node.attempt || entry.progress?.attempt || 0}`;
				if (node.status !== 'pending' && node.status !== 'unknown' && entry.nodeStates[key] !== state) { entry.timeline.push({ phase: node.status, at: Date.now(), attempt: node.attempt || entry.progress?.attempt, unit: key }); }
				entry.nodeStates[key] = state;
			}
			entry.timeline = entry.timeline.slice(-50);
		}
		const entries = this.all().filter(entry => entry.nativeId || entry.creationUncertain);
		const terminal = new Set(entries.filter(entry => ['completed', 'failed', 'cancelled'].includes(entry.phase)).slice(-40));
		for (const entry of entries) { if (['completed', 'failed', 'cancelled'].includes(entry.phase) && !terminal.has(entry) && !this.children.has(entry.id)) { this.entries.delete(entry.id); } }
		const rows = entries.filter(entry => !['completed', 'failed', 'cancelled'].includes(entry.phase) || terminal.has(entry)).map(entry => ({ id: entry.id, project: entry.project, nativeId: entry.nativeId, creationUncertain: entry.creationUncertain, host: entry.host, startedAt: entry.startedAt, phase: entry.phase, endedAt: entry.endedAt, cancellation: entry.cancellation, origin: entry.origin, issueKey: entry.issueKey }));
		const signature = JSON.stringify(rows);
		if (signature !== this.lastSaved) {
			this.lastSaved = signature;
			this.persist = this.persist.then(() => this.options.storage.update('atsHarness.workflows.v1', rows)).catch(() => { this.lastSaved = ''; this.options.log?.('No se pudo guardar la referencia de la tarea.\n'); });
		}
		this.options.changed();
	}
	entry(id, profile) {
		const entry = this.entries.get(id);
		if (!entry || entry.project !== profile.root || !this.options.allowed(profile)) { throw new Error('HARNESS_WORKSPACE'); }
		return entry;
	}
	async call(entry, command, args = [], timeout = 120000) {
		if (!this.options.allowed(entry.profile)) { throw new Error('HARNESS_WORKSPACE'); }
		const profile = entry.profile;
		return this.run(profile, [command, ...args], {
			authorize: () => this.options.allowed(profile),
			host: entry.host === 'project' ? undefined : entry.host, timeout,
			started: child => { this.children.set(entry.id, child); this.options.changed(); }, log: text => { entry.logs = ((entry.logs || '') + redact(text)).slice(-64000); this.options.log?.(`[${entry.nativeId || entry.id}] ${redact(text)}`); }
		}).finally(() => this.children.delete(entry.id));
	}
	async prepare(profile, text, host) {
		if (!this.options.allowed(profile) || !['redevent', 'armotusitio'].includes(profile.id) || profile.id !== 'redevent' && host !== 'project' || !['codex', 'claude', 'project'].includes(host) || typeof text !== 'string' || !text.trim() || text.length > 32000 || text.includes('\0')) { throw new Error('HARNESS_REQUEST'); }
		if (this.all().some(entry => entry.project === profile.root && entry.creationUncertain)) { throw new Error('HARNESS_RECONCILE'); }
		if (this.busy.has(profile.root) || this.all().some(entry => entry.project === profile.root && entry.phase === 'stopping')) { throw new Error('HARNESS_BUSY'); }
		this.busy.add(profile.root);
		const entry: Entry = { id: randomUUID(), title: redact(text.trim().split(/\r?\n/)[0]).slice(0, 180), project: profile.root, profile, host, phase: 'preparing', origin: 'ide', startedAt: Date.now(), questions: [], knownQuestions: [], answers: {} };
		this.entries.set(entry.id, entry); this.changed();
		try {
			const current = await this.call(entry, 'progress', ['--json'], 15000);
			if (['stopping', 'cancelled'].includes(entry.phase)) { return entry.id; }
			if (current.value?.live === true) { throw new Error('HARNESS_BUSY'); }
			if (!current.value && !(current.error || '').includes('No active task; pass a <task-id>')) { throw new Error('HARNESS_PROGRESS'); }
			await fs.mkdir(this.options.directory, { recursive: true });
			entry.file = path.join(this.options.directory, `request-${entry.id}.txt`);
			await fs.writeFile(entry.file, text.trim(), { flag: 'wx', mode: 0o600 });
			if (['stopping', 'cancelled'].includes(entry.phase)) { await this.cleanInput(entry); return entry.id; }
			await this.preflight(entry);
		} catch (error) { if (entry.phase !== 'stopping' && entry.phase !== 'cancelled') { entry.phase = 'blocked'; entry.error = error.message; this.changed(); throw error; } }
		finally { this.busy.delete(profile.root); }
		return entry.id;
	}
	async preflight(entry) {
		const profile = entry.profile;
		entry.phase = 'preparing'; entry.error = undefined; this.changed();
		const result = await this.call(entry, 'preflight', ['auto', '--file', entry.file, ...answerArgs(entry.knownQuestions, entry.answers)], 1800000);
		if (['stopping', 'cancelled'].includes(entry.phase)) { return; }
		if (!this.options.allowed(profile) || this.disposed) { throw new Error('HARNESS_WORKSPACE'); }
		const data = result.value;
		if (!data || typeof data.ready !== 'boolean' || !Array.isArray(data.questions) || !Array.isArray(data.plan)) { throw new Error('HARNESS_PREFLIGHT'); }
		entry.questions = data.questions.filter(question => question && /^[a-z0-9_-]{1,100}$/i.test(question.id || '')).slice(0, 20);
		for (const question of entry.questions) { if (!entry.knownQuestions.some(item => item.id === question.id)) { entry.knownQuestions.push(question); } }
		entry.plan = data.plan.map(item => ({ domain: String(item.domain || '').slice(0, 80), nodes: (item.dag || []).slice(0, 100).map(node => ({ id: String(node.id || '').slice(0, 100), agent: String(node.agent || '').slice(0, 80), kind: node.kind, dependencies: node.dependencies || node.dependsOn || [] })) }));
		entry.warnings = [...(data.warnings || []), ...(data.checks || []).filter(item => item.severity === 'blocking' && item.status === 'fail')].slice(0, 25).map(item => ({ id: String(item.id || '').slice(0, 150), message: redact(item.message || item.title || ''), hint: redact(item.hint || item.action || ''), blocking: item.severity === 'blocking' }));
		if (entry.profile.id === 'redevent') { if ((await readProvider(entry.profile)).error) { throw new Error('HARNESS_PROVIDER'); } entry.providerRevision = await providerRevision(entry.profile); }
		entry.nativePlanRevision = createHash('sha256').update(JSON.stringify(data.plan, (key, value) => ['generatedAt', 'elapsedMs', 'durationMs'].includes(key) ? undefined : value)).digest('hex');
		entry.mode = data.mode;
		entry.planDigest = /^[a-f0-9]{64}$/i.test(data.planDigest || '') ? data.planDigest : undefined;
		entry.phase = entry.questions.length ? 'questions' : data.ready && result.code === 0 ? 'review' : 'blocked';
		entry.ready = data.ready && result.code === 0;
		if (entry.phase === 'blocked') { entry.error = 'HARNESS_PREFLIGHT'; }
		this.changed();
	}
	async answer(id, profile, answers) {
		const entry = this.entry(id, profile);
		if (entry.phase !== 'questions' || this.busy.has(profile.root)) { throw new Error('HARNESS_BUSY'); }
		answerArgs(entry.questions, answers);
		entry.answers = { ...entry.answers, ...answers };
		this.busy.add(profile.root);
		try { await this.preflight(entry); }
		catch (error) { if (!['stopping', 'cancelled'].includes(entry.phase)) { entry.phase = 'blocked'; entry.error = error.message; this.changed(); } }
		finally { this.busy.delete(profile.root); }
	}
	async edit(id, profile) {
		const entry = this.entry(id, profile);
		if (entry.nativeId || !entry.file || this.busy.has(profile.root) || !['review', 'questions', 'blocked'].includes(entry.phase)) { throw new Error('HARNESS_BUSY'); }
		const text = await fs.readFile(entry.file, 'utf8');
		await this.cleanInput(entry); this.entries.delete(id); this.changed();
		return text;
	}
	fingerprint(entry) { return createHash('sha256').update(JSON.stringify([entry.host, entry.providerRevision, entry.nativePlanRevision, entry.planDigest, entry.plan, (entry.warnings || []).filter(item => item.blocking)])).digest('hex'); }
	async start(id, profile) {
		const entry = this.entry(id, profile);
		if (entry.phase !== 'review' || !entry.ready || this.busy.has(profile.root)) { throw new Error('HARNESS_BUSY'); }
		this.busy.add(profile.root);
		try {
			// Recheck readiness and receipt freshness after an operator has reviewed the plan.
			const approved = this.fingerprint(entry);
			const previous = entry.plan;
			await this.preflight(entry);
			if (entry.phase === 'review' && approved !== this.fingerprint(entry)) { entry.previousPlan = previous; entry.error = 'HARNESS_PLAN_CHANGED'; this.changed(); return; }
			entry.reviewed = approved;
			if (entry.phase !== 'review') { return; }
			entry.phase = 'creating'; entry.creationUncertain = true; this.changed();
			const created = await this.call(entry, 'run', ['auto', '--file', entry.file, ...(entry.planDigest ? ['--plan-digest', entry.planDigest] : [])], 1800000);
			if (created.code !== 0 || !identityPattern.test(created.value?.id || '')) { if (profile.id !== 'redevent' && created.code === 2) { entry.creationUncertain = false; } throw new Error('HARNESS_CREATE'); }
			entry.nativeId = created.value.id; entry.creationUncertain = false; this.changed();
			await this.execute(entry, 'execute');
		} catch (error) { if (!['stopping', 'cancelled'].includes(entry.phase)) { entry.phase = entry.creationUncertain ? 'unknown' : 'blocked'; entry.error = entry.creationUncertain ? 'HARNESS_CREATE_UNKNOWN' : error.message; this.changed(); } }
		finally { this.busy.delete(profile.root); if (entry.nativeId) { await this.cleanInput(entry); } }
	}
	async execute(entry, command) {
		entry.phase = 'running'; entry.error = undefined; this.changed();
		const result = await this.call(entry, command, [entry.nativeId], 0);
		await this.refresh(entry.id, entry.profile);
		if (result.code === 0 && !['completed', 'failed'].includes(entry.progress?.state) && !['stopping', 'cancelled'].includes(entry.phase)) { await this.refresh(entry.id, entry.profile); }
		if (entry.phase === 'stopping' || entry.phase === 'cancelled') { return; }
		if (entry.progress?.state === 'completed' && result.code === 0) { entry.phase = 'completed'; }
		else if (entry.progress?.state === 'failed') { entry.phase = entry.progress.outcome === 'cancelled' || entry.cancellation ? 'cancelled' : 'failed'; }
		else { entry.phase = 'interrupted'; }
		entry.endedAt = entry.progress?.finishedAt || Date.now(); this.changed();
	}
	async refresh(id, profile) {
		this.entry(id, profile);
		const current = this.readings.get(id);
		if (current) { return current; }
		const reading = this.sampleProgress(id, profile);
		this.readings.set(id, reading);
		try { await reading; } finally { if (this.readings.get(id) === reading) { this.readings.delete(id); } }
	}
	async sampleProgress(id, profile, seed = undefined) {
		const entry = this.entry(id, profile);
		entry.profile = profile;
		if (!entry.nativeId) { return; }
		// Progress reads must not replace the owned execution handle used for cancellation.
		try {
			const result = seed ? { code: 0, value: seed } : await this.run(profile, ['progress', entry.nativeId, '--json'], { timeout: 15000, authorize: () => this.options.allowed(profile) });
			if (this.disposed || !this.options.allowed(profile)) { return; }
			if (result.code !== 0 || result.value?.id !== entry.nativeId) { throw new Error('HARNESS_PROGRESS'); }
			if (profile.id === 'redevent' && result.value?.state === 'failed' && !result.value.outcome) {
				const status = await this.run(profile, ['status', entry.nativeId], { timeout: 15000, authorize: () => this.options.allowed(profile) });
				if (!this.options.allowed(profile) || this.disposed) { return; }
				if (status.code === 0 && status.value?.id === entry.nativeId) { result.value.aborted = status.value.aborted; result.value.finishedAt ||= status.value.updatedAt; }
			}
			const progress = progressView(result.value);
			const evidence = [...(Array.isArray(result.value.nodes) ? result.value.nodes : []).map(node => ({ ...node, domain: node.domain || result.value.domain })), ...(Array.isArray(result.value.children) ? result.value.children : []).flatMap(child => (Array.isArray(child.nodes) ? child.nodes : []).map(node => ({ ...node, domain: node.domain || child.domain || child.id })))];
			entry.progress = progress;
			entry.evidence = Object.fromEntries(evidence.filter(node => logReference(node.log)).map(node => [`${node.domain || ''}/${node.id}`, node.log]));
			entry.progressError = false;
		} catch { entry.progressError = true; this.changed(); return; }
		entry.checkedAt = Date.now();
		if (entry.origin === 'external' && entry.progress.startedAt) { entry.startedAt = entry.progress.startedAt; }
		if (!entry.title && entry.progress.title) { entry.title = entry.progress.title; }
		if (!['creating'].includes(entry.phase) && !(this.children.has(entry.id) && entry.progress.state === 'stalled' && !entry.progress.outcome)) {
			const progress = entry.progress;
			if (progress.outcome === 'retry-pending' || progress.live) { entry.cancellation = false; entry.endedAt = undefined; }
			if (entry.phase !== 'stopping' || ['completed', 'failed'].includes(progress.state)) {
				entry.phase = progress.outcome === 'cancelled' || entry.cancellation && progress.state === 'failed' ? 'cancelled' : progress.state === 'completed' ? 'completed' : progress.state === 'failed' ? 'failed' : progress.live ? 'running' : progress.outcome === 'pending' || progress.outcome === 'retry-pending' ? 'pending' : progress.outcome === 'unknown' ? 'unknown' : 'interrupted';
			}
			if (['completed', 'failed', 'cancelled'].includes(entry.phase)) { entry.detectedEndedAt ||= Date.now(); entry.endedAt = progress.finishedAt || entry.endedAt || entry.detectedEndedAt; }
		}
		this.changed();
	}
	async observe(profile, nativeId, seed = undefined) {
		if (!this.options.allowed(profile) || !identityPattern.test(nativeId || '')) { throw new Error('HARNESS_WORKSPACE'); }
		let entry = this.all().find(item => item.project === profile.root && item.nativeId === nativeId);
		if (!entry) {
			entry = { id: randomUUID(), project: profile.root, profile, nativeId, host: 'project', origin: 'external', startedAt: Date.now(), phase: 'interrupted', questions: [], knownQuestions: [], answers: {}, restored: true };
			this.entries.set(entry.id, entry);
		}
		if (seed) { await this.sampleProgress(entry.id, profile, seed); } else { await this.refresh(entry.id, profile); }
		return entry.id;
	}
	async resume(id, profile) {
		const entry = this.entry(id, profile);
		entry.profile = profile;
		if (!entry.nativeId || this.busy.has(profile.root)) { throw new Error('HARNESS_BUSY'); }
		this.busy.add(profile.root);
		try {
			await this.refresh(id, profile);
			if (entry.progressError || entry.progress?.live || !['interrupted', 'failed', 'cancelled', 'pending'].includes(entry.phase)) { throw new Error('HARNESS_BUSY'); }
			if (['failed', 'cancelled'].includes(entry.phase)) {
				const retried = await this.call(entry, 'retry', [entry.nativeId, 'Reintento confirmado desde ArmotuSitio IDE']);
				if (retried.code !== 0) { throw new Error('HARNESS_RETRY'); }
				await this.execute(entry, 'execute');
			} else { await this.execute(entry, entry.phase === 'pending' ? 'execute' : 'resume'); }
		} catch (error) { entry.phase = 'blocked'; entry.error = error.message; this.changed(); }
		finally { this.busy.delete(profile.root); }
	}
	async stop(id, profile) {
		const entry = this.entry(id, profile);
		const child = this.children.get(id);
		if (profile.id !== 'redevent' && entry.nativeId && ['running', 'pending', 'interrupted', 'stopping'].includes(entry.phase)) {
			if (this.stops.has(profile.root)) { throw new Error('HARNESS_BUSY'); }
			this.stops.add(profile.root);
			const ownsBusy = !this.busy.has(profile.root); if (ownsBusy) { this.busy.add(profile.root); }
			entry.phase = 'stopping'; this.changed();
			try {
				const result = await this.run(profile, ['abort', entry.nativeId, 'Cancelada por el usuario desde ArmotuSitio IDE'], { timeout: 25000, authorize: () => this.options.allowed(profile) });
				if (![0, 3].includes(result.code)) { entry.error = 'HARNESS_STOP_PENDING'; }
				await this.refresh(id, profile);
			} catch { entry.error = 'HARNESS_STOP_PENDING'; }
			finally { this.stops.delete(profile.root); if (ownsBusy) { this.busy.delete(profile.root); } this.changed(); }
			return;
		}
		if (!child || !['preparing', 'running', 'blocked'].includes(entry.phase)) { throw new Error('HARNESS_NOT_OWNED'); }
		entry.phase = 'stopping'; this.changed();
		if (!await terminateChild(child)) { entry.phase = 'blocked'; entry.error = 'HARNESS_STOP_PENDING'; this.changed(); return; }
		if (entry.nativeId) {
			const progress = await this.run(profile, ['progress', entry.nativeId, '--json'], { timeout: 15000 });
			if (!progress.value) { entry.phase = 'blocked'; entry.error = 'HARNESS_STOP_PENDING'; this.changed(); return; }
			if (progress.value?.live) { entry.phase = 'blocked'; entry.error = 'HARNESS_STOP_PENDING'; this.changed(); return; }
			if (progress.value?.state !== 'completed' && progress.value?.state !== 'failed') {
				const aborted = await this.run(profile, ['abort', entry.nativeId, 'Cancelada por el usuario desde ArmotuSitio IDE'], { timeout: 15000 });
				if (aborted.code !== 0) { entry.phase = 'blocked'; entry.error = 'HARNESS_STOP_PENDING'; this.changed(); return; }
			}
			if (progress.value?.state === 'completed') { entry.phase = 'completed'; this.changed(); return; }
			if (progress.value?.state === 'failed') { await this.sampleProgress(id, profile, progress.value); return; }
		}
		entry.cancellation = true; entry.phase = 'cancelled'; entry.endedAt = Date.now(); this.changed();
		await this.cleanInput(entry);
	}
	async cleanInput(entry) { if (entry.file) { await fs.rm(entry.file, { force: true }); entry.file = undefined; } }
	async dispose() {
		this.disposed = true;
		// Closing an editor panel never terminates a user's native Harness execution.
		for (const entry of this.entries.values()) { if (!this.children.has(entry.id)) { await this.cleanInput(entry); } }
	}
}

module.exports = { HarnessWorkflow, nativeRun, answerArgs, progressView, redact, phases };
