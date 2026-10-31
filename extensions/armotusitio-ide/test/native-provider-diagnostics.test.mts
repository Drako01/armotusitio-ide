/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { installFakeCodex } from './native-fake-provider.mts';
import { diagnoseProvider, inspectProviderHelp, parseLocalAuthStatus } from '../src/native-provider-diagnostics.ts';

test('provider diagnostics reject unknown hosts without invoking any model', async () => {
	await assert.rejects(diagnoseProvider('unknown' as unknown as Parameters<typeof diagnoseProvider>[0]), /HARNESS_PROVIDER_UNSUPPORTED/);
});

test('diagnostics report availability but never imply authentication', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-provider-diagnostic-'));
	const oldPath = process.env.PATH;
	try {
		await installFakeCodex(root, '#!/usr/bin/env node\nconsole.log("codex-cli 1.2.3");\n');
		process.env.PATH = root + path.delimiter + (oldPath || '');
		const result = await diagnoseProvider('codex');
		assert.equal(result.installed, true);
		assert.equal(result.version, '1.2.3');
		assert.equal(result.protocolVerified, false);
		assert.equal(result.modelAuthenticated, false);
	} finally {
		if (oldPath === undefined) { delete process.env.PATH; } else { process.env.PATH = oldPath; }
		await fs.rm(root, { recursive: true, force: true });
	}
});

test('CLI flag matrix rejects unknown versions of the invocation protocol', () => {
	const codex = ['--sandbox', '--skip-git-repo-check', '--ask-for-approval', '--ephemeral', '--json', '--model'].join(' ');
	const claude = ['--permission-mode', '--allowedTools', '--disallowedTools', '--max-turns', '--output-format', '--verbose', '--model'].join(' ');
	assert.equal(inspectProviderHelp('codex', 'Usage: codex exec ' + codex).compatibility, 'verified');
	assert.equal(inspectProviderHelp('claude', 'Usage: claude ' + claude).compatibility, 'verified');
	assert.deepEqual(inspectProviderHelp('codex', 'Usage: codex exec --json and no safety flags').missingFlags, ['--sandbox', '--skip-git-repo-check', '--ask-for-approval', '--ephemeral', '--model']);
	assert.equal(inspectProviderHelp('claude', '').compatibility, 'unknown');
	// Real CLIs: Claude hides --max-turns from help, and Codex lists --ask-for-approval only in top-level help.
	assert.equal(inspectProviderHelp('claude', 'Usage: claude ' + claude.replace('--max-turns', '')).compatibility, 'verified');
	const codexTopLevel = 'Usage: codex [OPTIONS] [PROMPT]\n  -a, --ask-for-approval <POLICY>';
	const codexExec = 'Usage: codex exec [OPTIONS]\n  --model --sandbox --skip-git-repo-check --ephemeral --json';
	assert.equal(inspectProviderHelp('codex', codexExec).compatibility, 'unsupported');
	assert.equal(inspectProviderHelp('codex', codexTopLevel + '\n' + codexExec).compatibility, 'verified');
});

test('local auth detection never promotes ambiguous output to authenticated model access', () => {
	assert.equal(parseLocalAuthStatus('codex', 'Logged in using ChatGPT', 0), 'authenticated');
	assert.equal(parseLocalAuthStatus('codex', 'Not logged in', 0), 'unauthenticated');
	assert.equal(parseLocalAuthStatus('codex', 'Logged in using ChatGPT', 1), 'unknown');
	assert.equal(parseLocalAuthStatus('claude', '{"loggedIn":true}', 0), 'authenticated');
	assert.equal(parseLocalAuthStatus('claude', '{"loggedIn":false}', 0), 'unauthenticated');
	assert.equal(parseLocalAuthStatus('claude', '{"loggedIn":true}', 1), 'unknown');
	assert.equal(parseLocalAuthStatus('claude', 'Welcome! Account: private@example.test', 0), 'unknown');
});
