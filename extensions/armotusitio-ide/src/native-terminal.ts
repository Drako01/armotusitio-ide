/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * A visible IDE terminal for one agent command, so the person can answer the questions the command asks. The command itself
 * still runs through `runCommand` (no shell, policy already applied, bounded, redacted); this is only its screen and keyboard.
 * There is no pseudo-terminal device behind it: programs that need a real TTY (full-screen UIs, arrow-key menus) are out of
 * scope, plain line prompts (`readline`, `input()`, y/n questions) work.
 */
import { runCommand, type CommandRequest, type CommandResult, type InteractiveIo } from './native-command-runner.ts';

/** The slice of the VS Code API this module needs; tests pass a fake. */
export interface TerminalApi {
	window: { createTerminal(options: { name: string; pty: PseudoTerminal }): { show(preserveFocus?: boolean): void } };
	EventEmitter: new () => { event: (listener: (value: string) => void) => unknown; fire(value: string): void };
}
export interface PseudoTerminal {
	onDidWrite: (listener: (value: string) => void) => unknown;
	open(): void;
	close(): void;
	handleInput(data: string): void;
}
export interface InteractiveTerminal {
	io: InteractiveIo;
	/** Prints the end of the command on the terminal screen; the terminal stays open to be read. */
	finished(summary: string): void;
}

/** What a secret request looks like: typed characters are not echoed. */
const SECRET_PROMPT = /pass(word|phrase)|token|secret/i;
const BACKSPACE = '\u007f';
const INTERRUPT = '\u0003';
const ENTER = '\r';

/**
 * Opens the terminal and returns the IO a `runCommand` call attaches to. `interrupt` is called when the person presses
 * Ctrl+C or closes the terminal, so the command stops.
 */
export function openInteractiveTerminal(api: TerminalApi, title: string, interrupt: () => void): InteractiveTerminal {
	const writer = new api.EventEmitter();
	let send: ((data: string) => void) | undefined;
	let typed = '', screenLine = '', over = false;
	const print = (text: string): void => { writer.fire(text.replace(/\r?\n/g, '\r\n')); };
	const pty: PseudoTerminal = {
		onDidWrite: writer.event,
		open: () => undefined,
		close: () => { if (!over) { interrupt(); } },
		handleInput(data: string): void {
			if (over) { return; }
			const secret = SECRET_PROMPT.test(screenLine);
			for (const character of data) {
				if (character === INTERRUPT) { interrupt(); return; }
				if (character === ENTER) {
					writer.fire('\r\n');
					send?.(typed + '\n');
					typed = ''; screenLine = '';
				} else if (character === BACKSPACE) {
					if (typed) { typed = typed.slice(0, -1); if (!secret) { writer.fire('\b \b'); } }
				} else if (character >= ' ') {
					typed += character;
					if (!secret) { writer.fire(character); }
				}
			}
		}
	};
	api.window.createTerminal({ name: title, pty }).show(false);
	return {
		io: {
			onOutput: text => {
				print(text);
				screenLine = (screenLine + text).split(/\r?\n/).at(-1)!.slice(-200);
			},
			onInput: write => { send = write; return () => { send = undefined; }; }
		},
		finished: summary => { over = true; print('\n' + summary + '\n'); }
	};
}

/** One command in a fresh visible terminal: the person answers its prompts, Ctrl+C or closing the terminal stops it. */
export function runInTerminal(api: TerminalApi, request: Omit<CommandRequest, 'signal' | 'interactive'>, finishedText: string): Promise<CommandResult> {
	const abort = new AbortController();
	const terminal = openInteractiveTerminal(api, 'ArmoTuSitio: ' + [request.command, ...request.args].join(' ').slice(0, 60), () => abort.abort());
	return runCommand({ ...request, signal: abort.signal, interactive: terminal.io }).finally(() => terminal.finished(finishedText));
}
