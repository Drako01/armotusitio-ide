/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** In-memory image input: no temporary files, paths in prompts or implicit uploads. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SECRET_NAME } from './native-sensitive-scope.ts';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TTL_MS = 10 * 60 * 1000;
export interface ChatImage { mime: 'image/png' | 'image/jpeg'; data: string; digest: string; expiresAt: number }

/** Preview and consent are mandatory and injectable; the caller alone decides whether to send the returned bytes. */
export async function chooseChatImage(root: string, host: {
	pick(): Promise<string | undefined>;
	preview(file: string): Promise<void>;
	confirm(image: { mime: string; bytes: number; digest: string }): Promise<boolean>;
}): Promise<ChatImage | undefined> {
	const file = await host.pick();
	if (!file) { return undefined; }
	const image = await readChatImage(root, file);
	await host.preview(file);
	if (!await host.confirm({ mime: image.mime, bytes: Buffer.from(image.data, 'base64').length, digest: image.digest })) { return undefined; }
	if ((await readChatImage(root, file)).digest !== image.digest) { throw Error('HARNESS_IMAGE_CHANGED'); }
	validateChatImages([image]);
	return image;
}

function imageType(bytes: Buffer): ChatImage['mime'] {
	let width = 0, height = 0;
	let mime: ChatImage['mime'];
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		mime = 'image/png';
		let offset = 8, chunks = 0, imageData = false, ended = false;
		while (offset + 12 <= bytes.length && ++chunks <= 4096) {
			const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
			if (size > bytes.length - offset - 12) { throw Error('HARNESS_IMAGE_INVALID'); }
			if (chunks === 1) {
				if (type !== 'IHDR' || size !== 13) { throw Error('HARNESS_IMAGE_INVALID'); }
				width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
			}
			if (type === 'IDAT' && size > 0) { imageData = true; }
			offset += size + 12;
			if (type === 'IEND') { ended = size === 0 && offset === bytes.length; break; }
		}
		if (!imageData || !ended) { throw Error('HARNESS_IMAGE_INVALID'); }
	} else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
		mime = 'image/jpeg';
		let offset = 2;
		while (offset + 4 < bytes.length) {
			if (bytes[offset++] !== 0xff) { throw Error('HARNESS_IMAGE_INVALID'); }
			while (bytes[offset] === 0xff) { offset++; }
			const marker = bytes[offset++];
			if (marker === 0xda || marker === 0xd9) { break; }
			const size = bytes.readUInt16BE(offset);
			if (size < 2 || offset + size > bytes.length) { throw Error('HARNESS_IMAGE_INVALID'); }
			if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); }
			offset += size;
		}
	} else { throw Error('HARNESS_IMAGE_INVALID'); }
	if (!width || !height || width > 8192 || height > 8192 || width * height > 20_000_000) { throw Error('HARNESS_IMAGE_DIMENSIONS'); }
	return mime;
}

/** Revalidate at each protocol boundary; expired images are never silently replayed. */
export function validateChatImages(images: readonly ChatImage[], now = Date.now()): void {
	if (images.length > 1) { throw Error('HARNESS_IMAGE_LIMIT'); }
	for (const image of images) {
		if (!image || typeof image.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
			|| !Number.isFinite(image.expiresAt) || image.expiresAt <= now || image.expiresAt > now + IMAGE_TTL_MS) { throw Error('HARNESS_IMAGE_INVALID'); }
		const bytes = Buffer.from(image.data, 'base64');
		if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== image.data || imageType(bytes) !== image.mime
			|| createHash('sha256').update(bytes).digest('hex') !== image.digest) { throw Error('HARNESS_IMAGE_INVALID'); }
	}
}

/** A selected regular workspace image, loaded once into memory before preview and explicit consent. */
export async function readChatImage(root: string, file: string): Promise<ChatImage> {
	const canonicalRoot = await fs.realpath(root), canonical = await fs.realpath(file);
	const relative = path.relative(canonicalRoot, canonical);
	if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(segment => segment === '..' || segment.startsWith('.env') || SECRET_NAME.test(segment)
		|| ['.git', 'node_modules', '.armotusitio'].includes(segment) || /[:<>|]/.test(segment))) { throw Error('HARNESS_IMAGE_PATH_DENIED'); }
	const before = await fs.lstat(canonical);
	if (!before.isFile() || before.isSymbolicLink()) { throw Error('HARNESS_IMAGE_PATH_DENIED'); }
	const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		if (stat.ino !== before.ino || stat.dev !== before.dev || await fs.realpath(file) !== canonical) { throw Error('HARNESS_IMAGE_CHANGED'); }
		if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || stat.size < 32) { throw Error('HARNESS_IMAGE_LIMIT'); }
		const bytes = Buffer.alloc(stat.size + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead !== stat.size) { throw Error('HARNESS_IMAGE_CHANGED'); }
		const data = bytes.subarray(0, bytesRead);
		return { mime: imageType(data), data: data.toString('base64'), digest: createHash('sha256').update(data).digest('hex'), expiresAt: Date.now() + IMAGE_TTL_MS };
	} finally { await handle.close(); }
}
