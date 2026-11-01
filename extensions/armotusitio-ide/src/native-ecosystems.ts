/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Ecosystem and monorepo detection (block C): bounded marker search, never executing project code. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type Ecosystem = 'go' | 'node' | 'python' | 'rust' | 'dotnet' | 'java' | 'php' | 'ruby';
export interface Subproject {
	/** Project-relative folder with forward slashes; '.' is the root. */
	path: string;
	ecosystem: Ecosystem;
	/** Node only: package manager from the lockfile and the scripts declared in package.json. */
	packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
	scripts?: string[];
	/** Java only: a wrapper script present in the folder. */
	wrapper?: string;
}

const MAX_DEPTH = 4;
const MAX_ENTRIES = 4000;
const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'target', 'out', 'bin', 'obj', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.cache', '.artifacts', 'coverage', '.harness']);
const MARKERS: Array<[RegExp, Ecosystem]> = [
	[/^go\.mod$/, 'go'], [/^package\.json$/, 'node'], [/^(pyproject\.toml|setup\.py|requirements[\w.-]*\.txt)$/, 'python'], [/^Cargo\.toml$/, 'rust'],
	[/\.(csproj|sln)$/, 'dotnet'], [/^(pom\.xml|build\.gradle(\.kts)?)$/, 'java'], [/^composer\.json$/, 'php'], [/^Gemfile$/, 'ruby']
];
const LOCKFILES: Array<[string, Subproject['packageManager']]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm']];

async function nodeDetails(folder: string, names: Set<string>, root: string): Promise<Pick<Subproject, 'packageManager' | 'scripts'>> {
	// A workspace package inherits the lockfile of the nearest ancestor that has one.
	let manager: Subproject['packageManager'];
	for (let current = folder; !manager; current = path.dirname(current)) {
		const here = current === folder ? names : new Set(await fs.readdir(current).catch(() => [] as string[]));
		manager = LOCKFILES.find(([file]) => here.has(file))?.[1];
		if (current === root || path.dirname(current) === current) { break; }
	}
	let scripts: string[] = [];
	try {
		const manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
		scripts = Object.keys(manifest.scripts ?? {}).filter(name => /^[\w:.-]{1,64}$/.test(name)).slice(0, 100);
	} catch { /* An unreadable manifest declares no scripts. */ }
	return { packageManager: manager ?? 'npm', scripts };
}

/** Subprojects up to depth 4, skipping dependency, build and cache folders and symbolic links. */
export async function detectEcosystems(root: string): Promise<Subproject[]> {
	const found: Subproject[] = [];
	let visited = 0;
	const walk = async (folder: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH || visited > MAX_ENTRIES) { return; }
		const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
		visited += entries.length;
		const names = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
		const relative = path.relative(root, folder).split(path.sep).join('/') || '.';
		const ecosystems = new Set<Ecosystem>();
		for (const name of names) { for (const [pattern, ecosystem] of MARKERS) { if (pattern.test(name)) { ecosystems.add(ecosystem); } } }
		for (const ecosystem of ecosystems) {
			const subproject: Subproject = { path: relative, ecosystem };
			if (ecosystem === 'node') { Object.assign(subproject, await nodeDetails(folder, names, root)); }
			if (ecosystem === 'java') { const wrapper = ['gradlew', 'mvnw'].find(name => names.has(name)); if (wrapper) { subproject.wrapper = wrapper; } }
			found.push(subproject);
		}
		for (const entry of entries) {
			if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP.has(entry.name) && !entry.name.startsWith('.')) { await walk(path.join(folder, entry.name), depth + 1); }
		}
	};
	await walk(root, 0);
	return found;
}

/** One line per subproject for the agent contract: where it is and how to build and test it. */
export function describeEcosystems(subprojects: readonly Subproject[]): string[] {
	const commands: Record<Ecosystem, (project: Subproject) => string> = {
		go: () => 'go build ./..., go test ./..., go vet ./...',
		node: project => [project.packageManager + ' run <script>', project.scripts?.length ? 'scripts: ' + project.scripts.slice(0, 12).join(', ') : ''].filter(Boolean).join('; '),
		python: () => 'python -m pytest, python -m mypy, python -m ruff',
		rust: () => 'cargo build, cargo test, cargo clippy',
		dotnet: () => 'dotnet build, dotnet test',
		java: project => project.wrapper === 'gradlew' ? './gradlew test' : project.wrapper === 'mvnw' ? './mvnw -q test' : 'gradle test or mvn -q test',
		php: () => 'vendor/bin/phpunit, vendor/bin/phpstan',
		ruby: () => 'bundle exec rspec, bundle exec rake test'
	};
	return subprojects.map(project => '- ' + project.path + ' (' + project.ecosystem + '): ' + commands[project.ecosystem](project));
}
