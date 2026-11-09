/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTerminalOutput, type ShellExecutionLike } from '../src/native-terminal-capture.ts';

function execution(commandLine: string, chunks: string[], fail = false): ShellExecutionLike {
	return { commandLine: { value: commandLine }, async *read() { for (const chunk of chunks) { yield chunk; } if (fail) { throw Error('terminal closed'); } } };
}

test('the last finished terminal command is kept with its command line, bounded, and a failed read keeps the previous one', async () => {
	let listener: ((event: { execution: ShellExecutionLike }) => void) | undefined;
	let disposed = false;
	const capture = captureTerminalOutput({ onDidStartTerminalShellExecution: next => { listener = next; return { dispose: () => { disposed = true; } }; } });
	const nothing = capture.latest();
	listener!({ execution: execution('pnpm test', ['running\n', 'ok\n']) });
	await new Promise(resolve => setTimeout(resolve, 20));
	const first = capture.latest();
	listener!({ execution: execution('big', ['y'.repeat(80 * 1024)]) });
	await new Promise(resolve => setTimeout(resolve, 20));
	const big = capture.latest()!;
	listener!({ execution: execution('broken', ['half'], true) });
	await new Promise(resolve => setTimeout(resolve, 20));
	capture.dispose();
	assert.deepEqual({ nothing, first, bigStart: big.startsWith('$ big\n'), bigBounded: big.length <= 64 * 1024 + 10, stillBig: capture.latest() === big, disposed }, { nothing: undefined, first: '$ pnpm test\nrunning\nok\n', bigStart: true, bigBounded: true, stillBig: true, disposed: true });
});

test('without shell integration nothing is captured and nothing breaks', () => {
	const capture = captureTerminalOutput({});
	capture.dispose();
	assert.equal(capture.latest(), undefined);
});
