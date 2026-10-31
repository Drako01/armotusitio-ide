# Chat Harness: matriz manual de accesibilidad

Este documento es la lista de pruebas **manuales** que las pruebas automáticas no pueden reemplazar. Hasta que alguien la complete en cada combinación y adjunte la evidencia, **no se afirma cumplimiento de WCAG 2.2 AA**.

## Qué ya verifica el código

`test/chat-accessibility.test.cts` y `test/chat-renderer.test.cts` ejecutan el webview real en Chromium con tokens de tema Oscuro, Claro y Alto contraste:

| Verificación automática | Resultado en el último ciclo |
| --- | --- |
| Todo control tiene nombre accesible, sin ids duplicados ni referencias ARIA rotas | PASS |
| Una sola región `role=log`, sin `tabindex` positivo, idioma declarado | PASS |
| Contraste de todo texto visible: 4,5:1 (3:1 en texto grande), con fondos compuestos | PASS en los tres conjuntos de tokens |
| Tamaño de objetivo de al menos 24 × 24 px (WCAG 2.2, 2.5.8) | PASS tras corregir selectores y botones «Copiar», que medían 23 y 19 px |
| Indicador de foco visible en cada parada de Tab | PASS (el compositor resalta su marco) |
| Selector de IA como grupo de radio con flechas; Escape devuelve el foco | PASS |
| Los cambios de fase se anuncian y los contadores de tiempo no | PASS |

Límites de esa evidencia: los conjuntos de tokens son representativos de los temas por defecto de VS Code, no de todos los temas instalables; no se midió contraste de componentes gráficos ni de estados de hover; y ninguna prueba automática reemplaza a un usuario de lector de pantalla.

## Matriz manual pendiente

Marcar cada celda con fecha, versión del IDE, versión del lector y evidencia (captura o grabación). Para cada una, repetir con tema Oscuro, Claro y Alto contraste, y con el zoom del editor al 200 %.

| Escenario | NVDA + Windows 11 | VoiceOver + macOS | Criterio de aceptación |
| --- | --- | --- | --- |
| Abrir «Chat Harness» desde la paleta | ☐ | ☐ | Se anuncia el título y el foco queda en el compositor |
| Navegar la cabecera con Tab y flechas | ☐ | ☐ | Proyecto, IA (radio), modelo, esfuerzo, MCP y menú tienen nombre y estado; las flechas cambian la IA |
| Enviar un mensaje | ☐ | ☐ | Se anuncia «pensando» una vez; el reloj no se lee cada segundo |
| Recibir una respuesta con código y tabla | ☐ | ☐ | La respuesta se lee completa; el botón «Copiar código» se anuncia con su propósito |
| Tarjeta de plan: leer pasos, archivos y riesgos | ☐ | ☐ | La estructura de listas se conserva; el aislamiento de escritura se anuncia junto a «Aprobar y ejecutar» |
| Aprobar y ejecutar | ☐ | ☐ | Se anuncian las etapas (preparación, agente, verificaciones) y el resultado de cada gate |
| Detener durante la ejecución | ☐ | ☐ | «Deteniendo…» y luego «cancelada» se anuncian; el foco no se pierde |
| Abrir el detalle de MCP y cerrarlo con Escape | ☐ | ☐ | El foco vuelve al botón que lo abrió |
| Error accionable (límite de uso, proveedor no instalado) | ☐ | ☐ | El mensaje y la acción sugerida se leen sin recorrer toda la conversación |
| Movimiento reducido activado en el sistema | ☐ | ☐ | No hay animaciones esenciales |

## Cómo registrar el resultado

1. Completar la tabla en una copia de este archivo con la fecha y las versiones.
2. Cada falla se registra como hallazgo con el escenario, el lector, lo esperado y lo observado.
3. Solo con la matriz completa y sin hallazgos abiertos se puede escribir «cumple WCAG 2.2 AA» para el Chat Harness.
