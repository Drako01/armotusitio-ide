/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** IPC fixture: each start signal represents a competing IDE window's mutation. */
import { addUserRule, removeUserRule } from '../src/native-permissions.ts';

const [home, role] = process.argv.slice(2);
process.on('message', async (round: number) => {
	try {
		if (role === 'revoke') { await removeUserRule('run:revoked' + round, home); }
		await addUserRule('run:' + role + round, 'allow', home);
		process.send?.({ round });
	} catch (error) {
		process.send?.({ error: error instanceof Error ? error.message : 'FAILED' });
	}
});
process.send?.({ ready: true });
