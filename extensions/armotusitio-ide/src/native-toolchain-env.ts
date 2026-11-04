/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Environment an agent process receives (block B): what toolchains need, never credentials. Pure: no I/O but `exists`. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveNodeRuntime, type NativeRuntimeHost } from './native-runtime.ts';

export interface ToolchainEnvironment {
	env: NodeJS.ProcessEnv;
	/** Toolchain cache folders a sandboxed writer may write to (Codex `--add-dir`); never a whole profile folder. */
	writableRoots: string[];
	/** Offline toolchain modes are applied (D5); false until dependencies are synchronized before the run. */
	offline: boolean;
}

const SYSTEM = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL', 'TZ',
	// Windows basics that MSBuild, dotnet, Python, git and native installers read; none is a credential.
	'SystemDrive', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'ALLUSERSPROFILE', 'PUBLIC', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
	'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'PSModulePath', 'LOGONSERVER', 'SESSIONNAME',
	// Corporate or local certificate authorities, so HTTPS keeps working behind an inspecting proxy.
	'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];
const TOOLCHAINS = ['GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOROOT', 'GOFLAGS', 'GOPROXY', 'GOPRIVATE', 'CARGO_HOME', 'RUSTUP_HOME', 'JAVA_HOME', 'GRADLE_USER_HOME', 'MAVEN_OPTS', 'DOTNET_ROOT', 'NUGET_PACKAGES', 'PNPM_HOME', 'NVM_HOME', 'NVM_SYMLINK', 'VOLTA_HOME', 'PYENV_ROOT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'COMPOSER_HOME', 'ANDROID_HOME'];
/** Provider authentication the CLIs already used before this profile existed. */
const PROVIDER_AUTH = ['CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
const FORBIDDEN_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|^AWS_|^AZURE_|^GCP_|^GOOGLE_APPLICATION_CREDENTIALS$|^DATABASE_URL$/i;
/** A URL with a user or password embedded (`http://user:pass@proxy`). */
const EMBEDDED_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;
/**
 * Agent runs are unattended: git and corepack must fail instead of waiting for a prompt nobody sees.
 * pnpm switches to the version a project pins (`packageManager`) through a junction in `PNPM_HOME/.tools`; a sandboxed Codex
 * process cannot cross it (Windows error 448, untrusted mount point), so no Harness preflight could run. Use the pnpm on PATH.
 */
const AGENT_DEFAULTS = { GIT_TERMINAL_PROMPT: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_manage_package_manager_versions: 'false', pnpm_config_manage_package_manager_versions: 'false' };

/** Whether a variable may reach an agent; provider authentication is the only named exception. */
export function allowedVariable(name: string, value: string): boolean {
	if (PROVIDER_AUTH.includes(name)) { return true; }
	return !FORBIDDEN_NAME.test(name) && !EMBEDDED_CREDENTIALS.test(value);
}

/**
 * Build the agent environment from the IDE's own. Missing profile folders are derived from the home folder,
 * because toolchains (Go's build cache, npm, pnpm) fail without them.
 */
export async function buildToolchainEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (folder: string) => Promise<boolean>, realFolder: (folder: string) => Promise<string> = async folder => folder): Promise<ToolchainEnvironment> {
	const env: NodeJS.ProcessEnv = { ...AGENT_DEFAULTS };
	const names = [...SYSTEM, ...TOOLCHAINS, ...PROVIDER_AUTH, ...Object.keys(source).filter(name => name.startsWith('XDG_'))];
	for (const name of names) {
		if (platform === 'win32' && name === 'Path') { continue; }
		const key = platform === 'win32' ? Object.keys(source).find(key => key.toLowerCase() === name.toLowerCase()) : name;
		const value = key ? source[key] : undefined;
		if (value && allowedVariable(name, value)) { env[name] = value; }
	}
	const separator = platform === 'win32' ? ';' : ':';
	for (const name of ['PATH', 'Path']) {
		if (env[name]) { env[name] = (await Promise.all(env[name].split(separator).map(realFolder))).join(separator); }
	}
	const join = platform === 'win32' ? path.win32.join : path.posix.join;
	const home = env.USERPROFILE || env.HOME;
	if (platform === 'win32' && home) {
		env.LOCALAPPDATA ??= join(home, 'AppData', 'Local');
		env.APPDATA ??= join(home, 'AppData', 'Roaming');
	}
	const caches = toolchainCaches(env, platform, home);
	const present = await Promise.all(caches.map(exists));
	return { env, writableRoots: caches.filter((_, index) => present[index]), offline: false };
}

/** Whether a file or folder exists, without blocking the extension host. */
export function pathExists(file: string): Promise<boolean> {
	return fs.access(file).then(() => true, () => false);
}

/**
 * A folder with its links resolved, or as given when it does not exist. A sandboxed agent cannot cross a symlink or junction
 * (Windows error 448), and nvm-windows exposes Node through one (`C:
vm4w
odejs`), so PATH must name the real folder.
 */
export function realFolder(folder: string): Promise<string> {
	return fs.realpath(folder).catch(() => folder);
}

/**
 * The host can execute JavaScript with Electron even when `node` is missing from PATH. Package scripts and their children
 * need a real Node executable too: resolve the same runtime once and expose its canonical directory to the whole tree.
 * Collapse Windows PATH aliases before spawn, which otherwise keeps just one case-insensitive key.
 */
export async function withNodeRuntime(source: NodeJS.ProcessEnv, host?: NativeRuntimeHost): Promise<NodeJS.ProcessEnv> {
	const env = { ...source };
	const runtime = await resolveNodeRuntime(env, host);
	const keys = Object.keys(env).filter(key => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
	const entries = keys.flatMap(key => (env[key] ?? '').split(path.delimiter)).filter(Boolean);
	for (const key of keys) { delete env[key]; }
	const directories = runtime.embeddedNode ? entries : [path.dirname(runtime.executable), ...entries];
	const seen = new Set<string>();
	env.PATH = directories.filter(directory => {
		const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
		if (seen.has(key)) { return false; }
		seen.add(key); return true;
	}).join(path.delimiter);
	return env;
}

/** The agent environment of this IDE process. */
export async function currentToolchainEnvironment(): Promise<ToolchainEnvironment> {
	const profile = await buildToolchainEnvironment(process.env, process.platform, pathExists, realFolder);
	return { ...profile, env: await withNodeRuntime(profile.env) };
}

/** Default cache folders of each toolchain, unless the environment moves them. */
function toolchainCaches(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string | undefined): string[] {
	if (!home) { return []; }
	const join = platform === 'win32' ? path.win32.join : path.posix.join;
	const local = platform === 'win32' ? env.LOCALAPPDATA! : env.XDG_CACHE_HOME || join(home, '.cache');
	const goPath = env.GOPATH?.split(platform === 'win32' ? ';' : ':')[0] || join(home, 'go');
	const roots = [
		env.GOCACHE || join(local, 'go-build'),
		env.GOMODCACHE || join(goPath, 'pkg', 'mod'),
		platform === 'win32' ? join(local, 'npm-cache') : join(home, '.npm'),
		platform === 'win32' ? join(local, 'pnpm', 'store') : join(home, '.local', 'share', 'pnpm', 'store'),
		env.CARGO_HOME || join(home, '.cargo'),
		env.NUGET_PACKAGES || join(home, '.nuget', 'packages'),
		env.GRADLE_USER_HOME || join(home, '.gradle'),
		platform === 'win32' ? join(local, 'pip', 'cache') : join(local, 'pip')
	];
	return [...new Set(roots)];
}
