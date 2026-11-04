/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Shared real Electron -> runner -> Node bootstrap -> isolated Python -> package-script transport fixture. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import type { RunnerConfig } from '../src/ats-runner.ts';

const repository = path.resolve(import.meta.dirname, '../../..');
const exists = (file: string): Promise<boolean> => fs.stat(file).then(stat => stat.isFile(), () => false);

async function firstFile(candidates: Array<string | undefined>): Promise<string | undefined> {
	for (const file of candidates) { if (file && await exists(file)) { return file; } }
	return undefined;
}

async function findPython(): Promise<string | undefined> {
	const explicit = await firstFile([process.env.ATS_TEST_PYTHON_PATH, process.env.HARNESS_PYTHON]);
	if (explicit) { return explicit; }
	for (const [command, prefix] of [['python', []], ['py', ['-3']]] as const) {
		const result = spawnSync(command, [...prefix, '-I', '-S', '-B', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
		const found = result.status === 0 ? result.stdout.trim() : undefined;
		if (found && path.isAbsolute(found) && await exists(found)) { return found; }
	}
	return undefined;
}

export interface ToolchainFixture {
	base: string;
	root: string;
	runnerFile: string;
	configFile: string;
	electron: string;
	env: NodeJS.ProcessEnv;
	realNode: string;
	config: RunnerConfig;
	cleanup(): Promise<void>;
}

/** No actual project, credential, provider or service is used. `undefined` means local transport binaries are unavailable. */
export async function createToolchainFixture(options: { nodeHint?: boolean; delegated?: boolean } = {}): Promise<ToolchainFixture | undefined> {
	if (process.platform !== 'win32' || process.versions.electron) { return undefined; }
	const electron = await firstFile([
		process.env.ATS_TEST_ELECTRON_PATH,
		path.join(repository, '.build', 'electron', 'ArmotuSitio IDE.exe'),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'ArmotuSitio IDE', 'ArmotuSitio IDE.exe')
	]);
	const pnpm = await firstFile([
		process.env.ATS_TEST_PNPM_PATH,
		process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'pnpm.exe'),
		process.env.PNPM_HOME && path.join(process.env.PNPM_HOME, 'pnpm.exe')
	]);
	const python = await findPython();
	if (!electron || !pnpm || !python) { return undefined; }
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-electron-toolchain-')));
	const cleanup = () => fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	try {
		const root = path.join(base, 'project');
		const bin = path.join(base, 'tools');
		const harness = path.join(root, '.harness');
		await fs.mkdir(harness, { recursive: true }); await fs.mkdir(bin);
		await fs.copyFile(pnpm, path.join(bin, 'pnpm.exe'));
		const realNode = await fs.realpath(process.execPath);
		const nodeLink = path.join(base, 'nvm-node');
		await fs.symlink(path.dirname(realNode), nodeLink, 'junction');
		await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'runner-transport-fixture', private: true, scripts: { preflight: 'node .harness/bootstrap.mjs preflight' } }));
		await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ type: 'commonjs' }));
		await fs.writeFile(path.join(harness, 'core.mjs'), 'import "./bootstrap.mjs";\n');
		await fs.writeFile(path.join(harness, 'bootstrap.mjs'), [
			'import { spawn } from "node:child_process";',
			'import path from "node:path"; import { fileURLToPath } from "node:url";',
			'const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.py");',
			'const child = spawn(' + JSON.stringify(python) + ', ["-I", "-S", "-B", cli, ...process.argv.slice(2)], { env: { ...process.env, HARNESS_BOOTSTRAPPED: "1", PYTHONDONTWRITEBYTECODE: "1", FIXTURE_NODE_EXECUTABLE: process.execPath }, shell: false, windowsHide: true, stdio: "inherit" });',
			'child.on("error", error => { console.error(error.code); process.exitCode = 127; });',
			'child.on("close", code => { process.exitCode = code ?? 127; });'
		].join('\n'));
		await fs.writeFile(path.join(harness, 'cli.py'), [
			'import json, os, shutil, subprocess, sys',
			'from pathlib import Path',
			'def windows_spec(command, args):',
			'    resolved = shutil.which(command)',
			'    if resolved and Path(resolved).suffix.lower() in (".cmd", ".bat"):',
			'        quote = lambda value: "\\\'" + value.replace("\\\'", "\\\'\\\'") + "\\\'"',
			'        ps = str(Path(os.environ.get("SystemRoot", "C:\\\\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe")',
			'        return ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference=\\\'Stop\\\'; & " + quote(resolved) + " " + " ".join(quote(value) for value in args) + "; exit $LASTEXITCODE"]',
			'    return command, args',
			'try:',
			'    if sys.argv[1] == "preflight":',
			'        result = subprocess.run(["node", "--version"], env=dict(os.environ), capture_output=True, text=True)',
			'        if result.returncode == 0: print("TOOLCHAIN_PROBE " + json.dumps({"version": result.stdout.strip(), "executable": os.environ.get("FIXTURE_NODE_EXECUTABLE")}))',
			'        else: sys.stderr.write(result.stderr)',
			'        sys.exit(result.returncode)',
			'    split = sys.argv.index("--")',
			'    command, args = sys.argv[split + 1], sys.argv[split + 2:]',
			'    if command not in ("node", "pnpm"): raise ValueError("fixture command policy denied")',
			'    executable, arguments = windows_spec(command, args)',
			'    child = subprocess.Popen([executable, *arguments], cwd=os.getcwd(), env=dict(os.environ), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)',
			'    out, err = child.communicate(timeout=15)',
			'    sys.stdout.buffer.write(out); sys.stderr.buffer.write(err); sys.exit(child.returncode)',
			'except OSError as error:',
			'    print(str(error), file=sys.stderr); sys.exit(127)'
		].join('\n'));
		const runnerFile = path.join(base, 'ats-runner.js');
		await build({ entryPoints: [path.join(repository, 'extensions', 'armotusitio-ide', 'src', 'ats-runner.ts')], outfile: runnerFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
		const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
		const env: NodeJS.ProcessEnv = {
			PATH: [bin, path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD',
			SystemRoot: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
			USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
			TEMP: process.env.TEMP, TMP: process.env.TMP,
			npm_config_manage_package_manager_versions: 'false', pnpm_config_manage_package_manager_versions: 'false',
			COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_update_notifier: 'false', CI: '1'
		};
		if (options.nodeHint !== false) { env.NVM_SYMLINK = nodeLink; }
		const delegated = options.delegated !== false;
		const config: RunnerConfig = {
			schemaVersion: 1, root, env, logDirectory: path.join(base, 'logs'),
			policy: { subprojects: [{ path: '.', ecosystem: 'node', packageManager: 'pnpm', scripts: ['preflight'] }], delegate: delegated, extras: [] },
			...(delegated ? { delegateEntry: path.join(harness, 'core.mjs') } : {})
		};
		const configFile = path.join(base, 'runner.json');
		await fs.writeFile(configFile, JSON.stringify(config));
		return { base, root, runnerFile, configFile, electron, env, realNode, config, cleanup };
	} catch (error) { await cleanup(); throw error; }
}
