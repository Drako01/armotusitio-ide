/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Protocol-faithful fake providers for the native runtime (r8). They run as real child processes and speak the same wire
 * protocols as the installed CLIs (Codex app-server JSON-RPC, Claude stream-json + MCP permission prompts), with fault
 * injection by keyword. They verify the IDE's side of the contracts; they are never counted as real-provider E2E.
 *
 * Turn keywords: RUN <cmd> (command needing approval), HUMAN <cmd> (same, as a `humanCommand` approval), ASK (question),
 * SLOW (3 s stream), FLOOD <n> (n deltas), CHILD <n> (n child agents spawned; with NESTED, by a child thread), CRASH (exit
 * mid-turn), GARBAGE (malformed line), APPROVE_WAIT (approval that waits forever), FAIL <codexErrorInfo> (typed turn
 * failure). State lives in FAKE_STATE_DIR:
 * sessions.json (history per native id, so resume proves continuity) and executions.log (one line per executed command).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const COMMON = String.raw`
const fs = require('fs'), path = require('path');
const state = process.env.FAKE_STATE_DIR;
const sessionsFile = path.join(state, 'sessions.json');
const loadSessions = () => { try { return JSON.parse(fs.readFileSync(sessionsFile, 'utf8')); } catch { return {}; } };
const saveSessions = value => fs.writeFileSync(sessionsFile, JSON.stringify(value));
const executed = command => fs.appendFileSync(path.join(state, 'executions.log'), command + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const once = name => { const file = path.join(state, name); if (fs.existsSync(file)) { return false; } fs.writeFileSync(file, '1'); return true; };
fs.appendFileSync(path.join(state, 'pids.log'), process.pid + '\n');
`;

