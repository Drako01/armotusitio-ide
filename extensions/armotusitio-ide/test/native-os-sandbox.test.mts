/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import {
	buildOfflineSandboxArguments, buildDarwinSandboxArguments, buildDarwinSandboxProfile, offlineSandboxInvocation
} from '../src/native-os-sandbox.ts';
import { NativeHarness, validateNativePlan } from '../src/native-harness.ts';

test('offline Linux sandbox forbids network and exposing host home', () => {
	const args = buildOfflineSandboxArguments('/project', '/usr/bin/git', ['status', '--short'], 'linux');
	assert.ok(args.includes('--unshare-all'));
	assert.ok(args.includes('--clearenv'));
	assert.ok(args.includes('--ro-bind'));
	assert.ok(args.includes('/workspace'));
	assert.ok(!args.includes('/home'));
	assert.ok(!args.includes('--bind'));
	assert.deepEqual(args.slice(-3), ['/usr/bin/git', 'status', '--short']);
});

test('unsupported OS and executable paths fail closed before running a gate', async () => {
	assert.throws(() => buildOfflineSandboxArguments('/project', '/usr/bin/git', [], 'win32'),
		/HARNESS_OS_SANDBOX_UNAVAILABLE/);
	assert.throws(() => buildOfflineSandboxArguments('/project', '/tmp/untrusted', [], 'linux'),
		/HARNESS_OS_SANDBOX_COMMAND_INVALID/);
	if (process.platform !== 'linux') {
		await assert.rejects(offlineSandboxInvocation(path.resolve('.'), '/usr/bin/git', []),
			/HARNESS_OS_SANDBOX_UNAVAILABLE/);
	}
	const malformed = JSON.parse('{"schemaVersion":1,"gates":[{"id":"unsafe","executable":"node","args":[],"sandbox":"unknown"}]}');
	assert.throws(() => validateNativePlan(malformed), /HARNESS_INVALID_SANDBOX_POLICY/);
});

