/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar. */
/** Read only regular workspace documents, without following symlinks or exposing sensitive paths. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SECRET_NAME } from './native-sensitive-scope.ts';

export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export type DocumentKind = 'pdf' | 'notebook';
export interface BoundedDocument { bytes: Uint8Array; kind: DocumentKind; digest: string }

export async function readBoundedDocument(root: string, file: string): Promise<BoundedDocument> {
	const realRoot = await fs.realpath(root);
	const canonical = await fs.realpath(file);
	const relative = path.relative(realRoot, canonical);
	if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(segment => segment === '..' || segment.startsWith('.')
		|| SECRET_NAME.test(segment) || ['node_modules', 'dist', '.harness'].includes(segment.toLowerCase()) || /[:<>|]/.test(segment))) {
		throw Error('HARNESS_ATTACHMENT_INVALID');
	}
	const ext = path.extname(canonical).toLowerCase();
	const kind: DocumentKind = ext === '.pdf' ? 'pdf' : ext === '.ipynb' ? 'notebook' : (() => { throw Error('HARNESS_ATTACHMENT_FORMAT'); })();
	const before = await fs.lstat(canonical);
	if (!before.isFile() || before.isSymbolicLink()) { throw Error('HARNESS_ATTACHMENT_INVALID'); }
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
	const handle = await fs.open(canonical, flags);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size < 8 || stat.size > MAX_DOCUMENT_BYTES) { throw Error('HARNESS_ATTACHMENT_LIMIT'); }
		if (stat.ino !== before.ino || stat.dev !== before.dev || (await fs.realpath(file)) !== canonical) { throw Error('HARNESS_ATTACHMENT_INVALID'); }
		const bytes = Buffer.alloc(stat.size + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead !== stat.size) { throw Error('HARNESS_ATTACHMENT_INVALID'); }
		const value = bytes.subarray(0, bytesRead);
		return { bytes: value, kind, digest: createHash('sha256').update(value).digest('hex') };
	} finally { await handle.close(); }
}
