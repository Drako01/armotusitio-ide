/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ChatToolCheckpointRecorder, listChatToolCheckpoints, restoreChatToolCheckpoint } from '../src/native-chat-tool-checkpoints.ts';

async function withRepo(run: (root: string, storage: string) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-tool-cp-')));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
	try {
		git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
		await fs.writeFile(path.join(root, 'owned.txt'), 'original');
		git('add', 'owned.txt'); git('commit', '-qm', 'fixture');
		await run(root, path.join(root, 'checkpoints'));
	} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
test('sequential chat tool snapshots restore only exact agent output', async () => {
	await withRepo(async (root, storage) => {
		const tool = new ChatToolCheckpointRecorder(root, storage);
		await tool.begin();
		tool.observe({ id: 'file-a', kind: 'edit', label: 'owned.txt', status: 'running' });
		await fs.writeFile(path.join(root, 'owned.txt'), 'agent change');
		tool.observe({ id: 'file-a', kind: 'edit', label: 'owned.txt', status: 'ok' });
		assert.equal(await tool.finish(), 1);
		const [checkpoint] = await listChatToolCheckpoints(root, storage);
		assert.equal(checkpoint.files.length, 1);
		await fs.writeFile(path.join(root, 'owned.txt'), 'human changed later');
		assert.deepEqual(await restoreChatToolCheckpoint(root, storage, checkpoint.id, async () => undefined),
			{ restored: [], skipped: ['owned.txt'] });
		assert.equal(await fs.readFile(path.join(root, 'owned.txt'), 'utf8'), 'human changed later');
		await fs.writeFile(path.join(root, 'owned.txt'), 'agent change');
		assert.deepEqual(await restoreChatToolCheckpoint(root, storage, checkpoint.id, async () => undefined),
			{ restored: ['owned.txt'], skipped: [] });
		assert.equal(await fs.readFile(path.join(root, 'owned.txt'), 'utf8'), 'original');
		assert.equal((await listChatToolCheckpoints(root, storage)).length, 0);
	});
});
test('concurrent tools cannot be falsely attributed to a single checkpoint', async () => {
	await withRepo(async (root, storage) => {
		const recorder = new ChatToolCheckpointRecorder(root, storage);
		await recorder.begin();
		recorder.observe({ id: 'a', kind: 'command', label: 'a', status: 'running' });
		recorder.observe({ id: 'b', kind: 'edit', label: 'b', status: 'running' });
		await fs.writeFile(path.join(root, 'owned.txt'), 'changed');
		recorder.observe({ id: 'a', kind: 'command', label: 'a', status: 'ok' });
		recorder.observe({ id: 'b', kind: 'edit', label: 'b', status: 'ok' });
		assert.equal(await recorder.finish(), 0);
		assert.deepEqual(await listChatToolCheckpoints(root, storage), []);
	});
});
