/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Command Palette surface of the AI profile registry: add an account, then manage it (sign in through the provider's own
 * login, rename, default, assign to this workspace, delete). Nothing here asks for a password or touches a token.
 */
import type { AiProfile, AuthState, ProfileRegistry } from './native-profiles.ts';
import type { NativeProvider } from './native-providers.ts';

/** The vscode host is injected by the extension, like the rest of the native integration. */
type Host = any;

const PROVIDER_LABEL: Readonly<Record<NativeProvider, string>> = { claude: 'Claude Code', codex: 'OpenAI Codex' };
/** The provider's own interactive login; the IDE only opens it in a terminal that has the profile directory. */
const LOGIN_COMMAND: Readonly<Record<NativeProvider, string>> = { claude: 'claude auth login', codex: 'codex login' };

/** Text and icon together, so a state never depends on color. */
export function authStateLabel(t: (text: string) => string, state: AuthState): string {
	switch (state) {
		case 'authenticated': return '$(check) ' + t('Autenticada');
		case 'not-authenticated': return '$(warning) ' + t('Sin sesi\u00f3n');
		case 'cli-unavailable': return '$(error) ' + t('CLI no disponible');
		case 'unknown': return '$(question) ' + t('Estado desconocido');
		case 'connection-failed': return '$(error) ' + t('Fall\u00f3 la conexi\u00f3n');
		case 'connecting': return '$(sync) ' + t('Conectando\u2026');
	}
}

export interface ProfileCommandDeps {
	registry: ProfileRegistry;
	/** The workspace root the chat works on (asks when there are several). */
	rootOf(): Promise<string | undefined>;
	showError(error: unknown): void;
	/** Called when a sign-in terminal closes, so open screens re-check the real state. */
	onSignInEnded?(): void;
}

/** Profiles whose sign-in terminal is open, per command surface: reported as `connecting` until the terminal closes. */
const signingIn = new WeakMap<ProfileCommandDeps, Set<string>>();
export function signingInOf(deps: ProfileCommandDeps): ReadonlySet<string> { return signingIn.get(deps) ?? new Set(); }

/** Last onboarding steps: ask the provider CLI what the terminal achieved, then offer the scope (this workspace) or the recovery (retry). */
async function verifySignIn(vscode: Host, deps: ProfileCommandDeps, profile: AiProfile): Promise<void> {
	const t = vscode.l10n.t;
	if (await deps.registry.authState(profile, process.env) === 'authenticated') {
		const root = await deps.rootOf();
		const here = root ? t('Usar en este workspace') : undefined;
		const choice = await vscode.window.showInformationMessage(t('La cuenta {0} qued\u00f3 autenticada.', profile.alias), ...(here ? [here] : []));
		if (choice && root) { await deps.registry.assign(root, profile.id); deps.onSignInEnded?.(); }
		return;
	}
	const retry = t('Reintentar');
	if (await vscode.window.showWarningMessage(t('No se detect\u00f3 una sesi\u00f3n en la cuenta {0}. Si cerraste el terminal antes de terminar, pod\u00e9s reintentar.', profile.alias), retry) === retry) { await openSignIn(vscode, deps, profile); }
}

async function openSignIn(vscode: Host, deps: ProfileCommandDeps, profile: AiProfile): Promise<void> {
	const t = vscode.l10n.t;
	// A terminal with the profile directory and without any other account's credentials: the provider does its own OAuth.
	const terminal = vscode.window.createTerminal({ name: t('Cuenta {0}', profile.alias), env: deps.registry.terminalEnvironment(profile) });
	const open = signingIn.get(deps) ?? new Set<string>();
	signingIn.set(deps, open.add(profile.id));
	const closed = vscode.window.onDidCloseTerminal((closing: unknown) => {
		if (closing !== terminal) { return; }
		open.delete(profile.id);
		closed.dispose();
		deps.onSignInEnded?.();
		void verifySignIn(vscode, deps, profile).catch(error => deps.showError(error));
	});
	terminal.show();
	terminal.sendText(LOGIN_COMMAND[profile.provider]);
}

