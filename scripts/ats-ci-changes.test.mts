/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyAtsChanges, isAtsInput } from './ats-ci-changes.mts';

const material = [
	'extensions/armotusitio-ide/src/chat.ts', 'extensions/armotusitio-ide/package-lock.json',
	'extensions/armotusitio-ide/resources/chat.js', 'scripts/ats-ci-changes.mts', 'scripts/ats-build-linux.mts',
	'scripts/ats-package-windows.mts', 'release.sh', '.github/workflows/ats-release.yml',
	'.github/workflows/ats-ide-extension.yml', 'package.json', 'package-lock.json', 'product.json', '.nvmrc', '.npmrc',
	'build/armotusitio/official-extensions.json', 'build/armotusitio/product-overrides.json',
	'build/armotusitio/check-official-extensions.ts', 'build/lib/armotusitioOfficialExtensions.ts',
	'build/gulpfile.vscode.js', 'build/npm/installStateHash.ts', 'build/package.json', 'build/package-lock.json',
	'build/lib/innoSetup.ts', 'build/win32/code.iss', 'remote/package-lock.json', 'extensions/copilot/package.json',
	'resources/win32/code.ico', 'resources/linux/code.png', 'resources/darwin/code.icns',
	'src/vs/platform/update/common/armotusitioUpdate.ts', 'src/vs/workbench/contrib/update/browser/update.ts',
];

for (const file of material) {
	test(`ATS contracts include ${file}`, () => {
		assert.equal(classifyAtsChanges([[{ filename: file }]], 1), true);
	});
}

for (const file of ['docs/guide.md', 'README.md', 'src/vs/editor/browser/editor.ts', 'extensions/git/README.md',
	'not-package.json', 'docs/build/armotusitio/official-extensions.json']) {
	test(`unrelated input permits contract skip: ${file}`, () => assert.equal(isAtsInput(file), false));
}

test('classification checks every page and both names of a renamed material file', () => {
	assert.deepEqual([
		classifyAtsChanges([[{ filename: 'README.md' }], [{ filename: 'product.json' }]], 2),
		classifyAtsChanges([[{ filename: 'docs/retired.json', previous_filename: 'build/armotusitio/official-extensions.json' }]], 1),
		classifyAtsChanges([[{ filename: 'README.md' }]], 1),
	], [true, true, false]);
});

test('empty, truncated, malformed and duplicate API responses fail closed', () => {
	for (const [pages, count] of [
		[[], 0], [[], 1], [[[]], 2], [[{ filename: 'README.md' }], 1],
		[[[null]], 1], [[[{}]], 1], [[[ { filename: '' } ]], 1],
		[[[{ filename: 'README.md' }, { filename: 'README.md' }]], 2],
		[[[{ filename: 'README.md', previous_filename: 1 }]], 1], [[[]], NaN],
	] as const) {
		assert.throws(() => classifyAtsChanges(pages, count));
	}
});
