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
const { readProvider } = require('./provider.ts');
const identityPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const phases = ['preparing', 'questions', 'review', 'creating', 'running', 'stopping', 'completed', 'failed', 'interrupted', 'blocked', 'cancelled'];

type Question = { id: string; question?: string; prompt?: string; message?: string; options?: string[] };
type Plan = { domain?: string; dag?: { id?: string; agent?: string; kind?: string }[] };
type NativeData = { title?: string; id?: string; state?: string; status?: string; live?: boolean; percent?: number; elapsedMs?: number; cause?: string; children?: NativeData[]; nodes?: { id?: string; agent?: string; status?: string; state?: string; elapsedMs?: number; durationMs?: number }[]; ready?: boolean; questions?: Question[]; plan?: Plan[]; checks?: { id?: string; status?: string; message?: string; action?: string; severity?: string }[]; warnings?: { id?: string; message?: string; title?: string; hint?: string; action?: string; severity?: string }[]; mode?: string };
type NativeOptions = { authorize?: () => boolean; node?: string; host?: string; timeout?: number; started?: (child: import('node:child_process').ChildProcess) => void; log?: (text: string) => void };
type Entry = { title?: string; id: string; project: string; profile: { id: string; root: string }; host: string; phase: string; startedAt: number; endedAt?: number; questions: Question[]; knownQuestions: Question[]; answers: Record<string, string>; file?: string; nativeId?: string; error?: string; mode?: string; ready?: boolean; plan?: { domain: string; nodes: { id: string; agent: string; kind?: string }[] }[]; warnings?: { id?: string; message: string; hint: string; blocking: boolean }[]; progress?: ReturnType<typeof progressView>; progressError?: boolean; checkedAt?: number; restored?: boolean };

