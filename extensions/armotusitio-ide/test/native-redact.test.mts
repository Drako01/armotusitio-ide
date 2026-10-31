/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/native-redact.ts';
import { samePath } from '../src/native-path.ts';

test('one redactor covers assignments, JSON, bearer tokens and well-known credential shapes', () => {
	const cases = {
		plain: redactSecrets('api_key=abc123 password: "p w"'),
		json: JSON.parse(redactSecrets('{"api_key":"private value","count":2,"connection_token":"x"}')),
		bearer: redactSecrets('Authorization: Bearer eyJhbGciOi.secret'),
		shapes: redactSecrets('openai sk-abcdefghijklmnop1234 github ghp_' + 'A'.repeat(36) + ' aws AKIAABCDEFGHIJKLMNOP slack xoxb-1234567890-abc'),
		ansi: redactSecrets('\x1b[31mred\x1b[0m'),
		untouched: redactSecrets('tokenizer and secretary are words; npm test')
	};
	assert.deepEqual(cases, {
		plain: 'api_key=[redacted] password: "[redacted]"',
		json: { api_key: '[redacted]', count: 2, connection_token: '[redacted]' },
		bearer: 'Authorization: Bearer [redacted]',
		shapes: 'openai [redacted] github [redacted] aws [redacted] slack [redacted]',
		ansi: 'red',
		untouched: 'tokenizer and secretary are words; npm test'
	});
});

test('path equality follows the host file system: case-insensitive only on Windows', () => {
	assert.deepEqual([
		samePath('c:\\Users\\dev\\storage', 'C:\\Users\\dev\\storage', 'win32'),
		samePath('C:\\Users\\Dev', 'C:\\Users\\dev', 'win32'),
		samePath('/home/dev/storage', '/home/Dev/storage', 'linux'),
		samePath('/Users/dev', '/Users/dev', 'darwin')
	], [true, true, false, true]);
});