/** `codex app-server` over stdio, JSON-RPC without the jsonrpc field, like the real one. */
export const FAKE_CODEX = String.raw`if (process.argv.includes('--version')) { console.log('codex-cli ' + (process.env.FAKE_VERSION || '0.166.0')); process.exit(0); }` + COMMON + String.raw`
const readline = require('readline');
const crypto = require('crypto');
const write = message => process.stdout.write(JSON.stringify(message) + '\n');
let nextId = 1000; const waiting = new Map();
const request = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); write({ id, method, params }); });
let thread, turn, interrupted = false;
fs.writeFileSync(path.join(state, 'argv.json'), JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_HANDSHAKE === 'die-once' && once('died-once')) { process.exit(1); }
const handlers = {
	initialize: () => process.env.FAKE_HANDSHAKE === 'hang' ? new Promise(() => {}) : { userAgent: 'fake/0.166.0', codexHome: state, platformFamily: 'windows', platformOs: 'windows' },
	'thread/start': params => { thread = crypto.randomUUID(); const all = loadSessions(); all[thread] = { messages: [], cwd: params.cwd, sandbox: params.sandbox, approvalPolicy: params.approvalPolicy }; saveSessions(all); return { thread: { id: thread }, model: 'fake-model' }; },
	'thread/resume': params => { const all = loadSessions(); if (!all[params.threadId]) { throw { code: -32600, message: 'thread not found: ' + params.threadId }; } thread = params.threadId; return { thread: { id: thread }, model: 'fake-model' }; },
	'thread/fork': params => { const all = loadSessions(); if (!all[params.threadId]) { throw { code: -32600, message: 'thread not found' }; } thread = crypto.randomUUID(); all[thread] = { messages: [...all[params.threadId].messages] }; saveSessions(all); return { thread: { id: thread }, model: 'fake-model' }; },
	'turn/start': params => { turn = 't-' + crypto.randomUUID(); interrupted = false; setImmediate(() => runTurn(turn, params)); return { turn: { id: turn, items: [], status: 'inProgress' } }; },
	'turn/interrupt': () => { interrupted = true; return {}; },
	'turn/steer': params => { const all = loadSessions(); all[thread].messages.push('steer:' + params.input[0].text); saveSessions(all); return { turnId: turn }; }
};
async function runTurn(id, params) {
	const text = params.input[0].text;
	const all = loadSessions();
	const previous = all[thread].messages.at(-1);
	write({ method: 'turn/started', params: { threadId: thread, turn: { id } , turnId: id } });
	let answer = 'Echo: ' + text + (previous ? ' | prev=' + previous : '') + (process.env.CODEX_HOME ? ' | cfg=' + process.env.CODEX_HOME : '');
	if (text.includes('INSPECT_IMAGE')) { answer += ' | images=' + params.input.filter(item => item.type === 'image' && item.url.startsWith('data:image/png;base64,')).length; }
	const delta = piece => write({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: id, itemId: 'msg-' + id, delta: piece } });
	if (text.includes('GARBAGE')) { process.stdout.write('this is not json\n'); }
	const flood = /FLOOD (\d+)/.exec(text);
	if (flood) { for (let i = 0; i < Number(flood[1]); i++) { delta('d' + i + ' '); } }
	if (text.includes('SLOW')) { for (let i = 0; i < 30 && !interrupted; i++) { delta('.'); await sleep(100); } }
	const children = /CHILD (\d+)/.exec(text);
	if (children) {
		const sender = text.includes('NESTED') ? 'child-thread' : thread;
		for (let i = 0; i < Number(children[1]); i++) { write({ method: 'item/started', params: { threadId: sender, turnId: id, item: { type: 'collabAgentToolCall', id: 'child-' + i, tool: 'spawnAgent', status: 'inProgress', senderThreadId: sender, receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null, agentsStates: {} } } }); }
		await sleep(100);
	}
	if (text.includes('CRASH')) { delta('partial'); await sleep(50); process.exit(3); }
	const failure = /FAIL (\w+)$/m.exec(text);
	if (failure) {
		write({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: 'failed', items: [], error: { message: 'provider said ' + failure[1], codexErrorInfo: failure[1], additionalDetails: null, misalignment: null } } } });
		return;
	}
	const run = /(RUN|HUMAN) (.+)$/m.exec(text);
	if (run || text.includes('APPROVE_WAIT')) {
		const command = run ? run[2].trim() : 'pnpm wait';
		write({ method: 'item/started', params: { threadId: thread, turnId: id, item: { type: 'commandExecution', id: 'cmd-' + id, command, cwd: params.cwd ?? '.', status: 'inProgress' } } });
		const response = await request('item/commandExecution/requestApproval', { threadId: thread, turnId: id, itemId: 'cmd-' + id, command, cwd: '.', kind: run?.[1] === 'HUMAN' ? 'humanCommand' : 'command', startedAtMs: Date.now(), environmentId: null });
		const accepted = response.decision === 'accept' || response.decision === 'acceptForSession';
		if (accepted) { executed(command); write({ method: 'item/commandExecution/outputDelta', params: { threadId: thread, turnId: id, itemId: 'cmd-' + id, delta: 'ran ' + command + '\n' } }); }
		write({ method: 'item/completed', params: { threadId: thread, turnId: id, item: { type: 'commandExecution', id: 'cmd-' + id, command, status: accepted ? 'completed' : 'declined', exitCode: accepted ? 0 : null } } });
		answer += accepted ? ' | executed=' + command + ' decision=' + response.decision : ' | declined=' + command;
	}
	if (text.includes('ASK')) {
		const response = await request('item/tool/requestUserInput', { threadId: thread, turnId: id, itemId: 'q-' + id, isBlocking: true, autoResolutionMs: null, questions: [{ id: 'color', header: 'Color', question: 'Which color?', isOther: true, isSecret: false, options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: 'cold' }] }] });
		answer += ' | answer=' + JSON.stringify(response.answers);
	}
	if (interrupted) {
		write({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: 'interrupted', items: [], error: null } } });
		return;
	}
	delta(answer);
	write({ method: 'item/completed', params: { threadId: thread, turnId: id, item: { type: 'agentMessage', id: 'msg-' + id, text: answer } } });
	write({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: id, tokenUsage: { last: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 }, total: {}, modelContextWindow: null } } });
	const latest = loadSessions(); latest[thread].messages.push(text.slice(0, 80)); saveSessions(latest);
	write({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: 'completed', items: [], error: null } } });
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
	const message = JSON.parse(line);
	if (message.method && message.id !== undefined) {
		try { write({ id: message.id, result: await (handlers[message.method] ?? (() => { throw { code: -32601, message: 'unknown method' }; }))(message.params) }); }
		catch (error) { write({ id: message.id, error: { code: error.code ?? -32603, message: error.message ?? 'failed' } }); }
	} else if (message.id !== undefined && waiting.has(message.id)) { waiting.get(message.id)(message.result); waiting.delete(message.id); }
});
`;

