/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeChatDraft } from '../src/native-chat-draft.ts';

test('drafts are bounded and credential-like drafts are dropped before persistence or mirroring', () => {
	assert.deepEqual(['normal draft', 'token = value', '"token": "secret"', 'ghp_1234567890', 'Authorization: Bearer example', '-----BEGIN RSA PRIVATE KEY-----'].map(text => safeChatDraft(text, 8)), ['normal d', '', '', '', '', '']);
});
