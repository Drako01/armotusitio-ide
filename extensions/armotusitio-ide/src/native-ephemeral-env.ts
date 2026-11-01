/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Ephemeral environments (block W): disposable services a goal needs, created and destroyed by the orchestrator, never by
 * an agent (D3), with the charter's explicit authorization. Everything carries `ats.managed` and `ats.goal` labels; the
 * collector only ever removes labeled resources.
 */
import { pickPort, type Exec, type PortRange } from './native-machine-doctor.ts';
import { probeService, type ServiceKind } from './native-services.ts';

export interface EnvironmentService {
	name: string;
	/** Image pinned by version (`postgres:16.4`), never `latest`. */
	image: string;
	containerPort: number;
	kind: ServiceKind;
	env?: Record<string, string>;
}
export interface EnvironmentTemplate {
	name: string;
	services: EnvironmentService[];
	/** Commands run against the environment once it answers (policy-checked by the caller). */
	migrate?: { command: string; args: string[]; cwd: string };
	seed?: { command: string; args: string[]; cwd: string };
	/** Variables the environment exports to the goal's commands; `{port:<service>}` is replaced by the chosen port. */
	exports: Record<string, string>;
}
export interface EphemeralEnvironment { goalId: string; exports: Record<string, string>; ports: Record<string, number>; destroy(): Promise<void> }

const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const PINNED = /^[\w./-]+:(?!latest$)[\w.-]+$/;
const READY_TIMEOUT_MS = 90_000;

export function validateTemplate(template: EnvironmentTemplate): EnvironmentTemplate {
	if (!template || !NAME.test(template.name) || !Array.isArray(template.services) || !template.services.length || template.services.length > 8 ||
		template.services.some(service => !NAME.test(service.name) || !PINNED.test(service.image) || !Number.isSafeInteger(service.containerPort)) ||
		!template.exports || Object.keys(template.exports).some(name => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name))) {
		throw Error('HARNESS_CONFIG_SCHEMA');
	}
	return template;
}

/** Create, wait until each service answers its protocol, and return the variables for the goal. */
export async function createEnvironment(input: { template: EnvironmentTemplate; goalId: string; exec: Exec; excludedPorts: readonly PortRange[]; sleep?: (ms: number) => Promise<void> }): Promise<EphemeralEnvironment> {
	const template = validateTemplate(input.template);
	const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
	const ports: Record<string, number> = {};
	const containers: string[] = [];
	const destroy = async () => { for (const id of containers) { await input.exec('docker', ['rm', '-f', '-v', id]).catch(() => undefined); } };
	try {
		let next = 20000 + Math.floor(Math.random() * 20000);
		for (const service of template.services) {
			const port = pickPort(next, input.excludedPorts, new Set(Object.values(ports)));
			next = port + 1;
			const name = 'ats-' + input.goalId + '-' + service.name;
			const env = Object.entries(service.env ?? {}).flatMap(([key, value]) => ['-e', key + '=' + value]);
			const result = await input.exec('docker', ['run', '-d', '--name', name, '--label', 'ats.managed=1', '--label', 'ats.goal=' + input.goalId, '--cpus', '2', '--memory', '2g', '-p', '127.0.0.1:' + port + ':' + service.containerPort, ...env, service.image]);
			if (result.code !== 0) { throw Error('HARNESS_UNSUPPORTED'); }
			containers.push(result.output.trim().split('\n').at(-1) ?? name);
			ports[service.name] = port;
		}
		for (const service of template.services) {
			const deadline = Date.now() + READY_TIMEOUT_MS;
			while ((await probeService({ kind: service.kind, host: '127.0.0.1', port: ports[service.name], source: 'environment' })).status !== 'up') {
				if (Date.now() > deadline) { throw Error('HARNESS_TIMEOUT'); }
				await sleep(1000);
			}
		}
		const exports = Object.fromEntries(Object.entries(template.exports).map(([key, value]) => [key, value.replace(/\{port:([\w-]+)\}/g, (_, service: string) => String(ports[service] ?? ''))]));
		return { goalId: input.goalId, exports, ports, destroy };
	} catch (error) { await destroy(); throw error; }
}

/** Remove labeled containers and volumes of goals that are no longer active; unlabeled resources are never touched. */
export async function collectOrphans(exec: Exec, activeGoals: ReadonlySet<string>): Promise<string[]> {
	const listed = await exec('docker', ['ps', '-a', '--filter', 'label=ats.managed=1', '--format', '{{.ID}} {{.Label "ats.goal"}}']).catch(() => ({ code: null, output: '' }));
	if (listed.code !== 0) { return []; }
	const removed: string[] = [];
	for (const line of listed.output.split('\n').map(item => item.trim()).filter(Boolean)) {
		const [id, goal] = line.split(' ');
		if (!id || (goal && activeGoals.has(goal))) { continue; }
		if ((await exec('docker', ['rm', '-f', '-v', id]).catch(() => ({ code: 1, output: '' }))).code === 0) { removed.push(id); }
	}
	return removed;
}
