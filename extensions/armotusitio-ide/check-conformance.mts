/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Chat conformance gate: the end-to-end scenarios plus the unit suites they rely on (policy, permissions, approvals, git
 * delivery, runner, chat session). Runs on any branch without touching git state; `./release.sh --dry-run` runs it too.
 */
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const suites = [
	'native-chat-conformance', 'native-approve-tool', 'native-command-policy', 'native-permissions', 'native-runner-approval',
	'native-chat-approvals', 'native-git-tools', 'native-git-delivery', 'native-chat-session', 'native-setup-check'
].map(name => path.join(root, 'test', name + '.test.mts'));

const code = await new Promise<number | null>((resolve, reject) => {
	const child = spawn(process.execPath, ['--test', ...suites], { cwd: root, stdio: 'inherit', windowsHide: true });
	child.once('error', reject);
	child.once('close', resolve);
});
if (code !== 0) { throw Error(`HARNESS_CONFORMANCE_FAILED: exit ${code}`); }
console.log('PASS chat conformance');
