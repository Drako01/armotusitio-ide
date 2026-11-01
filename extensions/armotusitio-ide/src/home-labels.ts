/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

/** Copy of Inicio's control center (block AC): short sentences that say what is happening and what to do. */
function inicioLabels(t) {
	return {
		askTitle: t('\u00bfQu\u00e9 quer\u00e9s hacer?'), askPlaceholder: t('Describ\u00ed el cambio. La IA lo conversa con vos y te propone un plan para aprobar.'), ask: t('Enviar al chat'),
		askProject: t('Proyecto'), askHint: t('Enviar solo conversa: nada cambia hasta que apruebes un plan.'),
		attention: t('Necesita tu atenci\u00f3n'), now: t('Ahora'), recent: t('Recientes'), projects: t('Proyectos'), more: t('M\u00e1s'),
		idle: t('Nada en curso.'), noRecent: t('Todav\u00eda no hay actividad en este workspace.'), stale: t('Desactualizado'), filter: t('Filtrar'),
		states: { queued: t('En espera'), running: t('En curso'), paused: t('Esperando'), completed: t('Completada'), partial: t('Parcial'), blocked: t('Bloqueada'), unchanged: t('Sin cambios'), failed: t('Fallida'), cancelled: t('Cancelada'), interrupted: t('Interrumpida') },
		needs: { approval: t('Plan listo para aprobar'), answer: t('Esperando tu respuesta'), review: t('Entrega lista para revisar'), service: t('Falta un servicio'), credential: t('Falta una credencial'), policy: t('Necesita un permiso'), decision: t('Necesita tu decisi\u00f3n'), toolchain: t('Falta una herramienta'), disk: t('Falta espacio en disco') },
		actions: { open: t('Ver'), stop: t('Detener'), approve: t('Aprobar y ejecutar'), continue: t('Continuar'), retry: t('Reintentar'), answer: t('Responder') },
		stages: { preparing: t('Preparando'), agent: t('Agente trabajando'), verifying: t('Verificando') },
		step: t('Paso {0} de {1}', '{0}', '{1}'), elapsed: t('hace {0}', '{0}'),
		kinds: { 'chat-run': t('Chat'), task: t('Tarea'), external: t('Harness del proyecto') }
	};
}

module.exports = { inicioLabels };
