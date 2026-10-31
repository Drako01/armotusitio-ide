/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * A real project engine that speaks protocol v2 including the writer lease. It is a separate Node process
 * started exactly like a project's `.harness/core.mjs`, so tests exercise the genuine transport, not a mock.
 * `behavior.json` selects honest or hostile behaviour; the engine keeps its tasks and lease on disk.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type EngineMode = 'honest' | 'ignore-fence' | 'ignore-lease' | 'wrong-lease-id' | 'busy-ack' | 'mutate-on-lease';
export const REFERENCE_CAPABILITIES = ['durable-tasks', 'writer-lease', 'verification-gates', 'bounded-processes'];

const ENGINE = [
	'import fs from "node:fs";',
	'import path from "node:path";',
	'import { fileURLToPath } from "node:url";',
	'const here = path.dirname(fileURLToPath(import.meta.url));',
	'const state = path.join(here, "state");',
	'const arg = name => process.argv[process.argv.indexOf(name) + 1];',
	'const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(state, file), "utf8")); } catch { return fallback; } };',
	'const write = (file, value) => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, file), JSON.stringify(value)); };',
	'const print = value => console.log(JSON.stringify(value));',
	'const command = process.argv[2]; const nonce = arg("--nonce");',
	'const behavior = read("behavior.json", { mode: "honest", report: null });',
	'const tasks = read("tasks.json", []);',
	'const lease = read("lease.json", null);',
	'if (command === "capabilities") { print({ schemaVersion: 2, nonce, capabilities: behavior.report ?? read("declared.json", []) }); }',
	'else if (command === "ide-status") { print({ schemaVersion: 2, nonce, executionEnabled: false, tasks }); }',
	'else if (command === "ide-writer-lease") {',
	'	const running = tasks.filter(task => task.status === "running").length;',
	'	const leaseId = "a1".repeat(16);',
	'	if (behavior.mode !== "busy-ack") { write("lease.json", { leaseId, epoch: Number(arg("--fence-epoch")) }); }',
	'	if (behavior.mode === "mutate-on-lease") { fs.appendFileSync(fileURLToPath(import.meta.url), " "); }',
	'	print({ schemaVersion: 2, nonce, action: "lease", leaseId, fenceEpoch: behavior.mode === "ignore-fence" ? 0 : Number(arg("--fence-epoch")), state: behavior.mode === "busy-ack" ? "busy" : "quiescent", runningTasks: behavior.mode === "busy-ack" ? 1 : running });',
	'}',
	'else if (command === "ide-writer-release") {',
	'	fs.rmSync(path.join(state, "lease.json"), { force: true });',
	'	print({ schemaVersion: 2, nonce, action: "release", leaseId: behavior.mode === "wrong-lease-id" ? "b2".repeat(16) : arg("--lease-id"), fenceEpoch: Number(arg("--fence-epoch")) });',
	'}',
	'else if (command === "start-task") {',
	'	// The engine\'s own scheduler: an honest engine refuses to start work while the IDE holds the lease.',
	'	if (lease && behavior.mode !== "ignore-lease") { console.error("lease held"); process.exit(2); }',
	'	write("tasks.json", [...tasks, { id: "task_" + (tasks.length + 1), status: "running" }]);',
	'	print({ started: true });',
	'}',
	'else { process.exit(1); }'
].join('\n');

export interface ReferenceEngine {
	root: string;
	setMode(mode: EngineMode): Promise<void>;
	/** Runs an engine command as the engine's own scheduler would; rejects on a non-zero exit. */
	command(...args: string[]): Promise<string>;
	cleanup(): Promise<void>;
}

export async function referenceEngine(options: { root?: string; capabilities?: string[]; mode?: EngineMode; tasks?: Array<{ id: string; status: string }> } = {}): Promise<ReferenceEngine> {
	const root = await fs.realpath(options.root ?? await fs.mkdtemp(path.join(os.tmpdir(), 'ats-reference-engine-')));
	const harness = path.join(root, '.harness');
	const capabilities = options.capabilities ?? REFERENCE_CAPABILITIES;
	await fs.mkdir(path.join(harness, 'manifests'), { recursive: true });
	await fs.mkdir(path.join(harness, 'state'), { recursive: true });
	await fs.writeFile(path.join(harness, 'manifests', 'ide-capabilities.json'), JSON.stringify({ schemaVersion: 2, engine: 'project', capabilities }));
	await fs.writeFile(path.join(harness, 'manifests', 'ide-gates.json'), JSON.stringify({ schemaVersion: 1, gates: [{ id: 'lint', dependsOn: [], resources: [] }] }));
	await fs.writeFile(path.join(harness, 'state', 'declared.json'), JSON.stringify(capabilities));
	await fs.writeFile(path.join(harness, 'state', 'tasks.json'), JSON.stringify(options.tasks ?? []));
	await fs.writeFile(path.join(harness, 'core.mjs'), ENGINE);
	const setMode = (mode: EngineMode): Promise<void> => fs.writeFile(path.join(harness, 'state', 'behavior.json'), JSON.stringify({ mode, report: null }));
	await setMode(options.mode ?? 'honest');
	return {
		root, setMode,
		command: (...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(harness, 'core.mjs'), ...args], { cwd: root }, (error, stdout) => error ? reject(error) : resolve(stdout))),
		cleanup: () => fs.rm(root, { recursive: true, force: true })
	};
}
