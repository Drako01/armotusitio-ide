/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Models each provider CLI offers and its configured default, read from the CLI's own files. No provider is invoked. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { validModel, type NativeProvider } from './native-providers.ts';

export interface ProviderModels {
	/** The model the CLI uses when none is passed; absent when its configuration does not name one. */
	defaultModel?: string;
	options: Array<{ id: string; label: string }>;
}

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_OPTIONS = 20;
/** Claude Code resolves these aliases to the latest model of each family. */
const CLAUDE_ALIASES = [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }];

/** A missing, oversized or unreadable optional file means "unknown", never an error. */
async function readConfig(file: string): Promise<string | undefined> {
	const stat = await fs.stat(file).catch(() => undefined);
	if (!stat?.isFile() || stat.size > MAX_CONFIG_BYTES) { return undefined; }
	return fs.readFile(file, 'utf8').catch(() => undefined);
}
function parseJson(text: string | undefined): Record<string, unknown> | undefined {
	try {
		const value: unknown = text ? JSON.parse(text) : undefined;
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch { return undefined; }
}

async function codexModels(env: NodeJS.ProcessEnv, home: string): Promise<ProviderModels> {
	const directory = env.CODEX_HOME || path.join(home, '.codex');
	// Only the top-level `model` key: keys after the first [table] belong to profiles or model providers.
	const topLevel = (await readConfig(path.join(directory, 'config.toml')))?.split(/^\s*\[/m)[0] ?? '';
	const configured = /^\s*model\s*=\s*"(?<model>[^"]+)"\s*$/m.exec(topLevel)?.groups?.model;
	const cache = parseJson(await readConfig(path.join(directory, 'models_cache.json')));
	const options = (Array.isArray(cache?.models) ? cache.models as Array<Record<string, unknown>> : [])
		.filter(model => model?.visibility === 'list' && validModel(model.slug))
		.sort((left, right) => (Number(left.priority) || 0) - (Number(right.priority) || 0))
		.slice(0, MAX_OPTIONS)
		.map(model => ({ id: model.slug as string, label: typeof model.display_name === 'string' ? model.display_name.slice(0, 64) : model.slug as string }));
	return { ...(validModel(configured) ? { defaultModel: configured } : {}), options };
}

async function claudeModels(env: NodeJS.ProcessEnv, home: string): Promise<ProviderModels> {
	const settings = parseJson(await readConfig(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json')));
	// ANTHROPIC_MODEL overrides the settings file, as in the CLI.
	const configured = env.ANTHROPIC_MODEL || settings?.model;
	return { ...(validModel(configured) ? { defaultModel: configured } : {}), options: CLAUDE_ALIASES };
}

export function listProviderModels(provider: NativeProvider, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<ProviderModels> {
	return provider === 'codex' ? codexModels(env, home) : claudeModels(env, home);
}
