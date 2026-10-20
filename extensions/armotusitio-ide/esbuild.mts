/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const root = import.meta.dirname;
await Promise.all([
	run({ platform: 'node', entryPoints: { extension: path.join(root, 'extension.ts') }, srcDir: root, outdir: path.join(root, 'dist') }, process.argv),
	run({ platform: 'browser', entryPoints: { home: path.join(root, 'resources/home.ts') }, srcDir: path.join(root, 'resources'), outdir: path.join(root, 'dist') }, process.argv)
]);
