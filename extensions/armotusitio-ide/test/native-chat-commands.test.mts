/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSessionCommand, type SessionCommandDeps } from '../src/native-chat-commands.ts';
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
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});
