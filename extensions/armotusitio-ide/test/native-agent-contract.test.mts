/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentContract } from '../src/native-agent-contract.ts';
import { buildAgentInvocation } from '../src/native-agent-execution.ts';
import { parseRunBlock } from '../src/native-run-outcome.ts';

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
		codex: ['mcp_servers.ats-runner.command="node"', 'mcp_servers.ats-runner.args=["ats-runner.js","runner.json"]', 'mcp_servers.ats-runner.env={ELECTRON_RUN_AS_NODE="1"}'], reader: false
	});
	// The block format the contract teaches is exactly the one the outcome classifier reads.
	const taught = writer.stdin.split('\n').find(line => line.startsWith('harness-blocked:'))!;
	assert.equal(parseRunBlock(taught.replace('<what is missing, in the user\'s language>', 'Falta PostgreSQL').replace('service|credential|policy|decision|toolchain|disk', 'service'))?.needs, 'service');
});
