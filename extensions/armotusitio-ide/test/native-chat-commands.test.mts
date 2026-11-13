/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditLines, runSessionCommand, type SessionCommandDeps } from '../src/native-chat-commands.ts';
import { addUserRule, projectKey } from '../src/native-permissions.ts';
import type { HarnessChatSession } from '../src/native-chat-session.ts';
import type { ToolCheckpoint } from '../src/native-chat-tool-checkpoints.ts';

const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);
/** A chat session with only the members a command reads; `Object.create(null)` keeps it free of inherited surprises. */
const fakeSession = (members: object): HarnessChatSession => Object.assign(Object.create(null), members);

test('/permisos lists the saved rules and /permisos quitar revokes one so the action asks again', async () => {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chat-commands-')));
	try {
		const home = path.join(base, 'home'), root = path.join(base, 'project');
		await fs.mkdir(root);
		await addUserRule('run:make test', 'allow', home);
		await addUserRule('git_push:' + projectKey(root), 'allow', home);
		const deps: SessionCommandDeps = {
			t, home, chatMode: () => 'act', setChatMode: async () => undefined, permissionsPreset: () => undefined,
			openFile: async () => undefined, confirmDiscard: async () => false
		};
		// /permisos never touches the conversation; any other use of it would throw here.
		const session: HarnessChatSession = Object.create(null);
		const listing = await runSessionCommand(deps, 'permisos', [], root, session);
		const revoked = await runSessionCommand(deps, 'permisos', ['quitar', 'run:make', 'test'], root, session);
		const again = await runSessionCommand(deps, 'permisos', ['quitar', 'run:make', 'test'], root, session);
		const usage = await runSessionCommand(deps, 'permisos', ['quitar'], root, session);
		const file = JSON.parse(await fs.readFile(path.join(home, '.armotusitio', 'permissions.json'), 'utf8'));
		assert.deepEqual({
			listed: /allow {2}run:make test/.test(listing ?? '') && /allow {2}git_push:/.test(listing ?? ''),
			revoked: revoked?.startsWith('Revoqu'), again: again?.includes('run:make test'), usage, allow: file.allow
		}, {
			listed: true, revoked: true, again: true,
			usage: 'Uso: /permisos quitar REGLA (copiala de la lista de /permisos).',
			allow: ['git_push:' + projectKey(root)]
		});
	} finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('/auditoria lists the latest tool actions across runs, newest first, redacted, skipping torn lines', async () => {
	const runs = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-audit-'));
	try {
		const write = async (run: string, lines: string[]) => { await fs.mkdir(path.join(runs, run, 'logs'), { recursive: true }); await fs.writeFile(path.join(runs, run, 'logs', 'commands.jsonl'), lines.join('\n')); };
		await write('1-a', [JSON.stringify({ at: '2026-11-07T10:00:00.000Z', command: 'pnpm', args: ['lint'], cwd: '.', exitCode: 0 }), '{"at":']);
		await write('2-b', [JSON.stringify({ at: '2026-11-07T11:00:00.000Z', command: 'curl', args: ['-H', 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789'], cwd: '.', denied: 'network' }),
		JSON.stringify({ at: '2026-11-07T11:05:00.000Z', tool: 'git_commit', isError: false, outcome: 'COMMITTED' })]);
		const lines = await auditLines(runs);
		assert.deepEqual({ count: lines.length, first: lines[0], last: lines[2], leaked: lines.some(line => line.includes('ghp_abcdef')) },
			{ count: 3, first: '  2026-11-07 11:05:00  git_commit  -> COMMITTED', last: '  2026-11-07 10:00:00  pnpm lint  -> exit 0', leaked: false });
		assert.deepEqual(await auditLines(path.join(runs, 'missing')), []);
	} finally { await fs.rm(runs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('/lease shows the engine lease state and /lease liberar removes it only after a confirmation', async () => {
	const base = { t, chatMode: () => 'act' as const, setChatMode: async () => undefined, permissionsPreset: () => undefined, openFile: async () => undefined, confirmDiscard: async () => false };
	const session: HarnessChatSession = Object.create(null);
	let state: 'none' | 'valid' = 'valid', allow = false;
	const cleared: string[] = [];
	const deps: SessionCommandDeps = {
		...base,
		lease: {
			status: async () => ({ state, ...(state === 'valid' ? { expiresAt: '2099-01-01T00:00:00' } : {}) }),
			clear: async () => { cleared.push(state); const previous = state; state = 'none'; return previous; },
			confirmClear: async () => allow
		}
	};
	const shown = await runSessionCommand(deps, 'lease', [], '/p', session);
	const refused = await runSessionCommand(deps, 'lease', ['liberar'], '/p', session);
	allow = true;
	const released = await runSessionCommand(deps, 'lease', ['liberar'], '/p', session);
	const nothing = await runSessionCommand(deps, 'lease', ['liberar'], '/p', session);
	const usage = await runSessionCommand(deps, 'lease', ['borrar'], '/p', session);
	const noEngine = await runSessionCommand({ ...base, lease: { ...deps.lease!, status: async () => { throw Error('HARNESS_HYBRID_WRITER_ENTRY_UNAVAILABLE'); } } }, 'lease', [], '/p', session);
	assert.deepEqual({ shown: shown?.includes('2099-01-01T00:00:00'), refused, released: released?.includes('estaba: valid'), cleared, nothing: nothing?.includes('nada que liberar'), usage, noEngine: noEngine?.includes('no tiene un Harness propio'), absent: (await runSessionCommand(base, 'lease', [], '/p', session))?.includes('no tiene un Harness propio') },
		{ shown: true, refused: 'No liber\u00e9 el lease.', released: true, cleared: ['valid'], nothing: true, usage: 'Uso: /lease [liberar]', noEngine: true, absent: true });
});

test('/motor runs a project command in the IDE terminal only when the chat is idle, and explains its usage', async () => {
	const base = { t, chatMode: () => 'act' as const, setChatMode: async () => undefined, permissionsPreset: () => undefined, openFile: async () => undefined, confirmDiscard: async () => false };
	const ran: string[][] = [];
	const deps: SessionCommandDeps = { ...base, motor: async (command, args) => { ran.push([command, ...args]); return 'exit 0 \u00b7 1.2 s\nok'; } };
	const idle = fakeSession({ snapshot: () => ({}) });
	const busy = fakeSession({ snapshot: () => ({ activity: { kind: 'implementing' } }) });
	const result = await runSessionCommand(deps, 'motor', ['pnpm', 'harness:preflight', '--', 'api'], '/p', idle);
	const usage = await runSessionCommand(deps, 'motor', [], '/p', idle);
	const refused = await runSessionCommand(deps, 'motor', ['pnpm', 'test'], '/p', busy);
	const unavailable = await runSessionCommand(base, 'motor', ['pnpm'], '/p', idle);
	assert.deepEqual({ result, ran, usage: usage?.startsWith('Uso: /motor'), refused: refused?.includes('en curso'), unavailable: unavailable?.includes('no puede abrir la terminal') },
		{ result: 'exit 0 \u00b7 1.2 s\nok', ran: [['pnpm', 'harness:preflight', '--', 'api']], usage: true, refused: true, unavailable: true });
});

test('/checkpoints lists granular checkpoints and restores one only after the shared confirmation, never during a run', async () => {
	const base = { t, chatMode: () => 'act' as const, setChatMode: async () => undefined, permissionsPreset: () => undefined, openFile: async () => undefined, confirmDiscard: async () => false };
	let activity: unknown;
	const refreshed: number[] = [];
	const session = fakeSession({ snapshot: () => ({ activity }), refreshContext: async () => { refreshed.push(1); } });
	const checkpoint = (id: string, at: string, files: string[], turn?: { turnId: string; sequence: number }): ToolCheckpoint => ({
		schemaVersion: 1, id, rootDigest: 'r', at, stepId: 's-' + id.slice(0, 4), kind: 'edit', state: 'ready', files: files.map(path => ({ path, before: null, after: 'missing' })), ...turn
	});
	const items = [
		checkpoint('aaaa1111-0000-4000-8000-000000000001', '2026-11-13T10:00:00.000Z', ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], { turnId: 'turn-1234-xyz', sequence: 2 }),
		checkpoint('aaaa2222-0000-4000-8000-000000000002', '2026-11-13T09:00:00.000Z', ['README.md'])
	];
	let confirm = false;
	const restored: string[] = [];
	const deps: SessionCommandDeps = {
		...base,
		checkpoints: { list: async () => items, restore: async (_root, id) => { if (!confirm) { return undefined; } restored.push(id); return { restored: ['src/a.ts'], skipped: ['src/b.ts'] }; } }
	};
	const listing = await runSessionCommand(deps, 'checkpoints', [], '/p', session);
	const declined = await runSessionCommand(deps, 'checkpoints', ['restaurar', 'aaaa1111'], '/p', session);
	confirm = true;
	const ambiguous = await runSessionCommand(deps, 'checkpoints', ['restaurar', 'aaaa'], '/p', session);
	const unknown = await runSessionCommand(deps, 'checkpoints', ['restaurar', 'zzzz'], '/p', session);
	activity = { kind: 'run' };
	const busy = await runSessionCommand(deps, 'checkpoints', ['restaurar', 'aaaa1111'], '/p', session);
	activity = undefined;
	const done = await runSessionCommand(deps, 'checkpoints', ['restaurar', 'AAAA1111'], '/p', session);
	assert.deepEqual({
		listsBoth: listing?.includes('aaaa1111') && listing?.includes('aaaa2222') && listing?.includes('turno turn-123 #2') && listing?.includes('src/a.ts, src/b.ts, src/c.ts +1'),
		declined: declined?.includes('cancelada'), ambiguous: ambiguous?.includes('varios'), unknown: unknown?.includes('No encontr'), busy: busy?.includes('tarea en curso'),
		done: done?.includes('1 archivos restaurados; 1 preservados'), restored, refreshed: refreshed.length,
		usage: await runSessionCommand(deps, 'checkpoints', ['borrar'], '/p', session),
		absent: (await runSessionCommand(base, 'checkpoints', [], '/p', session))?.includes('no est'),
		empty: (await runSessionCommand({ ...base, checkpoints: { ...deps.checkpoints!, list: async () => [] } }, 'checkpoints', [], '/p', session))?.includes('No hay checkpoints')
	}, { listsBoth: true, declined: true, ambiguous: true, unknown: true, busy: true, done: true, restored: ['aaaa1111-0000-4000-8000-000000000001'], refreshed: 1, usage: 'Uso: /checkpoints [restaurar ID]', absent: true, empty: true });
});

test('/objetivos lists the live goals of the window and asks one to pause or stop at its next safe point', async () => {
	const base = { t, chatMode: () => 'act' as const, setChatMode: async () => undefined, permissionsPreset: () => undefined, openFile: async () => undefined, confirmDiscard: async () => false };
	const session: HarnessChatSession = Object.create(null);
	const controls: string[] = [];
	const deps: SessionCommandDeps = {
		...base,
		goals: {
			list: () => [
				{ id: 'g1', project: 'redevent', objective: 'Subir cobertura', status: 'running', startedAt: '2026-11-13T10:00:00.000Z', questions: [] },
				{ id: 'g2', project: 'redevent', objective: 'Migrar auth', status: 'waiting-answers', startedAt: '2026-11-13T10:05:00.000Z', questions: ['¿Qué proveedor?'] }
			],
			control: (id, action) => { if (id !== 'g1' && id !== 'g2') { return false; } controls.push(id + ':' + action); return true; }
		}
	};
	const listing = await runSessionCommand(deps, 'objetivos', [], '/p', session);
	assert.deepEqual({
		listing: listing?.includes('g1') && listing?.includes('en ejecución') && listing?.includes('espera tus respuestas') && listing?.includes('¿Qué proveedor?'),
		paused: (await runSessionCommand(deps, 'objetivos', ['pausar', 'g1'], '/p', session))?.includes('pausar el objetivo g1'),
		stopped: (await runSessionCommand(deps, 'objetivos', ['detener', 'g2'], '/p', session))?.includes('detener el objetivo g2'),
		unknown: (await runSessionCommand(deps, 'objetivos', ['detener', 'nope'], '/p', session))?.includes('No hay un objetivo'),
		usage: await runSessionCommand(deps, 'objetivos', ['reanudar', 'g1'], '/p', session), controls,
		absent: (await runSessionCommand(base, 'objetivos', [], '/p', session))?.includes('no est'),
		empty: (await runSessionCommand({ ...base, goals: { ...deps.goals!, list: () => [] } }, 'objetivos', [], '/p', session))?.includes('No hay objetivos')
	}, { listing: true, paused: true, stopped: true, unknown: true, usage: 'Uso: /objetivos [pausar|detener ID]', controls: ['g1:pause', 'g2:stop'], absent: true, empty: true });
});
