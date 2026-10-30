/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { buildOfflineSandboxArguments, offlineSandboxInvocation } from '../src/native-os-sandbox.ts';
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
			schemaVersion: 1, gates: [{ id: 'isolate', executable: 'node',
				args: ['-e', 'process.exit(0)'], sandbox: 'linux-offline-readonly' }]
		});
		const result = await engine.execute(gate.id, await engine.reviewDigest(gate.plan), () => true);
		assert.equal(result.attempts.at(-1)?.status, 'failed');
		assert.equal(result.attempts.at(-1)?.results[0].output, 'HARNESS_OS_SANDBOX_UNAVAILABLE');
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
