/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Machine doctor (block X): read-only checks of what usually blocks work before it starts, each problem with its action.
 * It never restarts system services. Commands are injected, so the same checks run in tests without touching the machine.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type Exec = (command: string, args: string[]) => Promise<{ code: number | null; output: string }>;
export interface DoctorCheck { id: string; title: string; status: 'ok' | 'warning' | 'problem' | 'skipped'; detail: string; action?: string }
export interface PortRange { start: number; end: number }

const MIN_FREE_BYTES = 5 * 1024 ** 3;

/** `netsh int ipv4 show excludedportrange protocol=tcp` rows, the ranges Windows reserves (Hyper-V, WSL). */
export function parseExcludedPorts(output: string): PortRange[] {
	return [...output.matchAll(/^\s*(\d{2,5})\s+(\d{2,5})\b/gm)].map(match => ({ start: Number(match[1]), end: Number(match[2]) })).filter(range => range.start <= range.end);
}
export const portExcluded = (port: number, ranges: readonly PortRange[]): boolean => ranges.some(range => port >= range.start && port <= range.end);

/** A free-looking port outside every excluded range, scanning upward from `from`. */
export function pickPort(from: number, ranges: readonly PortRange[], taken: ReadonlySet<number> = new Set()): number {
	for (let port = from; port < 65535; port++) { if (!portExcluded(port, ranges) && !taken.has(port)) { return port; } }
	throw Error('HARNESS_UNSUPPORTED');
}

export interface DoctorInput {
	exec: Exec; platform: NodeJS.Platform; projectRoot: string; ports?: number[]; toolchains?: Array<{ command: string; args: string[]; label: string }>;
	serverDate?: () => Promise<number | undefined>; now?: () => number;
	/** How the IDE resolves Node for project commands; `embeddedNode` means only the editor's own runtime was found. */
	node?: () => Promise<{ executable: string; embeddedNode: boolean }>;
	/** The user's default integrated terminal profile (name or path), to warn about shells that hide Node from scripts. */
	terminalProfile?: string;
}