test('an offline sandbox gate fails closed on unsupported hosts instead of running unsandboxed', async () => {
	if (process.platform === 'linux') { return; }
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-gate-os-'));
	try {
		const engine = new NativeHarness(await fs.realpath(root), path.join(root, 'state'));
		const gate = await engine.create('Isolated check', {
			schemaVersion: 1, gates: [{
				id: 'isolate', executable: 'node',
				args: ['-e', 'process.exit(0)'], sandbox: 'linux-offline-readonly'
			}]
		});
		const result = await engine.execute(gate.id, await engine.reviewDigest(gate.plan), () => true);
		assert.equal(result.attempts.at(-1)?.status, 'failed');
		assert.equal(result.attempts.at(-1)?.results[0].output, 'HARNESS_OS_SANDBOX_UNAVAILABLE');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('macOS Seatbelt policy denies by default, blocks network and limits writes to private scratch', () => {
	const profile = buildDarwinSandboxProfile('/Users/dev/my "quoted" project', '/private/var/folders/x/ats-sandbox-1');
	const lines = profile.split('\n');
	assert.deepEqual({
		first: lines.slice(0, 2), last: lines.at(-1),
		writes: lines.filter(line => line.startsWith('(allow file-write')),
		escapedRoot: profile.includes('(subpath "/Users/dev/my \\"quoted\\" project")'),
		networkAllowed: lines.some(line => line.startsWith('(allow network')),
		homeReadable: profile.includes('"/Users"')
	}, {
		first: ['(version 1)', '(deny default)'], last: '(deny network*)',
		writes: ['(allow file-write* (literal "/dev/null") (literal "/dev/zero") (subpath "/private/var/folders/x/ats-sandbox-1"))'],
		escapedRoot: true, networkAllowed: false, homeReadable: false
	});
	assert.throws(() => buildDarwinSandboxProfile('/project\n(allow default)', '/tmp/s'), /HARNESS_OS_SANDBOX_COMMAND_INVALID/);
	assert.throws(() => buildDarwinSandboxProfile('relative', '/tmp/s'), /HARNESS_OS_SANDBOX_COMMAND_INVALID/);
	assert.deepEqual(buildDarwinSandboxArguments('/project', '/tmp/s', '/usr/bin/git', ['status'], 'darwin').slice(-3), ['--', '/usr/bin/git', 'status']);
	assert.throws(() => buildDarwinSandboxArguments('/project', '/tmp/s', '/Users/dev/bin/tool', [], 'darwin'), /HARNESS_OS_SANDBOX_COMMAND_INVALID/);
	assert.throws(() => buildDarwinSandboxArguments('/project', '/tmp/s', '/usr/bin/git', [], 'win32'), /HARNESS_OS_SANDBOX_UNAVAILABLE/);
});

test('portable policy selects a host backend and never runs unsandboxed on Windows', async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sandbox-policy-')));
	try {
		await assert.rejects(offlineSandboxInvocation(root, '/usr/bin/git', [], 'offline-readonly', 'win32'), /HARNESS_OS_SANDBOX_UNAVAILABLE/);
		// The legacy Linux policy keeps its meaning on macOS.
		await assert.rejects(offlineSandboxInvocation(root, '/usr/bin/git', [], 'linux-offline-readonly', 'darwin'), /HARNESS_OS_SANDBOX_UNAVAILABLE/);
		await assert.rejects(offlineSandboxInvocation(root, '/usr/bin/git', [], JSON.parse('"unknown"'), 'linux'), /HARNESS_INVALID_SANDBOX_POLICY/);
		assert.equal(validateNativePlan({ schemaVersion: 1, gates: [{ id: 'portable', executable: 'node', args: [], sandbox: 'offline-readonly' }] }), undefined);
		if (process.platform === 'win32') {
			const engine = new NativeHarness(root, path.join(root, 'state'));
			const task = await engine.create('Portable isolated check', { schemaVersion: 1, gates: [{ id: 'isolate', executable: 'node', args: ['-e', 'process.exit(0)'], sandbox: 'offline-readonly' }] });
			const result = await engine.execute(task.id, await engine.reviewDigest(task.plan), () => true);
			assert.deepEqual({ status: result.attempts.at(-1)?.status, output: result.attempts.at(-1)?.results[0].output },
				{ status: 'failed', output: 'HARNESS_OS_SANDBOX_UNAVAILABLE' });
		}
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

const kernelSandbox = (process.platform === 'linux' && (existsSync('/usr/bin/bwrap') || existsSync('/bin/bwrap'))) ||
	(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'));
test('kernel-enforced sandbox lets a gate read the workspace but denies writes into it', { skip: kernelSandbox ? false : 'requires Linux bubblewrap or macOS sandbox-exec' }, async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sandbox-enforce-')));
	const state = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-sandbox-enforce-state-'));
	try {
		await fs.writeFile(path.join(root, 'input.txt'), 'visible' + String.fromCharCode(10));
		const engine = new NativeHarness(root, state);
		// Merged-/usr Linux exposes /bin as a symlink, which the sandbox rejects by design.
		// Gates name bare executables and the sandbox accepts only a real file: Debian and Ubuntu ship `sh` as a symlink to dash,
		// and recent Ubuntu ships coreutils as symlinks, so both gates use the shell and its builtins.
		const shell = path.basename(await fs.realpath((process.platform === 'darwin' ? '/bin' : '/usr/bin') + '/sh'));
		const task = await engine.create('Enforced sandbox', {
			schemaVersion: 1, gates: [
				{ id: 'read', executable: shell, args: ['-c', 'read line < input.txt && test "$line" = visible'], sandbox: 'offline-readonly' },
				{ id: 'write', executable: shell, args: ['-c', 'echo escaped > written.txt'], sandbox: 'offline-readonly', dependsOn: ['read'] }
			]
		});
		const result = await engine.execute(task.id, await engine.reviewDigest(task.plan), () => true);
		const results = result.attempts.at(-1)!.results;
		const gates = results.map(gate => ({ id: gate.id, status: gate.status }));
		assert.deepEqual({ gates, written: existsSync(path.join(root, 'written.txt')) },
			{ gates: [{ id: 'read', status: 'passed' }, { id: 'write', status: 'failed' }], written: false });
		// The write must fail because the kernel denied it, not because the sandbox was unavailable.
		assert.doesNotMatch(JSON.stringify(results.at(-1)), /HARNESS_OS_SANDBOX_UNAVAILABLE|HARNESS_EXECUTABLE_UNAVAILABLE/);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(state, { recursive: true, force: true });
	}
});
