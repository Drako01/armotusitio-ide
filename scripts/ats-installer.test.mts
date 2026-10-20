/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureInnoSetup } from '../build/lib/innoSetup.ts';

const execute = promisify(execFile);

test('pinned Inno Setup compiles long-path payloads without producing or executing a test installer', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
	const repository = path.resolve(import.meta.dirname, '..');
	const compiler = await ensureInnoSetup(repository);
	assert.equal(await ensureInnoSetup(repository), compiler);
	const workspace = path.join(repository, '.build');
	await mkdir(workspace, { recursive: true });
	const temporary = await mkdtemp(path.join(workspace, 'ats-long-path-'));
	try {
		const destination = path.join(temporary, 'Users', 'a-long-user-name-for-regression-testing', 'AppData', 'Local', 'Programs', 'ArmotuSitio IDE');
		const relative = 'resources\\app\\extensions\\copilot\\node_modules\\@opentelemetry\\exporter-metrics-otlp-proto\\node_modules\\@opentelemetry\\resources\\build\\esnext\\detectors\\platform\\node\\machine-id\\getMachineId-unsupported.js.map';
		const installed = path.join(destination, relative);
		assert.ok(installed.length > 300);
		await mkdir(path.dirname(installed), { recursive: true });
		await writeFile(installed, 'long path regression fixture');
		const script = [
			'[Setup]', 'AppName=ATS installer regression fixture', 'AppVersion=1.0',
			`DefaultDirName=${destination}`, `OutputDir=${temporary}`, 'OutputBaseFilename=fixture',
			'PrivilegesRequired=lowest', 'Uninstallable=no', 'CreateUninstallRegKey=no',
			'DisableProgramGroupPage=yes', 'Compression=none', 'Output=no',
			'[Files]', `Source: "${installed}"; DestDir: "{app}\\${path.win32.dirname(relative)}"; DestName: "${path.win32.basename(relative)}"; Flags: ignoreversion`,
		].join('\r\n');
		const scriptPath = path.join(temporary, 'fixture.iss');
		await writeFile(scriptPath, script);
		await execute(compiler, [scriptPath], { windowsHide: true, timeout: 30000 });
		await assert.rejects(readFile(path.join(temporary, 'fixture.exe')), { code: 'ENOENT' });
		assert.equal(await readFile(installed, 'utf8'), 'long path regression fixture');
	} finally {
		const target = path.resolve(temporary);
		assert.ok(target.startsWith(path.resolve(workspace) + path.sep) && path.basename(target).startsWith('ats-long-path-'));
		await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
