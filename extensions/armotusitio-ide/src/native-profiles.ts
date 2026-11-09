/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * AI profiles: several accounts of one provider, each with its own private config directory (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`) so credentials, settings and sessions never mix. The registry stores only ids, aliases and assignments;
 * never a token. An assignment points at a profile id (stable), never at an alias. Resolution is workspace assignment, then
 * the provider default, then nothing: an account whose login failed is never replaced by another one.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './native-chat.ts';
import { projectKey } from './native-permissions.ts';
import type { NativeProvider } from './native-providers.ts';
import { safeStorage, writeDurable } from './native-worktree-checkpoint.ts';

export const PROFILES_SCHEMA_VERSION = 1;
const MAX_BYTES = 256 * 1024;
const MAX_PROFILES = 32;
const MAX_ALIAS = 40;
const PROVIDERS: readonly NativeProvider[] = ['claude', 'codex'];
/** Environment variable that points each CLI at its private directory. */
const CONFIG_VARIABLE: Readonly<Record<NativeProvider, string>> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
/** Credentials a provider CLI reads from the environment: none may leak from the IDE into a profile's process. */
const INHERITED_CREDENTIALS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

export interface AiProfile { id: string; provider: NativeProvider; alias: string; createdAt: string }
type Assignment = Partial<Record<NativeProvider, string>>;
interface ProfilesFile { schemaVersion: number; profiles: AiProfile[]; defaults: Assignment; assignments: Record<string, Assignment> }

/**
 * What the real CLI says about a profile; `unknown` when it could not be told (never assumed to be logged in).
 * `connection-failed`: the status command ran and failed or timed out. `connecting`: a sign-in terminal is open (set by the UI, never by the CLI).
 */
export type AuthState = 'authenticated' | 'not-authenticated' | 'unknown' | 'cli-unavailable' | 'connection-failed' | 'connecting';
/** Runs the provider's own login-status command with the given environment; `undefined` when the CLI is not installed. */
export type ProfileExec = (provider: NativeProvider, env: NodeJS.ProcessEnv) => Promise<{ code: number; output: string } | undefined>;

function emptyFile(): ProfilesFile { return { schemaVersion: PROFILES_SCHEMA_VERSION, profiles: [], defaults: {}, assignments: {} }; }

function validAlias(alias: string): boolean { return alias.length >= 1 && alias.length <= MAX_ALIAS && !/[\x00-\x1f\x7f]/.test(alias); }

function valid(file: unknown): file is ProfilesFile {
	const value = file as Partial<ProfilesFile> | undefined;
	return !!value && typeof value === 'object' && value.schemaVersion === PROFILES_SCHEMA_VERSION && Array.isArray(value.profiles) && value.profiles.length <= MAX_PROFILES &&
		value.profiles.every(profile => typeof profile?.id === 'string' && /^[0-9a-f-]{36}$/.test(profile.id) && PROVIDERS.includes(profile.provider) && typeof profile.alias === 'string' && validAlias(profile.alias)) &&
		!!value.defaults && typeof value.defaults === 'object' && !!value.assignments && typeof value.assignments === 'object';
}

export class ProfileRegistry {
	private readonly directory: string;
	private readonly exec: ProfileExec;
	private readonly file: string;

	/** `directory` is private IDE storage (never a project folder); `exec` is injectable so tests need no real CLI. */
	constructor(directory: string, exec: ProfileExec) {
		this.directory = directory;
		this.exec = exec;
		this.file = path.join(directory, 'profiles.json');
	}

	async list(provider?: NativeProvider): Promise<AiProfile[]> {
		return (await this.read()).profiles.filter(profile => !provider || profile.provider === provider);
	}

	async get(id: string): Promise<AiProfile | undefined> { return (await this.read()).profiles.find(profile => profile.id === id); }

	configDirectory(profile: AiProfile): string { return path.join(this.directory, 'profiles', profile.id); }

	async add(provider: NativeProvider, alias: string): Promise<AiProfile> {
		return this.update(async file => {
			const name = alias.trim();
			if (!PROVIDERS.includes(provider)) { throw Error('HARNESS_PROVIDER_UNSUPPORTED'); }
			this.checkAlias(file, provider, name);
			if (file.profiles.length >= MAX_PROFILES) { throw Error('HARNESS_PROFILE_LIMIT'); }
			const profile: AiProfile = { id: randomUUID(), provider, alias: name, createdAt: new Date().toISOString() };
			await fs.mkdir(this.configDirectory(profile), { recursive: true, mode: 0o700 });
			file.profiles.push(profile);
			return profile;
		});
	}

	async rename(id: string, alias: string): Promise<AiProfile> {
		return this.update(async file => {
			const profile = this.require(file, id);
			const name = alias.trim();
			this.checkAlias(file, profile.provider, name, id);
			profile.alias = name;
			return { ...profile };
		});
	}

	/** Removes the profile, its private directory (its credentials with it) and every default or assignment that pointed at it. */
	async remove(id: string): Promise<void> {
		await this.update(async file => {
			const profile = this.require(file, id);
			await fs.rm(this.configDirectory(profile), { recursive: true, force: true });
			file.profiles = file.profiles.filter(item => item.id !== id);
			for (const scope of [file.defaults, ...Object.values(file.assignments)]) { if (scope[profile.provider] === id) { delete scope[profile.provider]; } }
		});
	}

	async setDefault(id: string): Promise<void> {
		await this.update(async file => { const profile = this.require(file, id); file.defaults[profile.provider] = id; });
	}

	async assign(root: string, id: string): Promise<void> {
		await this.update(async file => {
			const profile = this.require(file, id);
			const key = projectKey(root);
			file.assignments[key] = { ...file.assignments[key], [profile.provider]: id };
		});
	}

	async unassign(root: string, provider: NativeProvider): Promise<void> {
		await this.update(async file => { delete file.assignments[projectKey(root)]?.[provider]; });
	}

	/** Workspace assignment, then the provider default, then `undefined` (the UI asks); authentication is never consulted. */
	async resolve(provider: NativeProvider, root: string): Promise<AiProfile | undefined> {
		const file = await this.read();
		const id = file.assignments[projectKey(root)]?.[provider] ?? file.defaults[provider];
		return file.profiles.find(profile => profile.id === id && profile.provider === provider);
	}

	/** Which profile is the provider default and which one this workspace uses, for listings. */
	async placement(root?: string): Promise<{ defaults: Assignment; workspace: Assignment }> {
		const file = await this.read();
		return { defaults: { ...file.defaults }, workspace: root ? { ...file.assignments[projectKey(root)] } : {} };
	}

	/** Workspaces (project keys) that use this profile, for the accounts screen. */
	async workspacesOf(id: string): Promise<string[]> {
		return Object.entries((await this.read()).assignments).filter(([, assignment]) => Object.values(assignment).includes(id)).map(([key]) => key);
	}

	/** Terminal environment for signing in: the profile directory set, every other credential variable removed (`null` unsets). */
	terminalEnvironment(profile: AiProfile): Record<string, string | null> {
		return { ...Object.fromEntries(INHERITED_CREDENTIALS.map(name => [name, null])), [CONFIG_VARIABLE[profile.provider]]: this.configDirectory(profile) };
	}

	/** Environment for one profile's process: nothing inherited from the IDE can carry another account's credentials. */
	environment(profile: AiProfile, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {};
		for (const [name, value] of Object.entries(base)) { if (!INHERITED_CREDENTIALS.some(blocked => blocked.toLowerCase() === name.toLowerCase())) { env[name] = value; } }
		env[CONFIG_VARIABLE[profile.provider]] = this.configDirectory(profile);
		return env;
	}

	/** The real login state of the profile's directory, asked to the provider CLI. */
	async authState(profile: AiProfile, base: NodeJS.ProcessEnv): Promise<AuthState> {
		let result: Awaited<ReturnType<ProfileExec>>;
		try { result = await this.exec(profile.provider, this.environment(profile, base)); } catch { return 'connection-failed'; }
		if (!result) { return 'cli-unavailable'; }
		if (profile.provider === 'claude') {
			try { return (JSON.parse(result.output) as { loggedIn?: unknown }).loggedIn === true ? 'authenticated' : 'not-authenticated'; } catch { return 'unknown'; }
		}
		const text = result.output.toLowerCase();
		if (text.includes('not logged in')) { return 'not-authenticated'; }
		return result.code === 0 && text.includes('logged in') ? 'authenticated' : 'unknown';
	}

	private checkAlias(file: ProfilesFile, provider: NativeProvider, alias: string, except?: string): void {
		if (!validAlias(alias)) { throw Error('HARNESS_PROFILE_ALIAS_INVALID'); }
		if (file.profiles.some(profile => profile.provider === provider && profile.id !== except && profile.alias.toLowerCase() === alias.toLowerCase())) { throw Error('HARNESS_PROFILE_ALIAS_TAKEN'); }
	}

	private require(file: ProfilesFile, id: string): AiProfile {
		const profile = file.profiles.find(item => item.id === id);
		if (!profile) { throw Error('HARNESS_PROFILE_NOT_FOUND'); }
		return profile;
	}

	/** Read-modify-write under the cross-window lock; a corrupt or newer file is reported, never overwritten. */
	private async update<T>(mutate: (file: ProfilesFile) => Promise<T>): Promise<T> {
		await safeStorage(this.directory);
		return withFileLock(this.file + '.lock', async () => {
			const file = await this.read();
			const result = await mutate(file);
			await writeDurable(this.file, file, false, MAX_BYTES);
			return result;
		});
	}

	private async read(): Promise<ProfilesFile> {
		try {
			const stat = await fs.lstat(this.file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) { throw Error('HARNESS_PROFILES_UNSAFE'); }
			const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
			if (!valid(parsed)) { throw Error('HARNESS_PROFILES_UNSAFE'); }
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return emptyFile(); }
			throw error instanceof SyntaxError ? Error('HARNESS_PROFILES_UNSAFE') : error;
		}
	}
}
