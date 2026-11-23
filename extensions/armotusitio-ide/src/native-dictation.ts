/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Dictation through Windows voice typing: the IDE ships no speech engine, so it presses Win+H for the user. */
'use strict';
const { execFile } = require('node:child_process');

const DICTATION_TIMEOUT_MS = 15000;
const VK_LWIN = 0x5B, VK_H = 0x48, KEYEVENTF_KEYUP = 2;
/** Presses and releases Win+H on the focused window, so Windows voice typing writes into the chat box. */
const PRESS_WIN_H = [
	`Add-Type -Namespace Ats -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, System.UIntPtr extra);'`,
	`[Ats.Keys]::keybd_event(${VK_LWIN}, 0, 0, [UIntPtr]::Zero)`,
	`[Ats.Keys]::keybd_event(${VK_H}, 0, 0, [UIntPtr]::Zero)`,
	`[Ats.Keys]::keybd_event(${VK_H}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)`,
	`[Ats.Keys]::keybd_event(${VK_LWIN}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)`,
].join('; ');

/** Whether this platform has a dictation the chat can open. */
function dictationSupported(platform: string = process.platform): boolean { return platform === 'win32'; }

/** Opens Windows voice typing; rejects when PowerShell fails, so the caller can tell the user to press Win+H. */
function startDictation(): Promise<void> {
	if (!dictationSupported()) { return Promise.reject(Error('HARNESS_DICTATION_UNSUPPORTED')); }
	const encoded = Buffer.from(PRESS_WIN_H, 'utf16le').toString('base64');
	return new Promise((resolve, reject) => {
		execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: DICTATION_TIMEOUT_MS }, (error: Error | null) => error ? reject(error) : resolve());
	});
}

module.exports = { dictationSupported, startDictation, PRESS_WIN_H };
