/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { HarnessChatSession } from './native-chat-session.ts';
import { redactSecrets } from './native-redact.ts';

/** Only explicit user slash commands create or change project memory. */
export async function runProjectMemoryCommand(words: string[], _root: string, session: HarnessChatSession, t: (text: string, ...args: string[]) => string): Promise<string> {
	const [action, key, ...rest] = words;
	const text = rest.join(' ').trim();
	if (!action) {
		const entries = await session.projectMemory('list');
		return entries.length ? [t('Memoria del proyecto (datos de contexto, nunca permisos):'), ...entries.map(entry => redactSecrets(`${entry.id} [${entry.status}] ${entry.title}: ${entry.decision}`))].join('\n') : t('No hay memoria confirmada en este proyecto.');
	}
	if (action === 'guardar' && ['decision', 'convencion', 'solucion'].includes(key) && text) { await session.projectMemory('save', text, '', key); }
	else if (action === 'corregir' && key && text) { await session.projectMemory('correct', text, key); }
	else if (action === 'quitar' && key && !rest.length) { await session.projectMemory('remove', '', key); }
	else { return t('Uso: /memoria [guardar decision|convencion|solucion TEXTO | corregir ID TEXTO | quitar ID]'); }
	return t('Memoria actualizada. Se aplica en el pr\u00f3ximo turno. Para retirar tambi\u00e9n el contexto ya enviado al proveedor, empez\u00e1 una conversaci\u00f3n nueva.');
}
