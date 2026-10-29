/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
	main: string;
	contributes: { commands: { command: string }[] };
};
const required = ['atsHarness.nativeDoctor', 'atsHarness.nativeConfigure', 'atsHarness.nativeSupport', 'atsHarness.nativeNewTask', 'atsHarness.nativeStatus', 'atsHarness.nativeRunTask', 'atsHarness.nativeReconcile', 'atsHarness.nativeCancel'];
for (const command of required) {
	if (!manifest.contributes.commands.some(entry => entry.command === command)) {
		throw Error(`HARNESS_PACKAGE_COMMAND_MISSING: ${command}`);
	}
}
const artifacts = [manifest.main, 'dist/home.js', 'dist/chat.js'];
for (const artifact of artifacts) {
	const absolute = path.resolve(root, artifact);
	if (!absolute.startsWith(root + path.sep)) { throw Error('HARNESS_PACKAGE_ESCAPE'); }
	const file = await stat(absolute);
	if (!file.isFile() || file.size === 0) { throw Error(`HARNESS_PACKAGE_RESOURCE_INVALID: ${artifact}`); }
}
const code = await readFile(path.resolve(root, manifest.main), 'utf8');
if (!code.includes('atsHarness.nativeSupport') || !code.includes('atsHarness.nativeConfigure')) {
	throw Error('HARNESS_PACKAGE_COMMAND_NOT_BUNDLED');
}
process.stdout.write('Native Harness package resource checks: PASS\n');