async function chooseProfile(vscode: Host, deps: ProfileCommandDeps, root: string | undefined): Promise<AiProfile | undefined> {
	const t = vscode.l10n.t;
	const profiles = await deps.registry.list();
	if (!profiles.length) { void vscode.window.showInformationMessage(t('Todav\u00eda no agregaste cuentas. Us\u00e1 {0}.', t('ArmoTuSitio: Agregar cuenta de IA'))); return undefined; }
	const states = await Promise.all(profiles.map(profile => deps.registry.authState(profile, process.env)));
	const placement = await deps.registry.placement(root);
	const picked = await vscode.window.showQuickPick(profiles.map((profile, index) => {
		const marks = [placement.defaults[profile.provider] === profile.id ? t('predeterminada') : '', placement.workspace[profile.provider] === profile.id ? t('este workspace') : ''].filter(Boolean);
		return { label: profile.alias, description: PROVIDER_LABEL[profile.provider] + (marks.length ? ' \u00b7 ' + marks.join(' \u00b7 ') : ''), detail: authStateLabel(t, states[index]), profile };
	}), { title: t('Cuentas de IA'), placeHolder: t('Eleg\u00ed una cuenta para administrarla'), matchOnDescription: true });
	return picked?.profile;
}

/** Account actions that need the user's confirmation or input, shared by the Command Palette and the AI Accounts screen. */
export function profileActions(vscode: Host, deps: ProfileCommandDeps): { signIn(profile: AiProfile): Promise<void>; rename(profile: AiProfile): Promise<void>; remove(profile: AiProfile): Promise<void> } {
	const t = vscode.l10n.t;
	return {
		signIn: profile => openSignIn(vscode, deps, profile),
		rename: async profile => { const alias = await vscode.window.showInputBox({ title: t('Nuevo alias'), value: profile.alias }); if (alias !== undefined) { await deps.registry.rename(profile.id, alias); } },
		remove: async profile => { if (await vscode.window.showWarningMessage(t('Se elimina la cuenta {0} y su sesi\u00f3n guardada en este IDE. Las dem\u00e1s no se tocan.', profile.alias), { modal: true }, t('Eliminar'))) { await deps.registry.remove(profile.id); } }
	};
}

export function registerProfileCommands(context: Host, vscode: Host, deps: ProfileCommandDeps): void {
	const t = vscode.l10n.t;
	const shared = profileActions(vscode, deps);
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.accounts.add', async () => {
		try {
			const provider = await vscode.window.showQuickPick((['claude', 'codex'] as const).map(value => ({ label: PROVIDER_LABEL[value], value })), { title: t('Agregar cuenta de IA'), placeHolder: t('Proveedor') });
			if (!provider) { return; }
			const alias = await vscode.window.showInputBox({ title: t('Alias de la cuenta'), prompt: t('Un nombre para reconocerla, por ejemplo Personal o Trabajo'), validateInput: (value: string) => value.trim().length < 1 || value.trim().length > 40 ? t('Entre 1 y 40 caracteres') : undefined });
			if (alias === undefined) { return; }
			const profile = await deps.registry.add(provider.value, alias);
			const next = await vscode.window.showInformationMessage(t('Cuenta {0} creada. Falta iniciar sesi\u00f3n.', profile.alias), t('Iniciar sesi\u00f3n'));
			if (next) { await openSignIn(vscode, deps, profile); }
		} catch (error) { deps.showError(error); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.accounts.manage', async () => {
		try {
			const root = await deps.rootOf();
			const profile = await chooseProfile(vscode, deps, root);
			if (!profile) { return; }
			const actions = [
				{ label: '$(sign-in) ' + t('Iniciar o renovar sesi\u00f3n'), run: () => openSignIn(vscode, deps, profile) },
				{ label: '$(star) ' + t('Usar como predeterminada de {0}', PROVIDER_LABEL[profile.provider]), run: () => deps.registry.setDefault(profile.id) },
				...(root ? [{ label: '$(folder) ' + t('Usar en este workspace'), run: () => deps.registry.assign(root, profile.id) }, { label: '$(close) ' + t('Quitar la asignaci\u00f3n de este workspace'), run: () => deps.registry.unassign(root, profile.provider) }] : []),
				{ label: '$(edit) ' + t('Cambiar alias'), run: () => shared.rename(profile) },
				{ label: '$(trash) ' + t('Eliminar cuenta y su sesi\u00f3n'), run: () => shared.remove(profile) }
			];
			const action = await vscode.window.showQuickPick(actions, { title: profile.alias + ' \u00b7 ' + PROVIDER_LABEL[profile.provider] });
			await action?.run();
		} catch (error) { deps.showError(error); }
	}));
}
