/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Test helper: a separate process that holds an install lock until its stdin closes; argv: folder directory heartbeatMs staleMs. */
import { acquireInstallLock } from '../src/native-install-lock.ts';

const [folder, directory, heartbeatMs, staleMs] = process.argv.slice(2);
const lock = await acquireInstallLock(folder, { directory, heartbeatMs: Number(heartbeatMs), staleMs: Number(staleMs) });
process.stdout.write(lock ? 'held\n' : 'refused\n');
if (lock) {
	process.stdin.resume();
	process.stdin.on('end', () => { void lock.release().then(() => process.exit(0)); });
} else { process.exit(0); }
