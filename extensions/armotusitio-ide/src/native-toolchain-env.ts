/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Environment an agent process receives (block B): what toolchains need, never credentials. Pure: no I/O but `exists`. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ToolchainEnvironment {
	env: NodeJS.ProcessEnv;
	/** Toolchain cache folders a sandboxed writer may write to (Codex `--add-dir`); never a whole profile folder. */
	writableRoots: string[];
	/** Offline toolchain modes are applied (D5); false until dependencies are synchronized before the run. */
	offline: boolean;
}

const SYSTEM = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL', 'TZ'];
const TOOLCHAINS = ['GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOROOT', 'GOFLAGS', 'GOPROXY', 'GOPRIVATE', 'CARGO_HOME', 'RUSTUP_HOME', 'JAVA_HOME', 'GRADLE_USER_HOME', 'MAVEN_OPTS', 'DOTNET_ROOT', 'NUGET_PACKAGES', 'PNPM_HOME', 'NVM_HOME', 'NVM_SYMLINK', 'VOLTA_HOME', 'PYENV_ROOT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'COMPOSER_HOME', 'ANDROID_HOME'];
/** Provider authentication the CLIs already used before this profile existed. */
const PROVIDER_AUTH = ['CODEX_HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
const FORBIDDEN_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|^AWS_|^AZURE_|^GCP_|^GOOGLE_APPLICATION_CREDENTIALS$|^DATABASE_URL$/i;
/** A URL with a user or password embedded (`http://user:pass@proxy`). */
const EMBEDDED_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;

/** Whether a variable may reach an agent; provider authentication is the only named exception. */
export function allowedVariable(name: string, value: string): boolean {
	if (PROVIDER_AUTH.includes(name)) { return true; }
	return !FORBIDDEN_NAME.test(name) && !EMBEDDED_CREDENTIALS.test(value);
}

/**
 * Build the agent environment from the IDE's own. Missing profile folders are derived from the home folder,
 * because toolchains (Go's build cache, npm, pnpm) fail without them.
 */
export async function buildToolchainEnvironment(source: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (folder: string) => Promise<boolean>): Promise<ToolchainEnvironment> {
	const env: NodeJS.ProcessEnv = {};
	const names = [...SYSTEM, ...TOOLCHAINS, ...PROVIDER_AUTH, ...Object.keys(source).filter(name => name.startsWith('XDG_'))];
	for (const name of names) {
		const value = source[name];
		if (value && allowedVariable(name, value)) { env[name] = value; }
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

/** The agent environment of this IDE process. */
export function currentToolchainEnvironment(): Promise<ToolchainEnvironment> {
	return buildToolchainEnvironment(process.env, process.platform, pathExists);
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
