/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { activityRank, sortActivity } = require('./presentation.ts');

/** Resolve a producer-owned regular entrypoint without following links outside the authorized root. */
async function nativeEntry(profile) {
	const relative = profile.id === 'redevent' ? '.harness/core.mjs' : profile.id === 'armotusitio' ? 'harness/scripts/ide.mjs' : undefined;
	if (!relative) { throw new Error('HARNESS_UNSUPPORTED'); }
	try {
		const root = await fs.realpath(profile.root);
		const entry = path.join(root, relative);
		if (!(await fs.lstat(entry)).isFile() || await fs.realpath(entry) !== entry) { throw new Error(); }
		return { root, entry };
	} catch { throw new Error('HARNESS_UNSUPPORTED'); }
}

/** Validate declared capabilities before allowing any native lifecycle mutation. */
function capabilities(value) {
	if (value?.contract !== 'armotusitio-harness-ide' || value.schemaVersion !== 1 || !/^1\./.test(value.version || '') || !Array.isArray(value.hosts) || !value.hosts.includes('project')) { throw new Error('HARNESS_CONTRACT'); }
	const required = ['preflight', 'run', 'execute', 'progress', 'list', 'status', 'resume', 'retry', 'abort'];
	if (!required.every(name => value.operations?.[name]?.supported === true)) { throw new Error('HARNESS_CAPABILITY'); }
	return { contract: value.contract, version: value.version, operations: Object.keys(value.operations).filter(name => value.operations[name]?.supported === true), hosts: ['project'], unsupported: (value.unsupported || []).map(item => String(item.id)).slice(0, 30) };
}

module.exports = { nativeEntry, capabilities, activityRank, sortActivity };
