/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Child process of the fence E2E: tries to take the shared writer fence, reports the outcome and, if it got it, holds it until killed. */
import { acquireSharedExecutionFence } from '../src/native-shared-fence.ts';

const [root, storage, owner] = process.argv.slice(2);
try {
	const fence = await acquireSharedExecutionFence(root, storage, owner as 'native-task' | 'native-agent');
	process.stdout.write('held:' + fence.epoch + '\n');
	setTimeout(() => process.exit(0), 60000);
} catch (error) {
	process.stdout.write('refused:' + (error as Error).message + '\n');
	process.exit(3);
}
