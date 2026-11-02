/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSetupItems, setupIcon, type SetupFacts } from '../src/native-setup-check.ts';

const t = (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)] ?? '');
const healthy: SetupFacts = {
	providers: { claude: { status: 'ready', version: '2.1.0' }, codex: { status: 'ready', version: '0.160.0' } },
	doctor: [
		{ id: 'docker', title: 'Docker', status: 'ok', detail: 'Motor linux' },
		{ id: 'wsl', title: 'WSL', status: 'ok', detail: 'WSL disponible' },
		{ id: 'git', title: 'Git', status: 'ok', detail: 'Ana <ana@example.com>' }
	],
	mcp: { state: 'connected' }, trusted: true, coordinatedProjectWriters: true, chatMode: 'act'
};
const summarize = (facts: SetupFacts) => buildSetupItems(facts, t).map(item => [item.id, item.status, item.fix?.kind ?? '-']);

describe('setup check', () => {
	test('a healthy machine reports everything ok', () => {
		assert.deepEqual(summarize(healthy), [['claude', 'ok', '-'], ['codex', 'ok', '-'], ['git', 'ok', '-'], ['docker', 'ok', '-'], ['wsl', 'ok', '-'], ['mcp', 'ok', '-'], ['trust', 'ok', '-'], ['writers', 'ok', '-'], ['mode', 'ok', 'settings']]);
	});

	test('each gap gets one actionable fix', () => {
		const items = buildSetupItems({
			...healthy,
			providers: { claude: { status: 'unavailable' }, codex: { status: 'unauthenticated', version: '0.160.0' } },
			doctor: [{ id: 'docker', title: 'Docker', status: 'warning', detail: 'Docker no responde.', action: 'Inici\u00e1 Docker Desktop.' }, { id: 'git', title: 'Git', status: 'problem', detail: 'Falta la identidad de git.' }],
			mcp: { state: 'disconnected', reason: 'missing-key' }, trusted: false, coordinatedProjectWriters: false, chatMode: 'ask'
		}, t);
		assert.deepEqual(items.map(item => [item.id, item.status, item.fix]), [
			['claude', 'missing', { kind: 'copy', text: 'npm install -g @anthropic-ai/claude-code', label: 'Copiar el comando de instalaci\u00f3n' }],
			['codex', 'warning', { kind: 'copy', text: 'codex login', label: 'Copiar el comando para iniciar sesi\u00f3n' }],
			['git', 'missing', { kind: 'docs', url: 'https://git-scm.com/downloads', label: 'Abrir la descarga de Git' }],
			['docker', 'warning', { kind: 'docs', url: 'https://docs.docker.com/get-docker/', label: 'Abrir la descarga de Docker' }],
			['mcp', 'warning', { kind: 'command', command: 'atsIde.mcpConfigure', label: 'Configurar la clave' }],
			['trust', 'missing', { kind: 'command', command: 'workbench.trust.manage', label: 'Administrar la confianza' }],
			['writers', 'warning', { kind: 'settings', setting: 'atsHarness.coordinatedProjectWriters', label: 'Abrir configuraci\u00f3n' }],
			['mode', 'ok', { kind: 'settings', setting: 'atsHarness.chatMode', label: 'Abrir configuraci\u00f3n' }]
		]);
		assert.equal(items.find(item => item.id === 'docker')?.detail, 'Docker no responde. Inici\u00e1 Docker Desktop.');
	});

	test('checks the machine did not run (WSL off Windows) are omitted, and icons map every status', () => {
		assert.equal(buildSetupItems({ ...healthy, doctor: healthy.doctor.filter(check => check.id !== 'wsl') }, t).some(item => item.id === 'wsl'), false);
		assert.deepEqual((['ok', 'warning', 'missing'] as const).map(setupIcon), ['$(check)', '$(warning)', '$(error)']);
	});
});
