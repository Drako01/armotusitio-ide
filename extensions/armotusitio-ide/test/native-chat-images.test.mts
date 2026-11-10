/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { chatImageFromData, chooseChatImage, readChatImage, validateChatImages, MAX_IMAGE_BYTES } from '../src/native-chat-images.ts';
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

test('pasted or dropped image bytes are validated by content on the host, whatever the webview declares', () => {
	const now = 1_000_000;
	const data = PNG.toString('base64');
	const image = chatImageFromData('image/png', data, now);
	const code = (run: () => unknown): string => { try { run(); return 'accepted'; } catch (error) { return (error as Error).message; } };
	// IHDR declaring 20000 x 20000 pixels: valid structure, refused before any decoder sees it.
	const huge = Buffer.from(PNG); huge.writeUInt32BE(20000, 16); huge.writeUInt32BE(20000, 20);
	assert.deepEqual({
		accepted: [image.mime, image.expiresAt - now, Buffer.from(image.data, 'base64').equals(PNG)],
		wrongMime: code(() => chatImageFromData('image/jpeg', data, now)),
		unsupportedMime: code(() => chatImageFromData('image/svg+xml', data, now)),
		notBase64: code(() => chatImageFromData('image/png', '<svg onload=alert(1)>', now)),
		paddedBase64: code(() => chatImageFromData('image/png', data.replace(/=+$/, '') + 'A===', now)),
		truncated: code(() => chatImageFromData('image/png', PNG.subarray(0, PNG.length - 12).toString('base64'), now)),
		trailingBytes: code(() => chatImageFromData('image/png', Buffer.concat([PNG, Buffer.from('<script>')]).toString('base64'), now)),
		oversized: code(() => chatImageFromData('image/png', 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4), now)),
		dimensions: code(() => chatImageFromData('image/png', huge.toString('base64'), now)),
		empty: code(() => chatImageFromData('image/png', '', now)),
		nonString: code(() => chatImageFromData('image/png', { data }, now)),
		expired: code(() => validateChatImages([image], image.expiresAt + 1))
	}, {
		accepted: ['image/png', 10 * 60 * 1000, true],
		wrongMime: 'HARNESS_IMAGE_INVALID', unsupportedMime: 'HARNESS_IMAGE_INVALID', notBase64: 'HARNESS_IMAGE_INVALID', paddedBase64: 'HARNESS_IMAGE_INVALID',
		truncated: 'HARNESS_IMAGE_INVALID', trailingBytes: 'HARNESS_IMAGE_INVALID', oversized: 'HARNESS_IMAGE_INVALID', dimensions: 'HARNESS_IMAGE_DIMENSIONS',
		empty: 'HARNESS_IMAGE_INVALID', nonString: 'HARNESS_IMAGE_INVALID', expired: 'HARNESS_IMAGE_INVALID'
	});
});
