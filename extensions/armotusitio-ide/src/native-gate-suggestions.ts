/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Suggested verification gates (block H): one per detected subproject, confirmed once by the user. Never executed here. */
import type { Subproject } from './native-ecosystems.ts';

export interface SuggestedGate { id: string; executable: string; args: string[]; cwd: string }

/** The script a Node project verifies with, in order of preference. */
const NODE_SCRIPTS = ['test', 'check', 'typecheck', 'lint', 'build'];

function gateFor(project: Subproject): Omit<SuggestedGate, 'id'> | undefined {
	const cwd = project.path;
	switch (project.ecosystem) {
		case 'go': return { executable: 'go', args: ['test', './...'], cwd };
		case 'node': {
			const script = NODE_SCRIPTS.find(name => project.scripts?.includes(name));
			return script ? { executable: project.packageManager ?? 'npm', args: script === 'test' ? ['test'] : ['run', script], cwd } : undefined;
		}
		case 'python': return { executable: 'python', args: ['-m', 'pytest', '-q'], cwd };
		case 'rust': return { executable: 'cargo', args: ['test'], cwd };
		case 'dotnet': return { executable: 'dotnet', args: ['test'], cwd };
		// Gate executables are names, not paths, so wrappers are left to the user.
		case 'java': return { executable: project.wrapper === 'mvnw' ? 'mvn' : 'gradle', args: project.wrapper === 'mvnw' ? ['-q', 'test'] : ['test'], cwd };
		case 'php': return { executable: 'php', args: ['vendor/bin/phpunit'], cwd };
		case 'ruby': return { executable: 'bundle', args: ['exec', 'rspec'], cwd };
	}
}

/** Gates for every subproject with a known verification; ids are unique and stable per folder. */
export function suggestGates(subprojects: readonly Subproject[]): SuggestedGate[] {
	const gates: SuggestedGate[] = [];
	const used = new Set<string>();
	for (const project of subprojects) {
		const gate = gateFor(project);
		if (!gate) { continue; }
		const base = (project.ecosystem + '-' + (project.path === '.' ? 'root' : project.path)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
		let id = base;
		for (let suffix = 2; used.has(id); suffix++) { id = base + '-' + suffix; }
		used.add(id);
		gates.push({ id, ...gate });
	}
	return gates;
}
