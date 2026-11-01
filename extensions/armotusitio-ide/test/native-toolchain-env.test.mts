/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolchainEnvironment } from '../src/native-toolchain-env.ts';
import { buildAgentInvocation } from '../src/native-agent-execution.ts';

test('the agent environment keeps what toolchains need and never a credential', async () => {
	const source = {
		PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\dev', SystemRoot: 'C:\\Windows', GOFLAGS: '-mod=mod', XDG_CONFIG_HOME: 'C:\\cfg', ANTHROPIC_API_KEY: 'provider-auth',
		GITHUB_TOKEN: 'x', NPM_TOKEN: 'x', AWS_ACCESS_KEY_ID: 'x', AZURE_CLIENT_SECRET: 'x', GOOGLE_APPLICATION_CREDENTIALS: 'x', DATABASE_URL: 'x', STRIPE_SECRET: 'x', MY_PASSWORD: 'x',
		HTTPS_PROXY: 'http://user:pass@proxy:8080', GOPROXY: 'https://user:pass@goproxy.local', UNRELATED: 'x'
	};
	const caches = new Set(['C:\\Users\\dev\\AppData\\Local\\go-build', 'C:\\Users\\dev\\go\\pkg\\mod']);
	const profile = await buildToolchainEnvironment(source, 'win32', async folder => caches.has(folder));
	assert.deepEqual({ env: profile.env, writableRoots: profile.writableRoots }, {
		env: {
			PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\dev', SystemRoot: 'C:\\Windows', GOFLAGS: '-mod=mod', XDG_CONFIG_HOME: 'C:\\cfg', ANTHROPIC_API_KEY: 'provider-auth',
			LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming'
		},
		writableRoots: ['C:\\Users\\dev\\AppData\\Local\\go-build', 'C:\\Users\\dev\\go\\pkg\\mod']
	});
});

test('only a Codex writer gets the toolchain caches as extra writable folders', () => {
	const base = { schemaVersion: 1 as const, provider: 'codex' as const, projectRoot: '/repo', instruction: 'x' };
	const writer = buildAgentInvocation({ ...base, role: 'implementer', readOnly: false }, ['/home/dev/go/pkg/mod']);
	const reader = buildAgentInvocation({ ...base, role: 'reviewer', readOnly: true }, ['/home/dev/go/pkg/mod']);
	assert.deepEqual({ writer: writer.args.slice(writer.args.indexOf('--add-dir'), writer.args.indexOf('--add-dir') + 2), reader: reader.args.includes('--add-dir') },
		{ writer: ['--add-dir', '/home/dev/go/pkg/mod'], reader: false });
});
