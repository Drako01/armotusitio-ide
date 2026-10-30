/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildOfflineSandboxArguments, offlineSandboxInvocation } from '../src/native-os-sandbox.ts';
import { validateNativePlan } from '../src/native-harness.ts';

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
