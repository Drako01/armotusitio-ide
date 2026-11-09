/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** The runner channel must work whatever the length of the IDE storage path (POSIX socket paths are limited to about 104 bytes). */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { callToolChannel, openToolChannel } from '../src/native-tool-server.ts';

test('a channel opens, serves and cleans up even when the storage path is far longer than a socket path may be', async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-chan-'));
	try {
		const storage = path.join(base, 'private', 'native-harness', 'a'.repeat(120), 'runs', '1794183352867-8ec6e86d9821');
		assert.ok(storage.length > 150);
		const channel = await openToolChannel(storage, async (method, params) => ({ method, params }));
		const answer = await callToolChannel(channel.address, channel.token, 'echo', { value: 1 });
		const wrongToken = await callToolChannel(channel.address, 'x'.repeat(64), 'echo', {}).then(() => 'answered', error => (error as Error).message);
		await channel.close();
		// The socket file (POSIX) or its private directory must be gone once the channel is closed.
		await new Promise(resolve => setTimeout(resolve, 50));
		const left = process.platform === 'win32' ? false : await fs.stat(channel.address).then(() => true, () => false);
		assert.deepEqual({ answer, wrongToken, left, shortEnough: process.platform === 'win32' || Buffer.byteLength(channel.address) <= 100 },
			{ answer: { method: 'echo', params: { value: 1 } }, wrongToken: 'HARNESS_UNTRUSTED_OR_CANCELLED', left: false, shortEnough: true });
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});
