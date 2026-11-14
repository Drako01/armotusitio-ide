/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

test('MSIX builder rejects altered archives before extraction or packaging', { skip: process.platform !== 'win32' }, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-msix-integrity-'));
	try {
		const archive = path.join(directory, 'release.zip');
		await fs.writeFile(archive, 'altered release bytes');
		await assert.rejects(promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'ats-package-msix.ps1'), '-Archive', archive, '-ExpectedSha256', '0'.repeat(64), '-Version', '1.146.2.0'], { windowsHide: true }), /Release archive SHA256 mismatch/);
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
