/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

/** Fixed native capabilities with human labels and effects, never arbitrary commands from a webview. */
const tools = [
	['list', 'tasks', 'Todas las tareas', 'Consult\u00e1 las tareas registradas, incluidas las finalizadas.'],
	['status', 'tasks', 'Estado de una tarea', 'Consult\u00e1 el estado y el plan guardado de una tarea.', 'task'],
	['progress', 'tasks', 'Avance de una tarea', 'Consult\u00e1 pasos, verificaciones y progreso real.', 'task'],
	['metrics', 'tasks', 'Consumo de una tarea', 'Consult\u00e1 las m\u00e9tricas y el presupuesto registrado.', 'task'],
	['dispatch', 'tasks', 'Importar tareas pendientes', 'Cre\u00e1 tareas a partir de los archivos que dejaste en la bandeja de entrada.', 'confirm'],
	['doctor', 'quality', 'Diagnosticar el entorno', 'Revis\u00e1 dependencias y disponibilidad de las herramientas.'],
	['smoke-host', 'quality', 'Probar la conexi\u00f3n con la IA', 'Ejecut\u00e1 la prueba del proveedor seleccionado. Puede iniciar una consulta a la IA.', 'host'],
	['check', 'quality', 'Revisar contratos', 'Valid\u00e1 la configuraci\u00f3n y los contratos del Harness.'],
	['verify', 'quality', 'Verificar cambios', 'Ejecut\u00e1 las verificaciones que corresponden a los cambios actuales.', 'confirm'],
	['report', 'quality', '\u00daltima verificaci\u00f3n', 'Consult\u00e1 el resultado anterior y si sigue vigente.'],
	['test', 'quality', 'Probar el Harness', 'Ejecut\u00e1 la bater\u00eda de pruebas del propio Harness. Puede tardar varios minutos.', 'confirm'],
	['ci-gaps', 'quality', 'Cobertura de CI', 'Revis\u00e1 qu\u00e9 verificaciones del proyecto faltan en CI.'],
	['flaky', 'quality', 'Pruebas inestables', 'Consult\u00e1 los fallos intermitentes registrados.'],
	['migrations', 'quality', 'Pr\u00f3xima migraci\u00f3n', 'Revis\u00e1 la numeraci\u00f3n disponible y posibles colisiones.'],
	['context', 'context', 'Contexto del proyecto', 'Consult\u00e1 el contexto que reciben los agentes.'],
	['index', 'context', 'Inventario del proyecto', 'Explor\u00e1 dominios y archivos disponibles para los agentes.'],
	['changes', 'context', 'Cambios actuales', 'Consult\u00e1 los archivos modificados respecto de la base del proyecto.'],
	['tokens', 'context', 'Presupuesto de contexto', 'Revis\u00e1 la estimaci\u00f3n de tokens del contexto.'],
	['lessons', 'context', 'Lecciones aprendidas', 'Consult\u00e1 las recomendaciones guardadas por el Harness.'],
	['agents-doc', 'context', 'Actualizar contratos de agentes', 'Regener\u00e1 la documentaci\u00f3n de agentes desde sus manifiestos.', 'confirm'],
	['telemetry', 'performance', 'Rendimiento del Harness', 'Consult\u00e1 tiempos, reintentos y uso de cach\u00e9.'],
	['bench', 'performance', 'Medir el paralelismo', 'Ejecut\u00e1 escenarios de referencia del Harness.', 'confirm'],
	['cache', 'maintenance', 'Estado de la cach\u00e9', 'Consult\u00e1 la disponibilidad de la cach\u00e9 local.'],
	['hygiene', 'maintenance', 'Revisar tareas y espacios abandonados', 'Gener\u00e1 un diagn\u00f3stico de limpieza. Esta consulta no elimina archivos.']
].map(([id, group, title, description, input = 'none']) => ({ id, group, title, description, input }));

function toolArgs(id, task, host = undefined) {
	const tool = tools.find(item => item.id === id);
	if (!tool) { throw new Error('HARNESS_TOOL'); }
	if (tool.input === 'task' && (typeof task !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(task))) { throw new Error('HARNESS_TASK'); }
	if (tool.input === 'host' && !['codex', 'claude'].includes(host)) { throw new Error('HARNESS_PROVIDER'); }
	return [id, ...(tool.input === 'task' ? [task] : tool.input === 'host' ? [host] : id === 'migrations' ? ['next'] : id === 'cache' ? ['status'] : [])];
}

module.exports = { tools, toolArgs };
