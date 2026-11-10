/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { chooseChatImage, readChatImage, validateChatImages, MAX_IMAGE_BYTES } from '../src/native-chat-images.ts';
import { harness } from './native-runtime-harness.mts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('images are bounded workspace bytes with expiry and integrity, never a path reference', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-image-'));
	try {
		await fs.writeFile(path.join(root, 'image.png'), PNG);
		const image = await readChatImage(root, path.join(root, 'image.png'));
		validateChatImages([image]);
		assert.deepEqual([image.mime, Buffer.from(image.data, 'base64').equals(PNG), JSON.stringify(image).includes(root)], ['image/png', true, false]);
		assert.throws(() => validateChatImages([image], image.expiresAt), /HARNESS_IMAGE_INVALID/);
		assert.throws(() => validateChatImages([{ ...image, digest: 'changed' }]), /HARNESS_IMAGE_INVALID/);
		assert.throws(() => validateChatImages([image, image]), /HARNESS_IMAGE_LIMIT/);
		await fs.writeFile(path.join(root, '.env.png'), PNG);
		await assert.rejects(readChatImage(root, path.join(root, '.env.png')), /HARNESS_IMAGE_PATH_DENIED/);
		await fs.writeFile(path.join(root, 'fake.png'), Buffer.alloc(64));
		await assert.rejects(readChatImage(root, path.join(root, 'fake.png')), /HARNESS_IMAGE_INVALID/);
		await fs.writeFile(path.join(root, 'large.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
		await assert.rejects(readChatImage(root, path.join(root, 'large.png')), /HARNESS_IMAGE_LIMIT/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('image preview cancellation sends nothing and a changed file invalidates consent', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-image-consent-'));
	try {
		const file = path.join(root, 'image.png');
		await fs.writeFile(file, PNG);
		const events: string[] = [];
		const host = { pick: async () => file, preview: async () => { events.push('preview'); }, confirm: async () => { events.push('confirm'); return false; } };
		assert.equal(await chooseChatImage(root, host), undefined);
		assert.deepEqual(events, ['preview', 'confirm']);
		await assert.rejects(chooseChatImage(root, { ...host, confirm: async () => { await fs.writeFile(file, Buffer.alloc(64)); return true; } }), /HARNESS_IMAGE_INVALID|HARNESS_IMAGE_CHANGED/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const provider of ['codex', 'claude'] as const) {
	test(provider + ' protocol receives consented bytes, while journal retains no image data', async () => {
		const h = await harness(provider);
		try {
			await fs.writeFile(path.join(h.root, 'image.png'), PNG);
			const image = await readChatImage(h.root, path.join(h.root, 'image.png'));
			const session = await h.session();
			const result = await session.runTurn('INSPECT_IMAGE', 'conversation', undefined, undefined, undefined, [image]);
			assert.match(result.output, /images=1/);
			assert.ok(!JSON.stringify(await h.store.get(session.key)).includes(image.data));
		} finally { await h.close(); }
	});
}
