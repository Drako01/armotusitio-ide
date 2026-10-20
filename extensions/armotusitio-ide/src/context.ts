/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const IGNORED = new Set(['node_modules', '.git', '.next', '.harness', '.env', 'dist', 'out', 'coverage', '.turbo', '.artifacts', 'vendor', 'build', 'tmp']);
const SOURCE_EXT = new Set(['.go', '.php', '.ts', '.tsx', '.js', '.mjs', '.py', '.sql', '.json', '.md', '.yaml', '.yml']);
async function indexProject(root, { limit = 5000 } = {}) {
	const result = { files: [], byExtension: {}, truncated: false };
	const stack = [{ dir: root, depth: 0 }];
	while (stack.length && result.files.length < limit) {
		const { dir, depth } = stack.pop(); if (depth > 10) { continue; }
		let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (entry.isSymbolicLink() || entry.name.startsWith('.env') || IGNORED.has(entry.name)) { continue; }
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { if (depth < 10) { stack.push({ dir: full, depth: depth + 1 }); } continue; }
			if (!entry.isFile()) { continue; }
			const ext = path.extname(entry.name).toLowerCase();
			if (!SOURCE_EXT.has(ext)) { continue; }
			const relative = path.relative(root, full).split(path.sep).join('/');
			result.files.push(relative); result.byExtension[ext] = (result.byExtension[ext] || 0) + 1;
			if (result.files.length >= limit) { result.truncated = true; break; }
		}
	}
	result.files.sort(); return result;
}
function summary(index: { byExtension: Record<string, number> }) { return Object.entries(index.byExtension).sort((a, b) => b[1] - a[1]).map(([ext, count]) => ext + ': ' + count).join(', '); }
module.exports = { indexProject, summary };
