/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar. */
import { mkdir, copyFile } from 'node:fs/promises';
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

await import('./sync-engineering-skills.mts');
const root = import.meta.dirname;
await Promise.all([
	run({ platform: 'node', entryPoints: {
		extension: path.join(root, 'extension.ts'),
		'ats-runner': path.join(root, 'src/ats-runner.ts')
	}, srcDir: root, outdir: path.join(root, 'dist') }, process.argv),
	run({ platform: 'node', format: 'esm', entryPoints: {
		'chat-document-worker': path.join(root, 'src/native-chat-document-worker.mts')
	}, srcDir: root, outdir: path.join(root, 'dist'),
	additionalOptions: { outExtension: { '.js': '.mjs' } } }, process.argv),
	run({ platform: 'browser', entryPoints: {
		home: path.join(root, 'resources/home.ts'),
		accounts: path.join(root, 'resources/accounts.ts'),
		chat: path.join(root, 'resources/chat.ts')
	}, srcDir: path.join(root, 'resources'), outdir: path.join(root, 'dist') }, process.argv)
]);

// Offline text-only PDF extraction. The parser is bundled without native canvas or rendering.
await mkdir(path.join(root, 'dist/pdfjs'), { recursive: true });
for (const [source, target] of [
	['legacy/build/pdf.mjs', 'pdf.mjs'],
	['legacy/build/pdf.worker.mjs', 'pdf.worker.mjs'],
	['LICENSE', 'LICENSE']
]) {
	await copyFile(path.join(root, 'node_modules/pdfjs-dist', source), path.join(root, 'dist/pdfjs', target));
}
