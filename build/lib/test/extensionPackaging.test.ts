/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import { packageExtensionDependenciesAfterBuild } from '../extensions.ts';

test('SDK packaging waits for asynchronous extension postinstall to finish', async () => {
	const build = new PassThrough({ objectMode: true });
	let sdkReady = false;
	let sdkRead = false;
	const output = packageExtensionDependenciesAfterBuild(build, () => {
		assert.ok(sdkReady, 'postinstall has recreated the SDK');
		sdkRead = true;
		return Readable.from(['sdk']);
	});
	const files: string[] = [];
	const completed = new Promise<void>((resolve, reject) => output.on('data', file => files.push(String(file))).once('end', resolve).once('error', reject));
	build.write('extension');
	await Promise.resolve();
	assert.equal(sdkRead, false);
	sdkReady = true;
	build.end();
	await completed;
	assert.deepEqual(files, ['extension', 'sdk']);
});

test('a failed extension build never starts SDK packaging', async () => {
	const build = new PassThrough({ objectMode: true });
	let sdkRead = false;
	const output = packageExtensionDependenciesAfterBuild(build, () => { sdkRead = true; return Readable.from([]); });
	const failed = new Promise<void>(resolve => output.once('error', () => resolve()));
	build.emit('error', new Error('postinstall failed'));
	build.end();
	await failed;
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(sdkRead, false);
});