export async function runDoctor(input: DoctorInput): Promise<DoctorCheck[]> {
	const { exec } = input;
	const checks: DoctorCheck[] = [];
	if (input.node) { checks.push(await nodeCheck(input.node)); }
	const shell = shellCheck(input.platform, input.terminalProfile);
	if (shell) { checks.push(shell); }
	const docker = await exec('docker', ['info', '--format', '{{.OSType}}']).catch(() => ({ code: null, output: '' }));
	checks.push(docker.code === 0
		? { id: 'docker', title: 'Docker', status: 'ok', detail: 'Motor ' + docker.output.trim() }
		: { id: 'docker', title: 'Docker', status: 'warning', detail: 'Docker no responde.', action: 'Inici\u00e1 Docker Desktop si un objetivo necesita un entorno ef\u00edmero o servicios del compose.' });
	if (input.platform === 'win32') {
		const wsl = await exec('wsl', ['--status']).catch(() => ({ code: null, output: '' }));
		checks.push(wsl.code === 0 ? { id: 'wsl', title: 'WSL', status: 'ok', detail: 'WSL disponible' } : { id: 'wsl', title: 'WSL', status: 'warning', detail: 'WSL no responde.', action: 'Ejecut\u00e1 \u00abwsl --update\u00bb si Docker usa el motor de WSL.' });
		const excluded = parseExcludedPorts((await exec('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp']).catch(() => ({ code: null, output: '' }))).output);
		const blocked = (input.ports ?? []).filter(port => portExcluded(port, excluded));
		checks.push(blocked.length
			? { id: 'ports', title: 'Puertos', status: 'problem', detail: 'Windows reserva ' + blocked.join(', ') + '.', action: 'Us\u00e1 otro puerto en el compose (por ejemplo ' + pickPort(blocked[0] + 1, excluded) + ') o liber\u00e1 el rango con \u00abnet stop winnat\u00bb como administrador.' }
			: { id: 'ports', title: 'Puertos', status: 'ok', detail: excluded.length + ' rangos reservados; ninguno choca con los servicios del proyecto.' });
	}
	const stats = await fs.statfs(input.projectRoot).catch(() => undefined);
	const free = stats ? stats.bavail * stats.bsize : undefined;
	checks.push(free === undefined ? { id: 'disk', title: 'Disco', status: 'skipped', detail: 'No se pudo leer el espacio libre.' }
		: free < MIN_FREE_BYTES ? { id: 'disk', title: 'Disco', status: 'problem', detail: (free / 1024 ** 3).toFixed(1) + ' GB libres en la unidad del proyecto.', action: 'Liber\u00e1 espacio: cach\u00e9s de toolchains, im\u00e1genes de Docker sin uso (docker image prune).' }
			: { id: 'disk', title: 'Disco', status: 'ok', detail: (free / 1024 ** 3).toFixed(1) + ' GB libres' });
	for (const toolchain of input.toolchains ?? []) {
		const result = await exec(toolchain.command, toolchain.args).catch(() => ({ code: null, output: '' }));
		checks.push(result.code === 0 ? { id: 'tool-' + toolchain.command, title: toolchain.label, status: 'ok', detail: result.output.trim().split('\n')[0].slice(0, 120) }
			: { id: 'tool-' + toolchain.command, title: toolchain.label, status: 'problem', detail: toolchain.command + ' no est\u00e1 instalado o no est\u00e1 en el PATH.', action: 'Instal\u00e1 ' + toolchain.label + ' y reabr\u00ed el IDE.' });
	}
	const packageManager = await packageManagerCheck(exec, input.projectRoot);
	if (packageManager) { checks.push(packageManager); }
	const name = (await exec('git', ['config', 'user.name']).catch(() => ({ code: null, output: '' }))).output.trim();
	const email = (await exec('git', ['config', 'user.email']).catch(() => ({ code: null, output: '' }))).output.trim();
	checks.push(name && email ? { id: 'git', title: 'Git', status: 'ok', detail: name + ' <' + email + '>' } : { id: 'git', title: 'Git', status: 'problem', detail: 'Falta la identidad de git.', action: 'git config --global user.name "…" y user.email "…" (los commits de entrega la usan).' });
	const github = await githubCheck(exec);
	if (github) { checks.push(github); }
	if (input.platform === 'win32') {
		const longPaths = (await exec('git', ['config', 'core.longpaths']).catch(() => ({ code: null, output: '' }))).output.trim();
		if (longPaths !== 'true') { checks.push({ id: 'git-longpaths', title: 'Rutas largas', status: 'warning', detail: 'core.longpaths no est\u00e1 activo.', action: 'git config --global core.longpaths true' }); }
	}
	const server = await input.serverDate?.().catch(() => undefined);
	if (server !== undefined) {
		const skew = Math.abs((input.now ?? Date.now)() - server) / 1000;
		checks.push(skew > 120 ? { id: 'clock', title: 'Reloj', status: 'problem', detail: 'El reloj difiere ' + Math.round(skew) + ' s de la hora de red.', action: 'Sincroniz\u00e1 la hora del sistema; los tokens y vencimientos dependen de ella.' } : { id: 'clock', title: 'Reloj', status: 'ok', detail: 'Desfase ' + Math.round(skew) + ' s' });
	}
	return checks;
}

const SELECT_NODE = 'Instal\u00e1 Node.js (nodejs.org) o eleg\u00ed uno con \u00abArmotuSitio: Seleccionar Node.js\u00bb (ajuste atsHarness.nodeExecutable) y reabr\u00ed el IDE.';

/** Project scripts spawn `node` themselves, so the editor's embedded runtime is not enough for them. */
async function nodeCheck(resolve: NonNullable<DoctorInput['node']>): Promise<DoctorCheck> {
	const id = 'node', title = 'Node.js';
	try {
		const node = await resolve();
		return node.embeddedNode
			? { id, title, status: 'problem', detail: 'No se encontr\u00f3 Node.js en el PATH; solo est\u00e1 el del editor, y los scripts del proyecto que llaman a node van a fallar.', action: SELECT_NODE }
			: { id, title, status: 'ok', detail: node.executable };
	} catch {
		return { id, title, status: 'problem', detail: 'El Node.js elegido en atsHarness.nodeExecutable ya no existe o no es un ejecutable de Node.', action: SELECT_NODE };
	}
}

