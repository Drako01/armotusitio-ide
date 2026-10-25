/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

/** Accept only producer log references, never paths supplied by the webview. */
function logReference(value) { return typeof value === 'string' && /^\.harness\/logs\/(?:audit\/)?[a-z0-9][a-z0-9._-]{0,159}\.(?:log|json|txt)$/i.test(value); }

/** Read a bounded tail of a regular log inside the authorized project without following links. */
async function readEvidence(root, relative) {
	if (!logReference(relative)) { throw new Error('HARNESS_EVIDENCE'); }
	const directory = await fs.realpath(root);
	const target = path.join(directory, relative);
	if (!(await fs.lstat(target)).isFile() || await fs.realpath(target) !== target) { throw new Error('HARNESS_EVIDENCE'); }
	const file = await fs.open(target, 'r');
	try {
		const info = await file.stat();
		if (!info.isFile()) { throw new Error('HARNESS_EVIDENCE'); }
		const buffer = Buffer.alloc(Math.min(info.size, 65536));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length));
		const tail = buffer.subarray(0, bytesRead).toString('utf8');
		if (info.size > buffer.length) { const line = tail.indexOf('\n'); return line < 0 ? '' : tail.slice(line + 1); }
		return tail;
	} finally { await file.close(); }
}

module.exports = { logReference, readEvidence };
