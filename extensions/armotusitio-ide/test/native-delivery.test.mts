/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { acceptDelivery, commitMessage, commitStep, createDelivery, deliveryFiles, deliverySlug, discardDelivery } from '../src/native-delivery.ts';

test('a delivery works on its own branch without touching the user\'s uncommitted changes; Accept detects collisions', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-delivery-')));
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-delivery-storage-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
	try {
		git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'core.autocrlf', 'false');
		await fs.writeFile(path.join(root, 'a.txt'), 'base'); await fs.writeFile(path.join(root, 'b.txt'), 'base');
		git('add', '.'); git('commit', '-qm', 'base');
		await fs.writeFile(path.join(root, 'a.txt'), 'edición del usuario sin commit');
		const delivery = await createDelivery(root, storage, 'Subí la cobertura de apps/api');
		await fs.writeFile(path.join(delivery.worktree, 'a.txt'), 'cambio del agente');
		await fs.writeFile(path.join(delivery.worktree, 'new_test.go'), 'package x');
		const commit = await commitStep(delivery, commitMessage('test', 'Tanda 1'));
		const nothing = await commitStep(delivery, commitMessage('test', 'Tanda vacía'));
		const blocked = await acceptDelivery(delivery);
		assert.deepEqual({
			branch: delivery.branch, slug: deliverySlug('¡Mañana!'), committed: !!commit, nothing, files: await deliveryFiles(delivery),
			userKept: await fs.readFile(path.join(root, 'a.txt'), 'utf8'), message: git('log', '-1', '--format=%s', delivery.branch), blocked
		}, {
			branch: 'harness/subi-la-cobertura-de-apps-api', slug: 'manana', committed: true, nothing: undefined, files: ['a.txt', 'new_test.go'],
			userKept: 'edición del usuario sin commit', message: 'test: tanda 1', blocked: { integrated: false, conflicts: ['a.txt'] }
		});
		// Without the collision, Accept fast-forwards the user's branch and removes the worktree.
		git('checkout', '--', 'a.txt');
		assert.deepEqual(await acceptDelivery(delivery), { integrated: true, conflicts: [] });
		assert.equal(await fs.readFile(path.join(root, 'new_test.go'), 'utf8'), 'package x');
		const second = await createDelivery(root, storage, 'Subí la cobertura de apps/api');
		await discardDelivery(second);
		assert.deepEqual({ suffix: second.branch, branches: git('branch', '--list', 'harness/*').split('\n').map(line => line.trim()).filter(Boolean) },
			{ suffix: 'harness/subi-la-cobertura-de-apps-api-2', branches: ['harness/subi-la-cobertura-de-apps-api'] });
	} finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});