/** MSYS2 shells (UCRT64, MINGW64, MSYS) do not pass Windows' Node to package-manager shims: `node` is "not recognized" there. */
function shellCheck(platform: NodeJS.Platform, profile: string | undefined): DoctorCheck | undefined {
	if (platform !== 'win32' || !profile) { return undefined; }
	return /msys|ucrt64|mingw(32|64)|clang64/i.test(profile)
		? { id: 'shell', title: 'Terminal', status: 'warning', detail: 'Tu terminal predeterminada es MSYS2 (' + profile.slice(0, 80) + '): ah\u00ed pnpm y npm no encuentran node.', action: 'Us\u00e1 PowerShell o Git Bash para los comandos del proyecto (terminal.integrated.defaultProfile.windows). El chat no usa esa terminal.' }
		: undefined;
}

/** `gh auth status` without `--show-token`: only whether a session exists, never the token. Skipped when gh is not installed. */
async function githubCheck(exec: Exec): Promise<DoctorCheck | undefined> {
	const installed = await exec('gh', ['--version']).catch(() => ({ code: null, output: '' }));
	if (installed.code !== 0) { return undefined; }
	const status = await exec('gh', ['auth', 'status', '--hostname', 'github.com']).catch(() => ({ code: null, output: '' }));
	return status.code === 0
		? { id: 'gh', title: 'GitHub CLI', status: 'ok', detail: 'Sesi\u00f3n iniciada en github.com' }
		: { id: 'gh', title: 'GitHub CLI', status: 'warning', detail: 'gh no tiene sesi\u00f3n en github.com: push y PR van a fallar.', action: 'gh auth login' };
}

/**
 * The package manager the project pins (`packageManager` in package.json). Another major version fails in confusing ways
 * mid-turn: pnpm tries to switch itself through a junction that Windows refuses (error 448).
 */
async function packageManagerCheck(exec: Exec, root: string): Promise<DoctorCheck | undefined> {
	const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => undefined);
	if (raw === undefined) { return undefined; }
	const id = 'package-manager', title = 'Gestor de paquetes';
	let pinned: unknown;
	try { pinned = (JSON.parse(raw) as { packageManager?: unknown }).packageManager; } catch { return { id, title, status: 'warning', detail: 'package.json no es JSON v\u00e1lido.' }; }
	const match = typeof pinned === 'string' ? /^(?<name>pnpm|npm|yarn)@(?<version>\d+\.\d+\.\d+)/.exec(pinned) : null;
	if (!match?.groups) { return undefined; }
	const { name, version } = match.groups;
	const install = 'Instal\u00e1 ' + name + '@' + version + ' (npm i -g ' + name + '@' + version + ', o corepack enable) y reabr\u00ed el IDE.';
	const result = await exec(name, ['--version']).catch(() => ({ code: null, output: '' }));
	const installed = result.code === 0 ? /\d+\.\d+\.\d+/.exec(result.output)?.[0] : undefined;
	if (!installed) {
		const reason = result.output.trim().split('\n')[0].slice(0, 160);
		return { id, title, status: 'problem', detail: reason ? '\u00ab' + name + ' --version\u00bb fall\u00f3: ' + reason : name + ' no est\u00e1 instalado o no est\u00e1 en el PATH (el proyecto fija ' + version + ').', action: install };
	}
	if (installed.split('.')[0] !== version.split('.')[0]) {
		return { id, title, status: 'problem', detail: 'Ten\u00e9s ' + name + ' ' + installed + ' y el proyecto fija ' + version + '.', action: install + ' Con otra versi\u00f3n mayor ' + name + ' puede intentar cambiarse solo y fallar.' };
	}
	return { id, title, status: 'ok', detail: name + ' ' + installed + (installed === version ? '' : ' (el proyecto fija ' + version + ')') };
}

/** One Markdown report: problems first, each with its action. */
export function doctorReport(checks: readonly DoctorCheck[]): string {
	const icon = { ok: '\u2705', warning: '⚠️', problem: '\u274c', skipped: '\u2796' };
	const order = { problem: 0, warning: 1, skipped: 2, ok: 3 };
	return '# M\u00e9dico de la m\u00e1quina\n\n' + [...checks].sort((left, right) => order[left.status] - order[right.status])
		.map(check => '- ' + icon[check.status] + ' **' + check.title + '**: ' + check.detail + (check.action ? '\n  - Qu\u00e9 hacer: ' + check.action : '')).join('\n') + '\n';
}
