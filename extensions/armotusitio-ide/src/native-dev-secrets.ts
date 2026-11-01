/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Development secrets for tests (block V): values live only in the OS keychain (`SecretStorage`), reach only the
 * commands each secret allows, and are redacted from any output in their common encodings. Metadata never holds values.
 */

export interface SecretMeta { name: string; commands: string[]; createdAt: string; lastUsedAt?: string; uses: number }
/** The keychain (`context.secrets`) and a small metadata store (`globalState`), injected by the integration. */
export interface SecretBackends {
	get(key: string): PromiseLike<string | undefined>;
	store(key: string, value: string): PromiseLike<void>;
	delete(key: string): PromiseLike<void>;
	metadata(): SecretMeta[];
	saveMetadata(value: SecretMeta[]): PromiseLike<void>;
}
export interface DevSecrets {
	/** Variables for one allowed command in a project; never part of a prompt or journal. */
	forCommand(projectKey: string, command: string, args: readonly string[], cwd: string): Promise<Record<string, string>>;
	/** Text with every value used in this session (and its encoded variants) replaced. */
	redact(text: string): string;
}

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const keyOf = (projectKey: string, name: string) => 'ats.secret.' + projectKey + '.' + name;

/** `go test` inside `apps/api` is written `go test @apps/api`; a rule without `@` applies in any folder. */
export function commandAllowed(rules: readonly string[], command: string, args: readonly string[], cwd: string): boolean {
	const line = [command, ...args].join(' ');
	return rules.some(rule => {
		const [prefix, folder] = rule.split(' @');
		return (line === prefix || line.startsWith(prefix + ' ')) && (!folder || cwd === folder || cwd.startsWith(folder + '/'));
	});
}

/** The value and the forms in which a program could print it. */
export function secretVariants(value: string): string[] {
	const variants = new Set([value, encodeURIComponent(value), Buffer.from(value).toString('base64'), JSON.stringify(value).slice(1, -1), value.replace(/'/g, '\\\'')]);
	return [...variants].filter(variant => variant.length >= 4).sort((left, right) => right.length - left.length);
}

export class KeychainDevSecrets implements DevSecrets {
	private readonly backends: SecretBackends;
	private readonly used = new Set<string>();
	constructor(backends: SecretBackends) { this.backends = backends; }

	list(projectKey: string): SecretMeta[] { return this.backends.metadata().filter(meta => meta.name.startsWith(projectKey + ':')).map(meta => ({ ...meta, name: meta.name.slice(projectKey.length + 1) })); }

	async set(projectKey: string, name: string, value: string, commands: string[]): Promise<void> {
		if (!NAME.test(name) || !value || commands.length === 0 || commands.some(rule => !rule.trim())) { throw Error('HARNESS_ARGUMENTS'); }
		await this.backends.store(keyOf(projectKey, name), value);
		const others = this.backends.metadata().filter(meta => meta.name !== projectKey + ':' + name);
		await this.backends.saveMetadata([...others, { name: projectKey + ':' + name, commands, createdAt: new Date().toISOString(), uses: 0 }]);
	}

	async remove(projectKey: string, name: string): Promise<void> {
		await this.backends.delete(keyOf(projectKey, name));
		await this.backends.saveMetadata(this.backends.metadata().filter(meta => meta.name !== projectKey + ':' + name));
	}

	async forCommand(projectKey: string, command: string, args: readonly string[], cwd: string): Promise<Record<string, string>> {
		const env: Record<string, string> = {};
		const metadata = this.backends.metadata();
		let changed = false;
		for (const meta of metadata) {
			if (!meta.name.startsWith(projectKey + ':') || !commandAllowed(meta.commands, command, args, cwd)) { continue; }
			const name = meta.name.slice(projectKey.length + 1);
			const value = await this.backends.get(keyOf(projectKey, name));
			if (!value) { continue; }
			env[name] = value; this.used.add(value);
			// Audit of use: which command and when, never the value.
			meta.uses++; meta.lastUsedAt = new Date().toISOString(); changed = true;
		}
		if (changed) { await this.backends.saveMetadata(metadata); }
		return env;
	}

	redact(text: string): string {
		let result = text;
		for (const value of this.used) { for (const variant of secretVariants(value)) { result = result.split(variant).join('[REDACTED]'); } }
		return result;
	}
}
