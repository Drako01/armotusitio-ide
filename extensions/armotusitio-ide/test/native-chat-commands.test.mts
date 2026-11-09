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

const t = (text: string, ...args: string[]) => text.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]);

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
