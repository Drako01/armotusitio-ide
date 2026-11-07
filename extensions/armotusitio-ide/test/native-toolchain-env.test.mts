/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildToolchainEnvironment, withNodeRuntime } from '../src/native-toolchain-env.ts';
import { buildAgentInvocation } from '../src/native-agent-execution.ts';
import { useCodexSandbox } from '../src/native-codex-sandbox.ts';

test('the agent environment keeps what toolchains need and never a credential', async () => {
	const source = {
		PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\dev', SystemRoot: 'C:\\Windows', GOFLAGS: '-mod=mod', XDG_CONFIG_HOME: 'C:\\cfg', ANTHROPIC_API_KEY: 'provider-auth',
		GITHUB_TOKEN: 'x', NPM_TOKEN: 'x', AWS_ACCESS_KEY_ID: 'x', AZURE_CLIENT_SECRET: 'x', GOOGLE_APPLICATION_CREDENTIALS: 'x', DATABASE_URL: 'x', STRIPE_SECRET: 'x', MY_PASSWORD: 'x',
		HTTPS_PROXY: 'http://user:pass@proxy:8080', GOPROXY: 'https://user:pass@goproxy.local', UNRELATED: 'x',
		AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1', AWS_SECRET_ACCESS_KEY: 'x', AWS_SESSION_TOKEN: 'x', KUBECONFIG: 'C:\\kube\\config', DOCKER_HOST: 'tcp://user:pass@host:2376'
	};
	const caches = new Set(['C:\\Users\\dev\\AppData\\Local\\go-build', 'C:\\Users\\dev\\go\\pkg\\mod']);
	const profile = await buildToolchainEnvironment(source, 'win32', async folder => caches.has(folder));
	assert.deepEqual({ env: profile.env, writableRoots: profile.writableRoots }, {
		env: {
			PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\dev', SystemRoot: 'C:\\Windows', GOFLAGS: '-mod=mod', XDG_CONFIG_HOME: 'C:\\cfg', ANTHROPIC_API_KEY: 'provider-auth',
			LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
			GIT_TERMINAL_PROMPT: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_manage_package_manager_versions: 'false', pnpm_config_manage_package_manager_versions: 'false',
			GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
			AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1', KUBECONFIG: 'C:\\kube\\config'
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

test('installed Go tools are visible without a shell profile while explicit PATH and GOBIN keep precedence', async () => {
	for (const platform of ['win32', 'linux'] as const) {
		const join = platform === 'win32' ? path.win32.join : path.posix.join;
		const home = platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
		const system = join(home, 'system');
		const bin = join(home, 'go', 'bin');
		const custom = join(home, 'custom-bin');
		const separator = platform === 'win32' ? ';' : ':';
		const exists = async (folder: string): Promise<boolean> => [bin, custom].includes(folder);
		const source = { PATH: system, USERPROFILE: home, HOME: home };
		assert.equal((await buildToolchainEnvironment(source, platform, exists)).env.PATH, system + separator + bin);
		assert.equal((await buildToolchainEnvironment({ ...source, GOBIN: custom }, platform, exists)).env.PATH, system + separator + custom);
		assert.equal((await buildToolchainEnvironment({ ...source, GOBIN: 'relative' }, platform, exists)).env.PATH, system);
		assert.equal((await buildToolchainEnvironment({ ...source, PATH: bin }, platform, exists)).env.PATH, bin);
		assert.equal(source.PATH, system);
	}
});

test('PATH names the real folder of a linked toolchain such as the nvm-windows symlink', async () => {
	const links = new Map([['C:\nvm4w\nodejs', 'C:\Users\dev\AppData\Local\nvm\v24.22.1']]);
	const profile = await buildToolchainEnvironment({ PATH: 'C:\nvm4w\nodejs;C:\bin', USERPROFILE: 'C:\Users\dev' }, 'win32', async () => false, async folder => links.get(folder) ?? folder);
	assert.equal(profile.env.PATH, 'C:\Users\dev\AppData\Local\nvm\v24.22.1;C:\bin');
});

test('Windows environment keys are case insensitive and PATH has one canonical spelling', async () => {
	const profile = await buildToolchainEnvironment({ pAtH: 'C:\\tools', userprofile: 'C:\\Users\\dev', nvm_symlink: 'C:\\node' }, 'win32', async () => false);
	assert.deepEqual({ path: profile.env.PATH, duplicate: profile.env.Path, home: profile.env.USERPROFILE, nvm: profile.env.NVM_SYMLINK },
		{ path: 'C:\\tools', duplicate: undefined, home: 'C:\\Users\\dev', nvm: 'C:\\node' });
});

test('the Node directory is exposed to package-script children even when the GUI PATH omitted it', { skip: process.platform !== 'win32' }, async () => {
	const executable = await fs.realpath(process.execPath);
	const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
	const source = { Path: system, NVM_SYMLINK: path.dirname(executable) };
	const env = await withNodeRuntime(source, { execPath: path.join(system, 'editor.exe'), electron: true });
	assert.deepEqual({ first: env.PATH?.split(path.delimiter)[0], node: env.PATH?.split(path.delimiter).includes(path.dirname(executable)), duplicate: env.Path, original: source.Path },
		{ first: path.dirname(executable), node: true, duplicate: undefined, original: system });
});

test('Codex full access drops the sandbox and the extra folders, only for writers', () => {
	const base = { schemaVersion: 1 as const, provider: 'codex' as const, projectRoot: '/repo', instruction: 'x' };
	useCodexSandbox('danger-full-access');
	try {
		const sandboxOf = (args: string[]) => args[args.indexOf('--sandbox') + 1];
		const writer = buildAgentInvocation({ ...base, role: 'implementer', readOnly: false }, ['/home/dev/go/pkg/mod']);
		const reader = buildAgentInvocation({ ...base, role: 'planner', readOnly: true }, ['/home/dev/go/pkg/mod']);
		assert.deepEqual({ writer: sandboxOf(writer.args), writerDirs: writer.args.includes('--add-dir'), reader: sandboxOf(reader.args) }, { writer: 'danger-full-access', writerDirs: false, reader: 'read-only' });
	} finally { useCodexSandbox('workspace-write'); }
});
