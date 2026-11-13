/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ChatToolCheckpointRecorder, inspectChatToolCheckpoints, listChatToolCheckpoints, restoreChatToolCheckpoint, toolCheckpointBefore } from '../src/native-chat-tool-checkpoints.ts';

async function withRepo(run: (root: string, storage: string) => Promise<void>): Promise<void> {
	// Like the IDE's global storage, the checkpoint store lives outside the workspace it describes.
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-tool-cp-')));
	const root = path.join(base, 'project');
	await fs.mkdir(root);
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
	try {
		git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
		await fs.writeFile(path.join(root, 'owned.txt'), 'original');
		git('add', 'owned.txt'); git('commit', '-qm', 'fixture');
		await run(root, path.join(base, 'checkpoints'));
	} finally { await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
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
test('the timeline preview reports each file change and later edits without writing anything', async () => {
	await withRepo(async (root, storage) => {
		const tool = new ChatToolCheckpointRecorder(root, storage);
		await tool.begin();
		tool.observe({ id: 'file-a', kind: 'edit', label: 'owned.txt', status: 'running' });
		await fs.writeFile(path.join(root, 'owned.txt'), 'agent change');
		await fs.writeFile(path.join(root, 'created.txt'), 'new file');
		tool.observe({ id: 'file-a', kind: 'edit', label: 'owned.txt', status: 'ok' });
		assert.equal(await tool.finish(), 1);
		const [view] = await inspectChatToolCheckpoints(root, storage);
		assert.deepEqual(view.files.sort((a, b) => a.path.localeCompare(b.path)), [
			{ path: 'created.txt', change: 'added', restorable: true },
			{ path: 'owned.txt', change: 'modified', restorable: true }
		]);
		assert.equal(Object.hasOwn(view, 'rootDigest'), false);
		assert.equal((await toolCheckpointBefore(root, storage, view.id, 'owned.txt'))?.toString('utf8'), 'original');
		assert.equal(await toolCheckpointBefore(root, storage, view.id, 'created.txt'), null);
		await assert.rejects(toolCheckpointBefore(root, storage, view.id, 'other.txt'), /HARNESS_TOOL_CHECKPOINT_INVALID/);
		await assert.rejects(toolCheckpointBefore(root, storage, '../escape', 'owned.txt'), /HARNESS_TOOL_CHECKPOINT_INVALID/);
		// A human edit after the tool shows as a conflict; the preview itself leaves both files as they are.
		await fs.writeFile(path.join(root, 'owned.txt'), 'human changed later');
		const [after] = await inspectChatToolCheckpoints(root, storage);
		assert.deepEqual(after.files.map(file => [file.path, file.restorable]).sort(), [['created.txt', true], ['owned.txt', false]]);
		assert.equal(await fs.readFile(path.join(root, 'owned.txt'), 'utf8'), 'human changed later');
		assert.equal(await fs.readFile(path.join(root, 'created.txt'), 'utf8'), 'new file');
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

/** One sequential edit of `file`, observed like a provider tool call. */
async function edit(recorder: ChatToolCheckpointRecorder, root: string, id: string, files: Record<string, string>, kind: 'edit' | 'command' = 'edit'): Promise<void> {
	recorder.observe({ id, kind, label: id, status: 'running' });
	for (const [file, content] of Object.entries(files)) { await fs.writeFile(path.join(root, file), content); }
	recorder.observe({ id, kind, label: id, status: 'ok' });
	await recorder.finish();
}

test('checkpoints are attributed to their turn in order, listed newest first and pruned by age', async () => {
	await withRepo(async (root, storage) => {
		const first = new ChatToolCheckpointRecorder(root, storage);
		await first.begin();
		for (let index = 0; index < 20; index++) { await edit(first, root, 'first-' + index, { 'owned.txt': 'first ' + index }); }
		execFileSync('git', ['commit', '-qam', 'turn one'], { cwd: root, stdio: 'pipe' });
		const second = new ChatToolCheckpointRecorder(root, storage);
		await second.begin();
		for (let index = 0; index < 6; index++) { await edit(second, root, 'second-' + index, { 'owned.txt': 'second ' + index }); }
		const listed = await listChatToolCheckpoints(root, storage);
		assert.deepEqual({
			count: listed.length, stored: (await fs.readdir(storage)).length,
			newest: listed.slice(0, 2).map(item => [item.stepId, item.turnId === second.turnId, item.sequence]),
			oldest: [listed.at(-1)!.stepId, listed.at(-1)!.turnId === first.turnId, listed.at(-1)!.sequence]
		}, { count: 24, stored: 24, newest: [['second-5', true, 6], ['second-4', true, 5]], oldest: ['first-2', true, 3] });
	});
});

test('an interrupted restore resumes after a new confirmation and never overwrites a later human edit', async () => {
	await withRepo(async (root, storage) => {
		const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
		await fs.writeFile(path.join(root, 'second.txt'), 'second original');
		git('add', 'second.txt'); git('commit', '-qm', 'second');
		const prepare = async (): Promise<string> => {
			const recorder = new ChatToolCheckpointRecorder(root, storage);
			await recorder.begin();
			await edit(recorder, root, 'both', { 'owned.txt': 'agent one', 'second.txt': 'agent two' }, 'command');
			return (await listChatToolCheckpoints(root, storage))[0].id;
		};
		const interrupted = (failAt: number) => { let calls = 0; return async () => { if (++calls === failAt) { throw Error('HARNESS_CANCELLED'); } }; };
		const contents = async () => [await fs.readFile(path.join(root, 'owned.txt'), 'utf8'), await fs.readFile(path.join(root, 'second.txt'), 'utf8')];

		const resumed = await prepare();
		// The fence fails after the first file was restored: the process "dies" between the two files.
		await assert.rejects(restoreChatToolCheckpoint(root, storage, resumed, interrupted(5)), /HARNESS_CANCELLED/);
		const half = await contents();
		const completed = await restoreChatToolCheckpoint(root, storage, resumed, async () => undefined);
		const whole = await contents();

		git('checkout', '-q', '--', '.');
		const conflicted = await prepare();
		await assert.rejects(restoreChatToolCheckpoint(root, storage, conflicted, interrupted(5)), /HARNESS_CANCELLED/);
		await fs.writeFile(path.join(root, 'second.txt'), 'human edit after the interruption');
		const refused = await restoreChatToolCheckpoint(root, storage, conflicted, async () => undefined);

		assert.deepEqual({ half, completed: { ...completed, restored: [...completed.restored].sort() }, whole, refused, kept: (await contents())[1], pending: (await fs.readdir(storage)).filter(name => name.endsWith('.restore.intent')).length }, {
			half: ['original', 'agent two'], completed: { restored: ['owned.txt', 'second.txt'], skipped: [] }, whole: ['original', 'second original'],
			refused: { restored: [], skipped: ['second.txt'] }, kept: 'human edit after the interruption', pending: 1
		});
	});
});

test('restoring returns the bytes a checkout writes, and tampered or sensitive records are refused', async () => {
	await withRepo(async (root, storage) => {
		const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
		git('config', 'core.autocrlf', 'true');
		await fs.writeFile(path.join(root, 'windows.txt'), 'one\r\ntwo\r\n');
		git('add', 'windows.txt'); git('commit', '-qm', 'crlf');
		const recorder = new ChatToolCheckpointRecorder(root, storage);
		await recorder.begin();
		await edit(recorder, root, 'eol', { 'windows.txt': 'agent\r\n' });
		const [checkpoint] = await listChatToolCheckpoints(root, storage);
		await restoreChatToolCheckpoint(root, storage, checkpoint.id, async () => undefined);
		const restoredBytes = await fs.readFile(path.join(root, 'windows.txt'), 'utf8');

		// A secret-named file is never captured: the whole run falls back to the per-run discard.
		const secret = new ChatToolCheckpointRecorder(root, storage);
		await secret.begin();
		await edit(secret, root, 'secret', { 'credentials.json': '{"token":"synthetic"}' });

		// A record rewritten to escape the workspace, or to claim another turn format, is not listed or restored.
		const record = JSON.parse(await fs.readFile(path.join(storage, checkpoint.id + '.json'), 'utf8'));
		const forged = '11111111-1111-4111-8111-111111111111';
		await fs.writeFile(path.join(storage, forged + '.json'), JSON.stringify({ ...record, id: forged, state: 'ready', files: [{ path: '../outside.txt', before: null, after: 'missing' }] }));
		const badTurn = '22222222-2222-4222-8222-222222222222';
		await fs.writeFile(path.join(storage, badTurn + '.json'), JSON.stringify({ ...record, id: badTurn, state: 'ready', turnId: '../../turn' }));
		await assert.rejects(restoreChatToolCheckpoint(root, storage, forged, async () => undefined), /HARNESS_TOOL_CHECKPOINT_INVALID/);
		await assert.rejects(restoreChatToolCheckpoint(root, storage, badTurn, async () => undefined), /HARNESS_TOOL_CHECKPOINT_INVALID/);
		await assert.rejects(restoreChatToolCheckpoint(root, storage, checkpoint.id, async () => undefined), /HARNESS_TOOL_CHECKPOINT_USED/);
		assert.deepEqual([restoredBytes, await secret.finish(), await listChatToolCheckpoints(root, storage)], ['one\r\ntwo\r\n', 0, []]);
	});
});
