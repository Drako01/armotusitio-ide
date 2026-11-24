/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
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

/** Holds files open the way McAfee's mc-fw-host does: reading and sharing read and delete, so they can be renamed but not opened exclusively. */
async function holdFiles(directory: string, files: string[]): Promise<() => Promise<void>> {
	const script = path.join(directory, 'hold.ps1');
	await writeFile(script, [
		`$held = foreach ($file in $args) { [IO.File]::Open($file, 'Open', 'Read', 'Read, Delete') }`,
		`'held'`,
		'[Console]::In.ReadToEnd() | Out-Null',
		'$held | ForEach-Object { $_.Dispose() }',
	].join('\r\n'));
	const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...files], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
	await new Promise<void>((resolve, reject) => {
		holder.once('error', reject);
		holder.once('exit', code => reject(new Error(`The file holder exited early (${code}).`)));
		holder.stdout.on('data', data => String(data).includes('held') && resolve());
	});
	return () => new Promise(resolve => { holder.once('exit', () => resolve()); holder.stdin.end(); });
}

test('a background update finishes past files an antivirus holds, long paths and read-only files, a failed one keeps the previous version, and uninstall removes the product', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
	const repository = path.resolve(import.meta.dirname, '..');
	const compiler = await ensureInnoSetup(repository);
	const workspace = path.join(repository, '.build');
	await mkdir(workspace, { recursive: true });
	const temporary = await mkdtemp(path.join(workspace, 'ats-held-files-'));
	let release: (() => Promise<void>) | undefined;
	try {
		const app = path.join(temporary, 'app');
		const tools = path.join(repository, 'build', 'win32');
		const setup = ['PrivilegesRequired=lowest', 'CreateUninstallRegKey=no', 'DisableDirPage=yes', 'DisableProgramGroupPage=yes', 'Compression=none',
			'ArchitecturesAllowed=x64compatible', 'ArchitecturesInstallIn64BitMode=x64compatible', `DefaultDirName=${app}`, `OutputDir=${temporary}`];
		const write = async (root: string, version: string) => {
			for (const file of ['App.exe', 'resources\\a.dll', 'resources.pak', ...(version === 'v1' ? [] : ['resources\\added.txt'])]) {
				await mkdir(path.dirname(path.join(root, file)), { recursive: true });
				await writeFile(path.join(root, file), version);
			}
		};
		const read = (file: string) => readFile(path.join(app, file), 'utf8').catch(() => null);
		const exists = (file: string) => access(path.join(app, file)).then(() => true, () => false);
		// The previous version, installed by Inno Setup so inno_updater finds a real unins000.dat.
		await write(path.join(temporary, 'v1'), 'v1');
		// The uninstall entries of the real installer, with the fixture's executable name.
		const product = (await readFile(path.join(tools, 'code.iss'), 'utf8')).replaceAll('\r\n', '\n');
		const uninstallDelete = product.slice(product.indexOf('[UninstallDelete]'), product.indexOf('\n[', product.indexOf('[UninstallDelete]'))).replaceAll('{#ExeBasename}', 'App');
		await writeFile(path.join(temporary, 'base.iss'), ['[Setup]', 'AppName=ATS held files fixture', 'AppVersion=1', 'OutputBaseFilename=base', ...setup,
			'[Files]', `Source: "${path.join(temporary, 'v1')}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs`, ...uninstallDelete.split('\n')].join('\r\n'));
		// The background update steps of code.iss: replace the tools, then run inno_updater around held files.
		await writeFile(path.join(temporary, 'runner.iss'), ['[Setup]', 'AppName=ATS held files runner', 'AppVersion=2', 'OutputBaseFilename=runner', 'Uninstallable=no', 'UsePreviousAppDir=no', ...setup,
			'[Files]',
			`Source: "${path.join(tools, 'inno_updater.exe')}"; DestDir: "{app}\\tools"; BeforeInstall: MoveToolAsideIfHeld; Flags: ignoreversion`,
			`Source: "${path.join(tools, 'vcruntime140.dll')}"; DestDir: "{app}\\tools"; BeforeInstall: MoveToolAsideIfHeld; Flags: ignoreversion`,
			'[Code]', `#include "${path.join(tools, 'locked-files.iss')}"`,
			'procedure CurStepChanged(CurStep: TSetupStep);',
			'var', '  ResultCode: Integer;', '  Updater, Params: String;',
			'begin',
			`  if (CurStep = ssInstall) and (ExpandConstant('{param:cleanstaged|}') <> '') then`, `    DeleteStagedUpdate(ExpandConstant('{app}'));`,
			'  if CurStep <> ssPostInstall then', '    exit;',
			`  Updater := ExpandConstant('{app}\\tools\\inno_updater.exe');`,
			`  Params := ExpandConstant('"{app}\\App.exe" true "test"');`,
			`  if ExpandConstant('{param:fail|}') <> '' then begin`, `    Updater := ExpandConstant('{cmd}');`, `    Params := '/c exit 3';`, '  end;',
			`  if RunUpdaterAroundHeldFiles(Updater, ExpandConstant('{app}\\App.exe'), Params, ResultCode) then`,
			`    SaveStringToFile(ExpandConstant('{param:result}'), 'updated', False)`,
			'  else',
			`    SaveStringToFile(ExpandConstant('{param:result}'), 'failed ' + IntToStr(ResultCode), False);`,
			'end;'].join('\r\n'));
		for (const script of ['base.iss', 'runner.iss']) {
			await execute(compiler, ['/Q', path.join(temporary, script)], { windowsHide: true, timeout: 60000 });
		}
		await execute(path.join(temporary, 'base.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true, timeout: 60000 });
		await mkdir(path.join(app, 'tools'), { recursive: true });
		for (const file of ['inno_updater.exe', 'vcruntime140.dll']) {
			await copyFile(path.join(tools, file), path.join(app, 'tools', file));
		}
		// What the editor and its extensions leave in the install folder while they run: a path past the Win32 limit, which
		// inno_updater cannot open (os error 3), a read-only file, and a junction to a folder outside, which nothing may follow.
		let longFile = 'resources\\app\\extensions\\copilot\\node_modules';
		while (path.join(app, longFile).length < 265) { longFile += '\\nested-dependency'; }
		longFile += '\\file.js';
		const readOnlyFile = 'resources\\read-only.txt';
		const outside = path.join(temporary, 'outside');
		const addRuntimeFiles = async () => {
			await mkdir(path.dirname(path.join(app, longFile)), { recursive: true });
			await writeFile(path.join(app, longFile), 'runtime');
			await writeFile(path.join(app, readOnlyFile), 'runtime');
			await chmod(path.join(app, readOnlyFile), 0o444);
			await mkdir(outside, { recursive: true });
			await writeFile(path.join(outside, 'keep.txt'), 'outside');
			await symlink(outside, path.join(app, 'resources', 'linked'), 'junction');
		};
		const isReadOnly = (file: string) => stat(path.join(app, file)).then(info => (info.mode & 0o200) === 0, () => null);
		// Windows Defender may briefly hold freshly copied tools too, so the summary looks only at the files this test prepares.
		const heldFiles = ['App.exe', 'resources\\a.dll'];
		const heldTool = 'tools\\inno_updater.exe';
		const expectedMoves = [...heldFiles, longFile, readOnlyFile].sort();
		const ours = (files: string[]) => files.filter(file => expectedMoves.includes(file)).sort();
		const runner = async (...args: string[]) => {
			const result = path.join(temporary, 'result.txt');
			const log = path.join(temporary, 'runner.log');
			await rm(result, { force: true });
			await execute(path.join(temporary, 'runner.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCLOSEAPPLICATIONS', `/LOG=${log}`, `/result=${result}`, ...args], { windowsHide: true, timeout: 120000 })
				.catch(async error => { throw new Error(`${error.message}\n${await readFile(log, 'utf8').catch(() => '')}`); });
			// The files this run moved out of inno_updater's way, from the Setup log.
			const moved = [...(await readFile(log, 'utf8')).matchAll(/Moved a file inno_updater cannot delete out of the way: (?<file>.+?) -> /g)].map(match => path.relative(app, match.groups?.file ?? ''));
			return { result: await readFile(result, 'utf8'), moved: ours(moved), tool: moved.includes(heldTool) };
		};

		await addRuntimeFiles();
		await write(path.join(app, '_'), 'v2');
		release = await holdFiles(temporary, [...heldFiles, heldTool].map(file => path.join(app, file)));
		// Without moving those files, inno_updater keeps retrying the exclusive open and changes nothing.
		const stalled = await execute(path.join(app, 'tools', 'inno_updater.exe'), [path.join(app, 'App.exe'), 'true', 'test'], { windowsHide: true, timeout: 8000 }).then(() => false, error => error.killed === true);
		const baseline = { stalled, exe: await read('App.exe') };
		const { tool, ...rollbackRun } = await runner('/fail=1');
		const rollback = { ...rollbackRun, tool, exe: await read('App.exe'), dll: await read('resources\\a.dll'), long: await read(longFile), readOnly: await isReadOnly(readOnlyFile), staged: await exists('_') };
		const { tool: _heldTool, ...heldRun } = await runner();
		const held = {
			...heldRun, exe: await read('App.exe'), dll: await read('resources\\a.dll'), added: await read('resources\\added.txt'), long: await read(longFile), readOnly: await isReadOnly(readOnlyFile),
			staged: await exists('_'), staleRemoved: !await exists('tools\\stale'), outside: await readFile(path.join(outside, 'keep.txt'), 'utf8').catch(() => null),
		};
		await release();
		release = undefined;
		// Leftovers of a failed update are deleted before a new one stages.
		await write(path.join(app, '_'), 'leftover');
		const { tool: _cleanupTool, ...cleanupRun } = await runner('/cleanstaged=1', '/fail=1');
		const cleanup = { ...cleanupRun, staged: await exists('_') };
		await write(path.join(app, '_'), 'v3');
		const { tool: _cleanTool, ...cleanRun } = await runner();
		const clean = { ...cleanRun, exe: await read('App.exe'), staleRemoved: !await exists('tools\\stale') };
		// inno_updater 0.23.0 cannot rewrite the Inno Setup 7 uninstall log, so uninstalling after background updates relies
		// on the [UninstallDelete] entries: the product goes, a portable data folder stays, and the junction is not followed.
		await mkdir(path.join(app, 'data'), { recursive: true });
		await writeFile(path.join(app, 'data', 'keep.txt'), 'user');
		await symlink(outside, path.join(app, 'resources', 'linked'), 'junction');
		await execute(path.join(app, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true, timeout: 60000 });
		// The uninstaller runs from a temporary copy and deletes unins000.exe last.
		for (let attempt = 0; attempt < 120 && await exists('unins000.exe'); attempt++) { await new Promise(resolve => setTimeout(resolve, 500)); }
		const uninstall = { left: (await readdir(app).catch(() => [])).sort(), data: await read('data\\keep.txt'), outside: await readFile(path.join(outside, 'keep.txt'), 'utf8').catch(() => null) };

		// Windows deletes a file that is held with delete sharing, so a successful update already removes what it moved.
		assert.deepEqual({ baseline, rollback, held, cleanup, clean, uninstall }, {
			baseline: { stalled: true, exe: 'v1' },
			rollback: { result: 'failed 3', moved: expectedMoves, tool: true, exe: 'v1', dll: 'v1', long: 'runtime', readOnly: true, staged: true },
			held: { result: 'updated', moved: expectedMoves, exe: 'v2', dll: 'v2', added: 'v2', long: null, readOnly: null, staged: false, staleRemoved: true, outside: 'outside' },
			cleanup: { result: 'failed 3', moved: [], staged: false },
			clean: { result: 'updated', moved: [], exe: 'v3', staleRemoved: true },
			uninstall: { left: ['data'], data: 'user', outside: 'outside' },
		});
	} finally {
		await release?.();
		const target = path.resolve(temporary);
		assert.ok(target.startsWith(path.resolve(workspace) + path.sep) && path.basename(target).startsWith('ats-held-files-'));
		await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