/** Keep user prompts and credentials out of execution summaries and diagnostic output. */
function redact(value) {
	return String(value).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
		.replace(/(["']?(?:token|secret|password|api[_-]?key|connection[_-]?token)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,"'}]+)/gi, (_, prefix) => prefix + '"[redacted]"');
}

/** Invoke only the native Harness entrypoint, with literal arguments and bounded output. */
async function nativeRun(profile, args, options: NativeOptions = {}): Promise<{ code: number; value?: NativeData; error: string; output?: string }> {
	const root = await fs.realpath(profile.root);
	const directory = path.join(root, '.harness');
	if (profile.id !== 'redevent' || await fs.realpath(directory) !== directory) { throw new Error('HARNESS_UNSUPPORTED'); }
	const entry = path.join(directory, 'core.mjs');
	if (!(await fs.lstat(entry)).isFile()) { throw new Error('HARNESS_UNSUPPORTED'); }
	if (options.host) {
		const provider = await readProvider(profile);
		if (!['codex', 'claude'].includes(options.host) || provider.custom || provider.error) { throw new Error('HARNESS_PROVIDER'); }
	}
	if (options.authorize && !options.authorize()) { throw new Error('HARNESS_WORKSPACE'); }
	return new Promise((resolve, reject) => {
		const child = spawn(options.node || 'node', [entry, ...args], {
			cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32',
			env: { ...process.env, ...(options.host ? { HARNESS_HOST: options.host } : {}) },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		options.started?.(child);
		let stdout = '', stderr = '', overflow = false, timedOut = false;
		const limit = 4 * 1024 * 1024;
		const timer = options.timeout ? setTimeout(() => { timedOut = true; void terminateChild(child); }, options.timeout) : undefined;
		child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => { if (overflow) { return; } if (stdout.length + chunk.length > limit) { overflow = true; void terminateChild(child); } else { stdout += chunk; } });
		child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); options.log?.(redact(chunk)); });
		child.once('error', error => { clearTimeout(timer); reject(error); });
		child.once('close', code => {
			clearTimeout(timer);
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
	const nodes = [...(Array.isArray(value.nodes) ? value.nodes : []), ...(Array.isArray(value.children) ? value.children.flatMap(child => Array.isArray(child.nodes) ? child.nodes : []) : [])];
	return {
		id: value.id, title: typeof value.title === 'string' ? redact(value.title).slice(0, 180) : undefined, state: value.state, live: value.live === true,
		percent: Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100 ? value.percent : undefined,
		elapsedMs: Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : undefined,
		cause: typeof value.cause === 'string' ? redact(value.cause).slice(0, 1200) : undefined,
		nodes: nodes.slice(0, 100).map(node => ({
			id: String(node.id || node.agent || '').slice(0, 100), agent: String(node.agent || node.id || '').slice(0, 100),
			status: ['pending', 'running', 'passed', 'failed', 'blocked', 'skipped', 'cancelled', 'aborted'].includes(node.status || node.state) ? node.status || node.state : 'unknown',
			elapsedMs: Number.isFinite(node.elapsedMs ?? node.durationMs) && (node.elapsedMs ?? node.durationMs) >= 0 ? node.elapsedMs ?? node.durationMs : undefined
		}))
	};
}

/** Thin lifecycle adapter: native preflight, native persisted plan, native execution and native recovery. */
class HarnessWorkflow {
	options;
	run;
	entries = new Map<string, Entry>();
	busy = new Set();
	children = new Map();
	readings = new Map<string, Promise<void>>();
	persist = Promise.resolve();
	constructor(options) {
		this.options = options;
		this.run = options.run || nativeRun;
		const stored = options.storage.get('atsHarness.workflows.v1', []);
		for (const saved of (Array.isArray(stored) ? stored : []).slice(-40)) {
			if (saved && identityPattern.test(saved.id || '') && typeof saved.project === 'string' && identityPattern.test(saved.nativeId || '') && ['codex', 'claude', 'project'].includes(saved.host)) {
				this.entries.set(saved.id, { id: saved.id, project: saved.project, nativeId: saved.nativeId, host: saved.host, startedAt: Number.isSafeInteger(saved.startedAt) ? saved.startedAt : 0, phase: 'interrupted', profile: undefined, questions: [], knownQuestions: [], answers: {}, restored: true });
			}
		}
	}
	all() { return [...this.entries.values()]; }
	view(entry) {
		const { file, profile, answers, questions, knownQuestions, ...publicValue } = entry;
		return { ...publicValue, owned: this.children.has(entry.id), editable: !!entry.file && !entry.nativeId && !this.busy.has(entry.project), questions: (questions || []).map(question => ({ id: question.id, question: question.question || question.prompt || question.message || question.id, options: Array.isArray(question.options) ? question.options.filter(item => typeof item === 'string').slice(0, 8) : [] })) };
	}
	changed() {
		const rows = this.all().filter(entry => entry.nativeId).slice(-40).map(entry => ({ id: entry.id, project: entry.project, nativeId: entry.nativeId, host: entry.host, startedAt: entry.startedAt }));
		this.persist = this.persist.then(() => this.options.storage.update('atsHarness.workflows.v1', rows)).catch(() => this.options.log?.('No se pudo guardar la referencia de la tarea.\n'));
		this.options.changed();
	}
	entry(id, profile) {
		const entry = this.entries.get(id);
		if (!entry || entry.project !== profile.root || !this.options.allowed(profile)) { throw new Error('HARNESS_WORKSPACE'); }
		return entry;
	}
	async call(entry, command, args = [], timeout = 120000) {
		if (!this.options.allowed(entry.profile)) { throw new Error('HARNESS_WORKSPACE'); }
		return this.run(entry.profile, [command, ...args], {
			authorize: () => this.options.allowed(entry.profile),
			host: entry.host === 'project' ? undefined : entry.host, timeout,
			started: child => { this.children.set(entry.id, child); this.options.changed(); }, log: this.options.log
		}).finally(() => this.children.delete(entry.id));
	}
	async prepare(profile, text, host) {
		if (!this.options.allowed(profile) || profile.id !== 'redevent' || !['codex', 'claude', 'project'].includes(host) || typeof text !== 'string' || !text.trim() || text.length > 32000 || text.includes('\0')) { throw new Error('HARNESS_REQUEST'); }
		if (this.busy.has(profile.root)) { throw new Error('HARNESS_BUSY'); }
		this.busy.add(profile.root);
		const entry: Entry = { id: randomUUID(), title: redact(text.trim().split(/\r?\n/)[0]).slice(0, 180), project: profile.root, profile, host, phase: 'preparing', startedAt: Date.now(), questions: [], knownQuestions: [], answers: {} };
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
		entry.phase = 'preparing'; entry.error = undefined; this.changed();
		const result = await this.call(entry, 'preflight', ['auto', '--file', entry.file, ...answerArgs(entry.knownQuestions, entry.answers)], 1800000);
		if (['stopping', 'cancelled'].includes(entry.phase)) { return; }
		const data = result.value;
		if (!data || typeof data.ready !== 'boolean' || !Array.isArray(data.questions) || !Array.isArray(data.plan)) { throw new Error('HARNESS_PREFLIGHT'); }
		entry.questions = data.questions.filter(question => question && /^[a-z0-9_-]{1,100}$/i.test(question.id || '')).slice(0, 20);
		for (const question of entry.questions) { if (!entry.knownQuestions.some(item => item.id === question.id)) { entry.knownQuestions.push(question); } }
		entry.plan = data.plan.map(item => ({ domain: String(item.domain || '').slice(0, 80), nodes: (item.dag || []).slice(0, 100).map(node => ({ id: String(node.id || '').slice(0, 100), agent: String(node.agent || '').slice(0, 80), kind: node.kind })) }));
		entry.warnings = [...(data.warnings || []), ...(data.checks || []).filter(item => item.severity === 'blocking' && item.status === 'fail')].slice(0, 25).map(item => ({ id: String(item.id || '').slice(0, 150), message: redact(item.message || item.title || ''), hint: redact(item.hint || item.action || ''), blocking: item.severity === 'blocking' }));
		entry.mode = data.mode;
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
	async start(id, profile) {
		const entry = this.entry(id, profile);
		if (entry.phase !== 'review' || !entry.ready || this.busy.has(profile.root)) { throw new Error('HARNESS_BUSY'); }
		this.busy.add(profile.root);
		try {
			// Recheck readiness and receipt freshness after an operator has reviewed the plan.
			await this.preflight(entry);
			if (entry.phase !== 'review') { return; }
			entry.phase = 'creating'; this.changed();
			const created = await this.call(entry, 'run', ['auto', '--file', entry.file], 1800000);
			if (created.code !== 0 || !identityPattern.test(created.value?.id || '')) { throw new Error('HARNESS_CREATE'); }
			entry.nativeId = created.value.id; this.changed();
			await this.execute(entry, 'execute');
		} catch (error) { if (!['stopping', 'cancelled'].includes(entry.phase)) { entry.phase = 'blocked'; entry.error = error.message; this.changed(); } }
		finally { this.busy.delete(profile.root); if (entry.nativeId) { await this.cleanInput(entry); } }
	}
	async execute(entry, command) {
		entry.phase = 'running'; entry.error = undefined; this.changed();
		const result = await this.call(entry, command, [entry.nativeId], 0);
		await this.refresh(entry.id, entry.profile);
		if (result.code === 0 && !['completed', 'failed'].includes(entry.progress?.state) && !['stopping', 'cancelled'].includes(entry.phase)) { await this.refresh(entry.id, entry.profile); }
		if (entry.phase === 'stopping' || entry.phase === 'cancelled') { return; }
		if (entry.progress?.state === 'completed' && result.code === 0) { entry.phase = 'completed'; }
		else if (entry.progress?.state === 'failed') { entry.phase = 'failed'; }
		else { entry.phase = 'interrupted'; }
		entry.endedAt = Date.now(); this.changed();
	}
	async refresh(id, profile) {
		this.entry(id, profile);
		const current = this.readings.get(id);
		if (current) { return current; }
		const reading = this.sampleProgress(id, profile);
		this.readings.set(id, reading);
		try { await reading; } finally { if (this.readings.get(id) === reading) { this.readings.delete(id); } }
	}
	async sampleProgress(id, profile) {
		const entry = this.entry(id, profile);
		entry.profile = profile;
		if (!entry.nativeId) { return; }
		// Progress reads must not replace the owned execution handle used for cancellation.
		try {
			const result = await this.run(profile, ['progress', entry.nativeId, '--json'], { timeout: 15000, authorize: () => this.options.allowed(profile) });
			entry.progress = progressView(result.value); entry.progressError = false;
		} catch { entry.progressError = true; this.changed(); return; }
		entry.checkedAt = Date.now();
		if (!entry.title && entry.progress.title) { entry.title = entry.progress.title; }
		if (!['creating', 'stopping'].includes(entry.phase) && !(this.children.has(entry.id) && entry.progress.state === 'stalled')) {
			entry.phase = entry.progress.state === 'completed' ? 'completed' : entry.progress.state === 'failed' ? 'failed' : entry.progress.live ? 'running' : 'interrupted';
		}
		this.changed();
	}
	async observe(profile, nativeId) {
		if (!this.options.allowed(profile) || !identityPattern.test(nativeId || '')) { throw new Error('HARNESS_WORKSPACE'); }
		let entry = this.all().find(item => item.project === profile.root && item.nativeId === nativeId);
		if (!entry) {
			entry = { id: randomUUID(), project: profile.root, profile, nativeId, host: 'project', startedAt: Date.now(), phase: 'interrupted', questions: [], knownQuestions: [], answers: {}, restored: true };
			this.entries.set(entry.id, entry);
		}
		await this.refresh(entry.id, profile);
		return entry.id;
	}
	async resume(id, profile) {
		const entry = this.entry(id, profile);
		entry.profile = profile;
		if (!entry.nativeId || this.busy.has(profile.root)) { throw new Error('HARNESS_BUSY'); }
		this.busy.add(profile.root);
		try {
			await this.refresh(id, profile);
			if (entry.progressError || entry.progress?.live || !['interrupted', 'failed'].includes(entry.phase)) { throw new Error('HARNESS_BUSY'); }
			if (entry.phase === 'failed') {
				const retried = await this.call(entry, 'retry', [entry.nativeId, 'Reintento confirmado desde ArmotuSitio IDE']);
				if (retried.code !== 0) { throw new Error('HARNESS_RETRY'); }
				await this.execute(entry, 'execute');
			} else { await this.execute(entry, 'resume'); }
		} catch (error) { entry.phase = 'blocked'; entry.error = error.message; this.changed(); }
		finally { this.busy.delete(profile.root); }
	}
	async stop(id, profile) {
		const entry = this.entry(id, profile);
		const child = this.children.get(id);
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
		}
		entry.phase = 'cancelled'; entry.endedAt = Date.now(); this.changed();
		await this.cleanInput(entry);
	}
	async cleanInput(entry) { if (entry.file) { await fs.rm(entry.file, { force: true }); entry.file = undefined; } }
	async dispose() {
		// Closing an editor panel never terminates a user's native Harness execution.
		for (const entry of this.entries.values()) { if (!this.children.has(entry.id)) { await this.cleanInput(entry); } }
	}
}

module.exports = { HarnessWorkflow, nativeRun, answerArgs, progressView, redact, phases };
