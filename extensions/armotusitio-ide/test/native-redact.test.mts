/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, StreamingSecretRedactor } from '../src/native-redact.ts';
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

test('credentials in URLs, private key blocks and more provider token shapes are redacted', () => {
	// Fixtures are assembled at run time so no literal credential-shaped text sits in the repository.
	const url = (scheme: string, user: string, secret: string, host: string): string => scheme + '://' + user + ':' + secret + '@' + host;
	const pem = (kind: string, part: 'BEGIN' | 'END'): string => '-' + '----' + part + ' ' + kind + 'PRIVATE KEY' + '-' + '----';
	const dummy = 'x'.repeat(8);
	const input = [url('postgres', 'user', dummy, 'db.host:5432/app'), url('https', 'u', dummy, 'github.com/x/y.git'), pem('RSA ', 'BEGIN') + '\nbody\n' + pem('RSA ', 'END') + ' after',
	'glpat' + '-' + 'a'.repeat(20), 'AIza' + 'a'.repeat(35), 'sk_' + 'live_' + 'a'.repeat(24), 'aws_secret_access_key = ' + dummy, 'https://example.com/a:b/c', 'cut ' + pem('', 'BEGIN') + '\nbody'].join('\n');
	assert.equal(redactSecrets(input), [url('postgres', 'user', '[redacted]', 'db.host:5432/app'), url('https', 'u', '[redacted]', 'github.com/x/y.git'), '[redacted private key] after',
		'[redacted]', '[redacted]', '[redacted]', 'aws_secret_access_key = [redacted]', 'https://example.com/a:b/c', 'cut [redacted private key]'].join('\n'));
});


test('streaming redaction handles every split, ANSI, multiline values and bounded suppression', () => {
	const token = 'ghp_' + 'A'.repeat(36);
	const input = 'before\n\x1b[31mpassword="private\nmultiline"\x1b[0m\n' + token + '\n-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----\nafter \u00e9\n';
	const expected = redactSecrets(input);
	assert.equal(redactSecrets('ghp_' + 'A'.repeat(18) + '\x1b[?25l' + 'A'.repeat(18) + '\x1b]0;private-title\x07'), '[redacted]');
	for (let split = 0; split <= input.length; split++) {
		const stream = new StreamingSecretRedactor();
		assert.equal(stream.write(input.slice(0, split)) + stream.write(input.slice(split)) + stream.end(), expected, 'split=' + split);
	}
	const oneByte = new StreamingSecretRedactor();
	assert.equal([...input].map(char => oneByte.write(char)).join('') + oneByte.end(), expected);
	const oversized = new StreamingSecretRedactor(20);
	assert.deepEqual([oversized.write('token=' + 'x'.repeat(30)), oversized.write('tail\nafter\n'), oversized.end()], ['[redacted oversized output record; remaining stream suppressed]\n', '', '']);
	assert.equal(redactSecrets('password="unfinished\nprivate'), 'password="[redacted]"');
});


test('stream EOF never emits an unterminated private key block', () => {
	const stream = new StreamingSecretRedactor();
	const before = stream.write('before\n-----BEGIN PRIVATE KEY-----\nprivate-body');
	assert.deepEqual([before, stream.end()], ['before\n', '[redacted private key]']);
});
