/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Read-only metadata for external verification gates. No commands or executable paths accepted. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface ProjectGate {
	id: string;
	dependsOn: string[];
	resources: string[];
}
export interface ProjectGateCatalog {
	schemaVersion: 1;
	gates: ProjectGate[];
	digest: string;
	executionEnabled: false;
}
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_BYTES = 16 * 1024;

export async function readProjectGateCatalog(root: string): Promise<ProjectGateCatalog | undefined> {
	const canonical = await fs.realpath(root);
	if (canonical !== root) { throw Error('HARNESS_GATE_CATALOG_ROOT_CHANGED'); }
	const projectDir = path.join(canonical, '.harness');
	const manifestDir = path.join(projectDir, 'manifests');
	const target = path.join(manifestDir, 'ide-gates.json');
	let fileInfo;
	try { fileInfo = await fs.lstat(target); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
		throw error;
	}
	for (const directory of [projectDir, manifestDir]) {
		const info = await fs.lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory) {
			throw Error('HARNESS_GATE_CATALOG_UNSAFE');
		}
	}
	if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_BYTES ||
		await fs.realpath(target) !== target) { throw Error('HARNESS_GATE_CATALOG_UNSAFE'); }
	const bytes = await fs.readFile(target);
	if (bytes.length > MAX_BYTES) { throw Error('HARNESS_GATE_CATALOG_UNSAFE'); }
	let parsed: unknown;
	try { parsed = JSON.parse(bytes.toString('utf8')); }
	catch { throw Error('HARNESS_GATE_CATALOG_INVALID'); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
		Object.keys(parsed).sort().join(',') !== 'gates,schemaVersion') {
		throw Error('HARNESS_GATE_CATALOG_INVALID');
	}
	const value = parsed as { schemaVersion?: unknown; gates?: unknown };
	if (value.schemaVersion !== 1 || !Array.isArray(value.gates) || value.gates.length > 32) {
		throw Error('HARNESS_GATE_CATALOG_INVALID');
	}
	const gates: ProjectGate[] = [];
	const seen = new Set<string>();
	for (const gate of value.gates) {
		if (!gate || typeof gate !== 'object' || Array.isArray(gate) ||
			Object.keys(gate).sort().join(',') !== 'dependsOn,id,resources') {
			throw Error('HARNESS_GATE_CATALOG_INVALID');
		}
		const item = gate as Partial<ProjectGate>;
		if (typeof item.id !== 'string' || !IDENTIFIER.test(item.id) || seen.has(item.id) ||
			!Array.isArray(item.dependsOn) || item.dependsOn.length > 32 ||
			!item.dependsOn.every(dep => typeof dep === 'string' && IDENTIFIER.test(dep)) ||
			new Set(item.dependsOn).size !== item.dependsOn.length ||
			!Array.isArray(item.resources) || item.resources.length > 8 ||
			!item.resources.every(resource => typeof resource === 'string' && IDENTIFIER.test(resource)) ||
			new Set(item.resources).size !== item.resources.length) {
			throw Error('HARNESS_GATE_CATALOG_INVALID');
		}
		seen.add(item.id);
		gates.push({ id: item.id, dependsOn: [...item.dependsOn], resources: [...item.resources] });
	}
	const index = new Map(gates.map(gate => [gate.id, gate]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) { throw Error('HARNESS_GATE_CATALOG_CYCLE'); }
		if (visited.has(id)) { return; }
		const gate = index.get(id);
		if (!gate) { throw Error('HARNESS_GATE_CATALOG_DEPENDENCY'); }
		visiting.add(id);
		for (const dependency of gate.dependsOn) { visit(dependency); }
		visiting.delete(id);
		visited.add(id);
	};
	for (const gate of gates) { visit(gate.id); }
	return {
		schemaVersion: 1, gates,
		digest: createHash('sha256').update(bytes).digest('hex'),
		executionEnabled: false
	};
}

/** Deterministic read-only schedule; no gate is ever executed by this planner. */
export function planProjectGateWaves(catalog: ProjectGateCatalog, maxConcurrent = 4): string[][] {
	if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) {
		throw Error('HARNESS_GATE_CAPACITY_INVALID');
	}
	if (catalog.executionEnabled !== false || catalog.schemaVersion !== 1 ||
		!Array.isArray(catalog.gates) || catalog.gates.length > 32) {
		throw Error('HARNESS_GATE_CATALOG_INVALID');
	}
	const validated = new Map<string, ProjectGate>();
	for (const gate of catalog.gates) {
		if (!gate || typeof gate !== 'object' ||
			Object.keys(gate).sort().join(',') !== 'dependsOn,id,resources' ||
			typeof gate.id !== 'string' || !IDENTIFIER.test(gate.id) ||
			validated.has(gate.id) || !Array.isArray(gate.dependsOn) ||
			gate.dependsOn.length > 32 || new Set(gate.dependsOn).size !== gate.dependsOn.length ||
			!gate.dependsOn.every(dep => typeof dep === 'string' && IDENTIFIER.test(dep)) ||
			!Array.isArray(gate.resources) || gate.resources.length > 8 ||
			new Set(gate.resources).size !== gate.resources.length ||
			!gate.resources.every(resource => typeof resource === 'string' && IDENTIFIER.test(resource))) {
			throw Error('HARNESS_GATE_CATALOG_INVALID');
		}
		validated.set(gate.id, gate);
	}
	for (const gate of validated.values()) {
		if (gate.dependsOn.some(dep => !validated.has(dep))) {
			throw Error('HARNESS_GATE_CATALOG_DEPENDENCY');
		}
	}
	const completed = new Set<string>();
	const waves: string[][] = [];
	while (completed.size < validated.size) {
		const claimed = new Set<string>();
		const selected: ProjectGate[] = [];
		for (const gate of validated.values()) {
			if (completed.has(gate.id) || selected.length >= maxConcurrent) { continue; }
			if (!gate.dependsOn.every(dep => completed.has(dep))) { continue; }
			if (gate.resources.some(resource => claimed.has(resource))) { continue; }
			selected.push(gate);
			for (const resource of gate.resources) { claimed.add(resource); }
		}
		if (!selected.length) { throw Error('HARNESS_GATE_CATALOG_DEPENDENCY'); }
		waves.push(selected.map(gate => gate.id));
		for (const gate of selected) { completed.add(gate.id); }
	}
	return waves;
}

/** For an eventual explicit delegation, require fresh approval of the exact manifest. */
export async function validateProjectGateCatalog(root: string, expectedDigest: string): Promise<void> {
	if (!/^[a-f0-9]{64}$/.test(expectedDigest)) { throw Error('HARNESS_GATE_CATALOG_INVALID'); }
	const current = await readProjectGateCatalog(root);
	if (!current || current.digest !== expectedDigest) { throw Error('HARNESS_GATE_CATALOG_CHANGED'); }
}
