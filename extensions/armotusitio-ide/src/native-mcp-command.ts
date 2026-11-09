/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * `/mcp` in the Chat Harness: connect any MCP server to the conversation the way Claude Code's `/mcp` does.
 *   /mcp                                   list the servers (and the Work Management tools when connected)
 *   /mcp add NAME URL|COMMAND [ARGS] [--token] [--env VAR ...]
 *   /mcp remove NAME | /mcp enable NAME | /mcp disable NAME
 * Secrets are never typed into the chat: `--token` and `--env VAR` open a masked prompt. Adding a server asks for one
 * explicit confirmation that shows exactly what will run or be contacted; each tool call still asks through the broker.
 */
import type { OAuthTokens } from './native-mcp-oauth.ts';
import { parseServerWords, type McpServer, type McpServerInput, type McpServerStore } from './native-mcp-servers.ts';

type Translate = (text: string, ...args: string[]) => string;

export interface McpCommandDeps {
	t: Translate;
	store: McpServerStore;
	/** Modal confirmation showing what the server will run or contact. */
	confirm(summary: string): Promise<boolean>;
	/** Masked prompt for one secret; `undefined` when the user cancels. */
	askSecret(prompt: string): Promise<string | undefined>;
	/** Browser sign-in (OAuth) for a remote server; rejects with a `HARNESS_MCP_OAUTH_*` code. */
	authorize?(url: string): Promise<OAuthTokens>;
	/** The Work Management section shown by a bare `/mcp` when that integration is connected. */
	workManagement?(): Promise<string | undefined>;
}

function describe(t: Translate, server: McpServer): string {
	const target = server.transport === 'http' ? server.url! : [server.command, ...(server.args ?? [])].join(' ');
	const secrets = server.oauth ? ['oauth'] : server.hasToken ? [t('token')] : (server.envNames ?? []);
	return '  ' + server.name + '  ' + (server.enabled ? t('activo') : t('desactivado')) + '  ' + server.transport + '  ' + target.slice(0, 120) + (secrets.length ? '  (' + t('credenciales') + ': ' + secrets.join(', ') + ')' : '');
}

/** Words of `/mcp add` after the name, split into the server words and the secret flags. */
function splitFlags(words: readonly string[]): { rest: string[]; token: boolean; oauth: boolean; env: string[] } | undefined {
	const rest: string[] = [];
	const env: string[] = [];
	let token = false;
	let oauth = false;
	for (let index = 0; index < words.length; index++) {
		if (words[index] === '--token') { token = true; }
		else if (words[index] === '--oauth') { oauth = true; }
		else if (words[index] === '--env') { const name = words[++index]; if (!name) { return undefined; } env.push(name); }
		else { rest.push(words[index]); }
	}
	return { rest, token, oauth, env };
}

async function add(deps: McpCommandDeps, name: string | undefined, words: readonly string[]): Promise<string> {
	const { t } = deps;
	const usage = t('Uso: /mcp add NOMBRE URL|COMANDO [ARGUMENTOS] [--token] [--env VARIABLE ...]. Ejemplo: /mcp add docs https://mcp.example.com/sse --token');
	const flags = name ? splitFlags(words) : undefined;
	const input: McpServerInput | undefined = flags && name ? parseServerWords(name.toLowerCase(), flags.rest) : undefined;
	if (!flags || !input) { return usage; }
	if (flags.oauth && (flags.token || input.url === undefined || !deps.authorize)) { return t('--oauth es solo para servidores remotos (URL) y no se combina con --token.'); }
	if ((flags.token && input.url === undefined) || (flags.env.length && input.url !== undefined)) { return t('--token es para servidores remotos (URL) y --env para servidores locales (comando).'); }
	const target = input.url ?? [input.command, ...(input.args ?? [])].join(' ');
	const summary = input.url !== undefined
		? t('Conectar el servidor MCP {0} en {1}. El agente podr\u00e1 pedirle herramientas; cada uso te lo pregunta.', input.name, target)
		: t('Ejecutar en tu equipo el programa MCP {0}: {1}. Corre con tus permisos, fuera del sandbox del Harness; cada uso de sus herramientas te lo pregunta.', input.name, target);
	if (!await deps.confirm(summary)) { return t('No agregu\u00e9 el servidor.'); }
	if (flags.oauth) {
		try { input.oauth = await deps.authorize!(input.url!); }
		catch (error) { return t('No agregu\u00e9 el servidor: no se pudo iniciar sesi\u00f3n ({0}). Revis\u00e1 que el servidor admita OAuth con registro din\u00e1mico.', (error as Error).message); }
	}
	if (flags.token) {
		input.token = await deps.askSecret(t('Token (Bearer) para {0}', input.name));
		if (!input.token) { return t('No agregu\u00e9 el servidor: faltaba el token.'); }
	}
	if (flags.env.length) {
		input.env = {};
		for (const variable of flags.env) {
			const value = await deps.askSecret(t('Valor de {0} para {1}', variable, input.name));
			if (value === undefined) { return t('No agregu\u00e9 el servidor: faltaba {0}.', variable); }
			input.env[variable] = value;
		}
	}
	const server = await deps.store.add(input);
	return t('Agregu\u00e9 el servidor {0}. Se usa desde la pr\u00f3xima conversaci\u00f3n del agente (Empezar de nuevo). Sus herramientas aparecen como mcp__{0}__<herramienta> y piden permiso en cada uso.', server.name);
}

export async function runMcpCommand(deps: McpCommandDeps, words: readonly string[]): Promise<string> {
	const { t } = deps;
	const [action = '', name = '', ...rest] = words;
	switch (action.toLowerCase()) {
		case '': {
			const servers = await deps.store.list();
			const signedOut = await deps.store.needsSignIn();
			const work = await deps.workManagement?.();
			return [servers.length ? t('Servidores MCP conectados:') + '\n' + servers.map(server => describe(t, server) + (signedOut.includes(server.name) ? '  [' + t('requiere iniciar sesi\u00f3n: /mcp remove y /mcp add --oauth') + ']' : '')).join('\n') : t('No hay servidores MCP conectados.'),
			t('Hoy los usa Claude Code; Codex todav\u00eda no.'), t('Agregar: /mcp add NOMBRE URL|COMANDO [--token] [--env VARIABLE]. Quitar: /mcp remove NOMBRE. Activar o desactivar: /mcp enable|disable NOMBRE.'), ...(work ? ['', work] : [])].join('\n');
		}
		case 'add': return await add(deps, name || undefined, rest);
		case 'remove': return name && await deps.store.remove(name.toLowerCase()) ? t('Quit\u00e9 el servidor {0} y sus credenciales.', name) : t('No encontr\u00e9 el servidor {0}.', name);
		case 'enable':
		case 'disable': {
			const enabled = action.toLowerCase() === 'enable';
			return name && await deps.store.setEnabled(name.toLowerCase(), enabled) ? t(enabled ? 'Activ\u00e9 el servidor {0}.' : 'Desactiv\u00e9 el servidor {0}.', name) : t('No encontr\u00e9 el servidor {0}.', name);
		}
		default: return t('Uso: /mcp [add|remove|enable|disable] ...');
	}
}
