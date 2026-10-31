/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { listProviderModels } from '../src/native-provider-models.ts';

test('Claude offers published model versions without calling the provider or pretending account access', async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-provider-versions-'));
	try {
		await fs.mkdir(path.join(home, '.claude'));
		await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
		const models = await listProviderModels('claude', {}, home);
		assert.equal(models.defaultModel, 'opus');
		assert.equal(models.options.some(item => item.id === 'claude-opus-5-5' && item.label === 'Opus 5.5'), true);
		assert.equal(models.options.some(item => item.id === 'sonnet'), true);
		assert.equal(models.options.some(item => item.id === 'claude-sonnet-5-5'), true);
		assert.equal(models.options.some(item => item.id === 'claude-haiku-5-5'), true);
	} finally { await fs.rm(home, { recursive: true, force: true }); }
});
