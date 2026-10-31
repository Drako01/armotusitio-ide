/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeAgentIsolation, meetsWriterIsolation, parseWriterIsolation } from '../src/native-isolation.ts';

test('isolation claims never exceed what was demonstrated and unknown requirements fail closed', () => {
	assert.deepEqual({
		codex: describeAgentIsolation('codex'), claude: describeAgentIsolation('claude'),
		codexAtDefault: meetsWriterIsolation('codex', 'tool-allowlist'), claudeAtDefault: meetsWriterIsolation('claude', 'tool-allowlist'),
		codexNeedsSandbox: meetsWriterIsolation('codex', 'provider-sandbox'), claudeNeedsSandbox: meetsWriterIsolation('claude', 'provider-sandbox'),
		// No model provider runs under a kernel policy applied by the IDE, so requiring it blocks every writer.
		kernelCodex: meetsWriterIsolation('codex', 'os-kernel'), kernelClaude: meetsWriterIsolation('claude', 'os-kernel'),
		parsed: [parseWriterIsolation('provider-sandbox'), parseWriterIsolation(undefined), parseWriterIsolation('none'), parseWriterIsolation('../os-kernel')]
	}, {
		codex: { writes: 'provider-sandbox', reads: 'none' }, claude: { writes: 'tool-allowlist', reads: 'tool-allowlist' },
		codexAtDefault: true, claudeAtDefault: true, codexNeedsSandbox: true, claudeNeedsSandbox: false, kernelCodex: false, kernelClaude: false,
		parsed: ['provider-sandbox', 'os-kernel', 'os-kernel', 'os-kernel']
	});
});

/**
 * Adversarial measurement of the provider's own operating system sandbox, with no model call and no quota.
 * Opt-in because it needs the Codex CLI: set ATS_REAL_SANDBOX=1. The expectations are the measured behaviour
 * the isolation claims above rely on, including the reads that are NOT confined.
 */
test('Codex sandbox denies writes outside the workspace and does not confine reads (measured, no model call)', { skip: process.env.ATS_REAL_SANDBOX === '1' && process.platform === 'win32' ? false : 'set ATS_REAL_SANDBOX=1 on Windows with the Codex CLI' }, async () => {
	// The workspace and the outside directory are siblings under the user's home: the temp directory is writable by design.
	const base = await fs.mkdtemp(path.join(os.homedir(), 'ats-sandbox-probe-'));
	const workspace = path.join(base, 'workspace');
	const outside = path.join(base, 'outside');
	await fs.mkdir(workspace); await fs.mkdir(outside);
	try {
		await fs.writeFile(path.join(outside, 'secret.txt'), 'synthetic secret');
		const probe = [
			'const fs = require("fs");',
			'const attempt = (name, fn) => { try { fn(); console.log(name + ":allowed"); } catch (error) { console.log(name + ":denied"); } };',
			'attempt("write-inside", () => fs.writeFileSync("inside.txt", "x"));',
			`attempt("write-outside", () => fs.writeFileSync(${JSON.stringify(path.join(outside, 'written.txt').replace(/\\/g, '/'))}, "x"));`,
			`attempt("read-outside", () => fs.readFileSync(${JSON.stringify(path.join(outside, 'secret.txt').replace(/\\/g, '/'))}));`
		].join('\n');
		await fs.writeFile(path.join(workspace, 'probe.js'), probe);
		const run = (profile: string): string[] => spawnSync('codex', ['sandbox', '-P', profile, '-C', workspace, '--', process.execPath, 'probe.js'], { encoding: 'utf8', shell: true }).stdout.split(/\r?\n/).filter(Boolean);
		assert.deepEqual({ workspaceWrite: run(':workspace'), readOnly: run(':read-only') }, {
			workspaceWrite: ['write-inside:allowed', 'write-outside:denied', 'read-outside:allowed'],
			readOnly: ['write-inside:denied', 'write-outside:denied', 'read-outside:allowed']
		});
	} finally { await fs.rm(base, { recursive: true, force: true }); }
});
