/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * What the user last ran in their own IDE terminals, so `@terminal` can attach it to a chat message instead of the user
 * copying it by hand. It relies on VS Code's shell integration; where a terminal has none, nothing is captured and `@terminal`
 * says so. The text stays in memory, is bounded, and is redacted again before it reaches a model.
 */

const MAX_CAPTURED_CHARS = 64 * 1024;

/** The slice of the VS Code shell integration API this module uses; tests pass a fake. */
export interface ShellExecutionApi {
	onDidStartTerminalShellExecution?: (listener: (event: { execution: ShellExecutionLike }) => void) => { dispose(): void };
}
export interface ShellExecutionLike {
	commandLine: { value: string };
	read(): AsyncIterable<string>;
}
export interface TerminalCapture {
	/** The command line and output of the last finished terminal command, or undefined when none was captured. */
	latest(): string | undefined;
	dispose(): void;
}

export function captureTerminalOutput(window: ShellExecutionApi): TerminalCapture {
	let latest: string | undefined;
	const subscription = window.onDidStartTerminalShellExecution?.(event => {
		const { execution } = event;
		void (async () => {
			let text = '';
			try {
				// The stream is only available from the moment `read` is called, so it starts as soon as the command does.
				for await (const chunk of execution.read()) { text = (text + chunk).slice(-MAX_CAPTURED_CHARS); }
			} catch { return; }
			latest = '$ ' + execution.commandLine.value + '\n' + text;
		})();
	});
	return { latest: () => latest, dispose: () => subscription?.dispose() };
}