/** `claude --print --input-format stream-json`: one process, several turns; permission prompts through the MCP approve tool. */
export const FAKE_CLAUDE = String.raw`if (process.argv.includes('--version')) { console.log((process.env.FAKE_VERSION || '2.1.316') + ' (Claude Code)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log((process.env.FAKE_HELP || '--input-format --session-id --resume --fork-session --permission-prompt-tool --permission-prompts --include-partial-messages')); process.exit(0); }` + COMMON + String.raw`
const readline = require('readline');
const { spawn } = require('child_process');
if (process.env.FAKE_HANDSHAKE === 'die-once' && once('died-once')) { process.exit(1); }
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
let session = flag('--session-id') ?? flag('--resume');
const all = loadSessions();
if (flag('--resume') && !all[flag('--resume')]) { process.stderr.write('No conversation found with session ID: ' + flag('--resume') + '\n'); process.exit(1); }
if (args.includes('--fork-session')) { const source = session; session = require('crypto').randomUUID(); all[session] = { messages: [...all[source].messages] }; }
all[session] ??= { messages: [] };
all[session].mode = flag('--permission-mode');
saveSessions(all);
const write = message => process.stdout.write(JSON.stringify(message) + '\n');
let mcp;
async function approve(toolName, input) {
	if (!mcp) {
		const configFile = flag('--mcp-config');
		if (!configFile) { return { behavior: 'deny', message: 'no prompt tool' }; }
		const server = JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers['ats-runner'];
		const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
		const pending = new Map(); let id = 0;
		readline.createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message.result); pending.delete(message.id); });
		mcp = (method, params) => new Promise(resolve => { const key = ++id; pending.set(key, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n'); });
		await mcp('initialize', { protocolVersion: '2025-06-18' });
	}
	const result = await mcp('tools/call', { name: 'approve', arguments: { tool_name: toolName, input } });
	return JSON.parse(result.content[0].text);
}
let busy = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', line => { busy = busy.then(() => turn(JSON.parse(line))); });
async function turn(message) {
	const text = message.message.content[0].text;
	const sessions = loadSessions();
	const previous = sessions[session].messages.at(-1);
	write({ type: 'system', subtype: 'init', session_id: session, tools: [], model: 'fake' });
	write({ type: 'stream_event', event: { type: 'message_start' }, session_id: session });
	const delta = piece => write({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } }, session_id: session });
	let answer = 'Echo: ' + text + (previous ? ' | prev=' + previous : '') + ' | mode=' + sessions[session].mode + (process.env.CLAUDE_CONFIG_DIR ? ' | cfg=' + process.env.CLAUDE_CONFIG_DIR : '');
	if (text.includes('INSPECT_IMAGE')) { answer += ' | images=' + message.message.content.filter(item => item.type === 'image' && item.source?.type === 'base64' && item.source.media_type === 'image/png').length; }
	if (text.includes('GARBAGE')) { process.stdout.write('this is not json\n'); }
	const flood = /FLOOD (\d+)/.exec(text);
	if (flood) { for (let i = 0; i < Number(flood[1]); i++) { delta('d' + i + ' '); } }
	if (text.includes('SLOW')) { for (let i = 0; i < 30; i++) { delta('.'); await sleep(100); } }
	if (text.includes('CRASH')) { delta('partial'); await sleep(50); process.exit(3); }
	const run = /RUN (.+)$/m.exec(text);
	if (run || text.includes('APPROVE_WAIT')) {
		const command = run ? run[1].trim() : 'pnpm wait';
		write({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-' + Date.now(), name: 'Bash', input: { command } }] }, session_id: session });
		const decision = await approve('Bash', { command });
		if (decision.behavior === 'allow') { executed(command); }
		write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: decision.behavior === 'allow' ? 'ok' : decision.message, is_error: decision.behavior !== 'allow' }] }, session_id: session });
		answer += decision.behavior === 'allow' ? ' | executed=' + command : ' | declined=' + command + ' (' + decision.message.split('\n')[0] + ')';
	}
	if (text.includes('ASK')) {
		const decision = await approve('AskUserQuestion', { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'red', description: 'warm' }, { label: 'blue', description: 'cold' }] }] });
		answer += ' | answer=' + JSON.stringify(decision.behavior === 'allow' ? decision.updatedInput.answers : decision.message);
	}
	delta(answer);
	write({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] }, session_id: session });
	const latest = loadSessions(); latest[session].messages.push(text.slice(0, 80)); saveSessions(latest);
	write({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session, usage: { input_tokens: 10, output_tokens: 5 } });
}
`;

/** Installs a fake CLI where `resolveNativeCommand` finds it (Windows npm layout, or an executable elsewhere). */
export async function installFakeCli(bin: string, executable: 'codex' | 'claude', source: string): Promise<void> {
	if (process.platform === 'win32') {
		const entry = executable === 'codex' ? path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
		await fs.mkdir(path.dirname(entry), { recursive: true });
		await fs.writeFile(entry, source);
		return;
	}
	await fs.mkdir(bin, { recursive: true });
	const file = path.join(bin, executable);
	await fs.writeFile(file, '#!/usr/bin/env node\n' + source, { mode: 0o755 });
}
