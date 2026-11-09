/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * AI Accounts: the full account manager as an editor tab. The host owns every decision (validation, confirmation, the
 * registry); the webview only draws state and posts a closed set of operations on a profile id. No secret ever reaches it.
 */
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { profileActions, signingInOf, type ProfileCommandDeps } from './native-profile-commands.ts';
import type { AuthState } from './native-profiles.ts';
import type { NativeProvider } from './native-providers.ts';

type Host = any; // vscode host is injected by the existing extension, like the rest of the native integration.

const PROVIDERS: readonly NativeProvider[] = ['claude', 'codex'];
const PROVIDER_LABEL: Readonly<Record<NativeProvider, string>> = { claude: 'Claude Code', codex: 'OpenAI Codex' };
/** The operations the webview may request; anything else is ignored. */
export const ACCOUNT_OPERATIONS = ['signIn', 'default', 'assign', 'unassign', 'rename', 'remove'] as const;
export type AccountOperation = typeof ACCOUNT_OPERATIONS[number];

export interface AccountsLabels {
	title: string; description: string; add: string; refresh: string; summary: string; workspace: string; noWorkspace: string; here: string; isDefault: string; checking: string; empty: string; emptyHint: string;
	signIn: string; makeDefault: string; useHere: string; stopHere: string; rename: string; remove: string; states: Record<AuthState, string>; workspaces: string;
}

/** Static page: strict CSP with a nonce, no inline handlers, all content drawn by the script from state messages. */
export function accountsHtml(t: (text: string) => string, cspSource: string, nonce: string, cssUri: string, scriptUri: string): string {
	return `<!doctype html><html lang="es-AR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}"><title>AI Accounts</title></head>
<body><main aria-labelledby="accounts-title">
<header class="page-header"><div><h1 id="accounts-title">${t('AI Accounts')}</h1><p id="accounts-description" class="subtitle"></p><p id="accounts-summary" class="muted" role="status" aria-live="polite"></p></div>
<div class="toolbar"><button id="refresh" class="quiet" type="button"></button><button id="add" type="button"></button></div></header>
<div id="providers"></div>
</main><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

export function accountsLabels(t: (text: string) => string): AccountsLabels {
	return {
		title: t('AI Accounts'), description: t('Varias cuentas por proveedor, cada una con su sesi\u00f3n aislada. Eleg\u00ed cu\u00e1l usa cada proyecto.'), add: t('Agregar cuenta'), refresh: t('Actualizar'),
		summary: t('{0} cuentas en {1} proveedores'), workspace: t('Workspaces'), noWorkspace: t('Ning\u00fan workspace'), here: t('Este workspace'), isDefault: t('Predeterminada'), checking: t('Comprobando\u2026'),
		empty: t('Sin cuentas'), emptyHint: t('Se usa la sesi\u00f3n del IDE. Agreg\u00e1 una cuenta para separar personal y trabajo.'),
		signIn: t('Iniciar sesi\u00f3n'), makeDefault: t('Hacer predeterminada'), useHere: t('Usar aqu\u00ed'), stopHere: t('Dejar de usar aqu\u00ed'), rename: t('Renombrar'), remove: t('Eliminar'), workspaces: t('Workspaces'),
		states: {
			authenticated: t('Autenticada'), 'not-authenticated': t('Sin sesi\u00f3n'), unknown: t('Estado desconocido'), 'cli-unavailable': t('CLI no disponible'),
			'connection-failed': t('Fall\u00f3 la conexi\u00f3n'), connecting: t('Conectando\u2026')
		}
	};
}

export function registerAccountsPanel(context: Host, vscode: Host, deps: ProfileCommandDeps): void {
	const t: (text: string) => string = vscode.l10n.t;
	let panel: Host;
	const previous = deps.onSignInEnded;
	deps.onSignInEnded = () => { previous?.(); void publish(); };
	const actions = profileActions(vscode, deps);

	/** One state message: profiles with their real login state (asked to each CLI), grouped by provider. */
	async function state(): Promise<unknown> {
		const root = await deps.rootOf();
		const [profiles, placement] = await Promise.all([deps.registry.list(), deps.registry.placement(root)]);
		const accounts = await Promise.all(profiles.map(async profile => ({
			id: profile.id, alias: profile.alias, provider: profile.provider, state: signingInOf(deps).has(profile.id) ? 'connecting' : await deps.registry.authState(profile, process.env),
			isDefault: placement.defaults[profile.provider] === profile.id, here: placement.workspace[profile.provider] === profile.id,
			workspaces: (await deps.registry.workspacesOf(profile.id)).map(key => path.basename(key) || key)
		})));
		return { type: 'state', root: root ? path.basename(root) : null, providers: PROVIDERS.map(id => ({ id, label: PROVIDER_LABEL[id], accounts: accounts.filter(account => account.provider === id) })) };
	}

	const publish = async (): Promise<void> => {
		if (!panel) { return; }
		void panel.webview.postMessage({ type: 'busy' });
		try { void panel.webview.postMessage(await state()); } catch (error) { deps.showError(error); }
	};

	async function run(operation: AccountOperation, id: string): Promise<void> {
		const profile = await deps.registry.get(id);
		if (!profile) { throw Error('HARNESS_PROFILE_NOT_FOUND'); }
		const root = await deps.rootOf();
		switch (operation) {
			case 'signIn': await actions.signIn(profile); break;
			case 'default': await deps.registry.setDefault(id); break;
			case 'assign': if (root) { await deps.registry.assign(root, id); } break;
			case 'unassign': if (root) { await deps.registry.unassign(root, profile.provider); } break;
			case 'rename': await actions.rename(profile); break;
			case 'remove': await actions.remove(profile); break;
		}
	}

	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.accounts.open', () => {
		if (panel) { panel.reveal(); void publish(); return; }
		const resources = vscode.Uri.joinPath(context.extensionUri, 'resources');
		panel = vscode.window.createWebviewPanel('atsIde.accounts', 'AI Accounts', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [resources, vscode.Uri.joinPath(context.extensionUri, 'dist')] });
		const current = panel;
		const nonce = randomBytes(24).toString('base64');
		current.webview.html = accountsHtml(t, current.webview.cspSource, nonce, current.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'accounts.css')).toString(), current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'accounts.js')).toString());
		const subscription = current.webview.onDidReceiveMessage(async (message: { action?: unknown; op?: unknown; id?: unknown }) => {
			try {
				if (message?.action === 'ready') { void current.webview.postMessage({ type: 'init', labels: accountsLabels(t) }); await publish(); }
				else if (message?.action === 'refresh') { await publish(); }
				else if (message?.action === 'add') { await vscode.commands.executeCommand('atsHarness.accounts.add'); await publish(); }
				else if (message?.action === 'op' && typeof message.id === 'string' && message.id.length <= 64 && (ACCOUNT_OPERATIONS as readonly unknown[]).includes(message.op)) {
					await run(message.op as AccountOperation, message.id); await publish();
				}
			} catch (error) { deps.showError(error); void publish(); }
		});
		current.onDidDispose(() => { subscription.dispose(); panel = undefined; });
	}));
}
