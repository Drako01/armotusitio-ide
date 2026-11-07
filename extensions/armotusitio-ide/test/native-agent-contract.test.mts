/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentContract, FILE_TOOLS_CONTRACT, plannerContract } from '../src/native-agent-contract.ts';
import { buildDirectInstruction, chatMessage } from '../src/native-chat.ts';
import { buildAgentInvocation } from '../src/native-agent-execution.ts';
import { parseRunBlock } from '../src/native-run-outcome.ts';
import { codexSandbox, useCodexSandbox } from '../src/native-codex-sandbox.ts';

test('every agent prompt carries the contract that matches its provider and role', () => {
	const writer = buildAgentInvocation({ schemaVersion: 1, provider: 'claude', role: 'implementer', projectRoot: '/repo', instruction: 'Escribí tests', readOnly: false, maxTurns: 50 });
	const reader = agentContract({ provider: 'codex', role: 'reviewer' });
	assert.deepEqual({
		cannotRun: writer.stdin.includes('You cannot run commands'), budget: writer.stdin.includes('at most 50 turns and 30 minutes'), noGit: writer.stdin.includes('open pull requests'),
		instructionLast: writer.stdin.endsWith('Escribí tests'), readerReadOnly: reader.includes('read-only') && !reader.includes('harness-blocked'),
		codexRuns: agentContract({ provider: 'codex', role: 'implementer' }).includes('run commands inside the project sandbox'),
		claudeRunner: agentContract({ provider: 'claude', role: 'implementer', runner: true }).includes('`run` tool of the `ats-runner` server')
	}, { cannotRun: true, budget: true, noGit: true, instructionLast: true, readerReadOnly: true, codexRuns: true, claudeRunner: true });
	// With the tool server, Claude gets only the IDE's MCP server and its tool; its own shell stays disallowed.
	const launch = { command: 'node', args: ['ats-runner.js', 'runner.json'], env: { ELECTRON_RUN_AS_NODE: '1' }, mcpConfigFile: '/storage/mcp.json' };
	const served = buildAgentInvocation({ schemaVersion: 1, provider: 'claude', role: 'implementer', projectRoot: '/repo', instruction: 'x', readOnly: false }, [], launch);
	const codex = buildAgentInvocation({ schemaVersion: 1, provider: 'codex', role: 'implementer', projectRoot: '/repo', instruction: 'x', readOnly: false }, [], launch);
	assert.deepEqual({
		mcp: served.args.slice(served.args.indexOf('--mcp-config'), served.args.indexOf('--mcp-config') + 3), tools: served.args[served.args.indexOf('--allowedTools') + 1], shell: served.args[served.args.indexOf('--disallowedTools') + 1],
		codex: codex.args.filter(arg => arg.startsWith('mcp_servers.')), reader: buildAgentInvocation({ schemaVersion: 1, provider: 'claude', role: 'planner', projectRoot: '/repo', instruction: 'x', readOnly: true }, [], launch).args.includes('--mcp-config')
	}, {
		mcp: ['--mcp-config', '/storage/mcp.json', '--strict-mcp-config'], tools: 'Read,Glob,Grep,Edit,Write,mcp__ats-runner', shell: 'Bash,WebFetch,WebSearch',
		codex: ['mcp_servers.ats-runner.default_tools_approval_mode="approve"', 'mcp_servers.ats-runner.tool_timeout_sec=2460', 'mcp_servers.ats-runner.command="node"', 'mcp_servers.ats-runner.args=["ats-runner.js","runner.json"]', 'mcp_servers.ats-runner.env={ELECTRON_RUN_AS_NODE="1"}'], reader: false
	});
	// The block format the contract teaches is exactly the one the outcome classifier reads.
	const taught = writer.stdin.split('\n').find(line => line.startsWith('harness-blocked:'))!;
	assert.equal(parseRunBlock(taught.replace('<what is missing, in the user\'s language>', 'Falta PostgreSQL').replace('service|credential|policy|decision|toolchain|disk', 'service'))?.needs, 'service');
});

test('the git tools are described only to writers that have them, and publishing stays forbidden', () => {
	const chatWriter = buildAgentInvocation({ schemaVersion: 1, provider: 'claude', role: 'implementer', projectRoot: '/repo', instruction: 'x', readOnly: false },
		[], { command: 'node', args: ['ats-runner.js', 'runner.json'], env: {}, mcpConfigFile: '/storage/mcp.json', git: true, files: true });
	const plain = agentContract({ provider: 'claude', role: 'implementer', runner: true });
	const planner = agentContract({ provider: 'claude', role: 'planner', runner: true, git: true });
	const direct = buildDirectInstruction([chatMessage('user', 'sube los cambios')]);
	assert.deepEqual({
		withTools: ['git_branch_create', 'git_commit', 'git_push', 'git_pr_upsert', 'publish packages'].every(text => chatWriter.stdin.includes(text)) && !chatWriter.stdin.includes('Never: modify git state (commit'),
		withoutTools: plain.includes('Never: modify git state (commit, branch, checkout, reset, stash, push'), readOnlyNever: planner.includes('git_commit'),
		direct: ['`git_branch_create`', '`git_commit`', '`git_push`', '`git_pr_upsert`', 'No force push', 'No force push', 'no release', 'A DENIED answer (the user said no) is final', 'may be corrected and called again'].every(text => direct.includes(text)),
		oldPhrase: direct.includes('You cannot commit, push or publish'),
		fileTools: chatWriter.stdin.includes(FILE_TOOLS_CONTRACT) && !plain.includes('delete_path') && !agentContract({ provider: 'claude', role: 'reviewer', files: true }).includes('delete_path'),
		recovery: plain.includes('fix the cause and run it again') && !planner.includes('fix the cause and run it again')
	}, { withTools: true, withoutTools: true, readOnlyNever: false, direct: true, oldPhrase: false, fileTools: true, recovery: true });
});


test('Codex full-access instructions match the invocation while readers and IDE permission boundaries remain explicit', () => {
	const previous = codexSandbox();
	try {
		for (const mode of ['workspace-write', 'danger-full-access']) {
			useCodexSandbox(mode);
			const writer = buildAgentInvocation({ schemaVersion: 1, provider: 'codex', role: 'implementer', projectRoot: '/repo', instruction: 'x', readOnly: false });
			const reader = buildAgentInvocation({ schemaVersion: 1, provider: 'codex', role: 'reviewer', projectRoot: '/repo', instruction: 'x', readOnly: true });
			assert.equal(writer.args[writer.args.indexOf('--sandbox') + 1], mode);
			assert.equal(writer.stdin.includes('run commands inside the project sandbox'), mode === 'workspace-write');
			assert.equal(writer.stdin.includes('its native shell has no OS-level confinement'), mode === 'danger-full-access');
			assert.equal(writer.stdin.includes('without network access'), false);
			assert.equal(reader.args[reader.args.indexOf('--sandbox') + 1], 'read-only');
			assert.equal(reader.stdin.includes('You cannot modify files or run commands'), true);
			assert.equal(reader.stdin.includes('danger-full-access'), false);
		}
		const full = agentContract({ provider: 'codex', role: 'implementer', runner: true, git: true });
		assert.equal(full.includes('IDE command permissions apply only to calls through ats-runner; a denied action remains denied'), true);
		assert.equal(full.includes('never substitute shell git or gh commands'), true);
		assert.equal(full.includes('A failed project script or generic runner error alone does not prove that its runtime is absent'), true);
		assert.equal(plannerContract().includes('without network'), false);
	} finally { useCodexSandbox(previous); }
});
