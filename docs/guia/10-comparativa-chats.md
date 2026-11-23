# 10. Comparativa: Claude, Codex y Chat Harness

[← Anterior: Permisos](09-permisos.md) · [Índice](../../README.md#índice) · [Chat Harness](04-chat-harness.md)

Comparación de la experiencia de uso del Chat Harness con el chat de Claude Code y el de Codex, función por función. Sirve de referencia para saber qué podés hacer desde el IDE igual que si usaras Claude o Codex directamente.

Estado a la versión 1.147.0 r3. ✅ igual o mejor · ⚠️ parcial · ❌ falta.

## Elegir con qué trabajar

| Función | Claude Code | Codex | Chat Harness |
|---|---|---|---|
| Elegir la IA (Claude o Codex) | Solo Claude | Solo Codex | ✅ Las dos, con un clic en la cabecera |
| Elegir modelo | Sí | Sí | ✅ Debajo del cuadro de texto |
| Elegir cuánto razona | Sí | Sí | ✅ «Razonamiento», debajo del cuadro de texto |
| Modo que solo conversa y modo que cambia código | Sí | Sí | ✅ «Preguntar» y «Actuar» |
| Varias cuentas | No | No | ✅ Selector de cuenta por IA |

## Escribir y conversar

| Función | Claude Code | Codex | Chat Harness |
|---|---|---|---|
| Mencionar archivos con `@` | Sí | Sí | ✅ |
| Comandos con `/` | Sí | Sí | ✅ (`/ayuda` los lista) |
| Adjuntar imágenes y archivos | Sí | Sí | ✅ Pegar, arrastrar o botón **+** |
| La respuesta aparece mientras se escribe, dentro de la conversación | Sí | Sí | ✅ |
| Colores en los bloques de código | Sí | Sí | ✅ |
| Abrir con un clic los archivos y enlaces que nombra la IA | Sí | Sí | ✅ |
| Detener con Esc | Sí | Sí | ✅ |
| Dejar mensajes en cola mientras trabaja | Sí | Sí | ✅ |
| Editar un mensaje anterior y seguir desde ahí | Sí | Sí | ✅ «Editar», debajo de cada mensaje tuyo |
| Nueva conversación con un clic | Sí | Sí | ✅ Botón con globo y **+** |
| Retomar conversaciones guardadas | Sí | Sí | ✅ «Sesiones guardadas» |

## Conversaciones largas

| Función | Claude Code | Codex | Chat Harness |
|---|---|---|---|
| Usa toda la memoria de trabajo del modelo | Sí | Sí | ✅ Con el modo automático (predeterminado), la sesión vive en Claude o Codex con toda su capacidad |
| Ver cuánto espacio queda | Sí | Sí | ✅ «Espacio usado», con los números que informa la IA |
| Resumir cuando vos quieras | Sí (`/compact`) | Sí | ✅ `/resumir` o botón **Resumir**; la conversación completa queda guardada |
| Resumen hecho por la IA | Sí | Sí | ⚠️ El IDE arma el resumen con tus pedidos, los planes y sus resultados, nunca con texto de la IA, para que nadie pueda colar instrucciones |

## Mientras la IA trabaja

| Función | Claude Code | Codex | Chat Harness |
|---|---|---|---|
| Lista de tareas de la IA, tachando lo hecho | Sí | Sí | ✅ «Plan del agente» |
| Ver cada paso (archivos leídos, comandos) | Sí | Sí | ✅ |
| La IA te hace preguntas con opciones | Sí | Sí | ✅ |
| Pedir permiso antes de acciones sensibles | Sí | Sí | ✅ Una vez, esta tarea, esta sesión, siempre o denegar, con el riesgo explicado |
| Piso de seguridad que ningún permiso saltea | Parcial | Parcial | ✅ Nada fuera del proyecto, credenciales protegidas, sin push a ramas protegidas |

## Después de cada cambio

| Función | Claude Code | Codex | Chat Harness |
|---|---|---|---|
| Ver el cambio de cada archivo dentro del chat | Sí | Sí | ✅ «Mostrar cambios» |
| Abrir la comparación completa en el editor | Sí | Sí | ✅ «Abrir en el editor» |
| Revertir un archivo o toda la tarea | Sí | Sí | ✅ «Revertir» y `/deshacer` |
| Puntos de restauración por herramienta | Sí | Parcial | ✅ «Puntos de restauración» |
| Correr tests, lint y tipos solo, y corregir lo que falla | No | No | ✅ Hasta 2 correcciones automáticas |
| Decir si el cambio quedó comprobado | No | No | ✅ «Verificada», «Aplicada sin verificar», «Fallida» |

## Lo que todavía falta

| Función | Claude Code | Codex | Chat Harness |
|---|---|---|---|
| Varias conversaciones trabajando a la vez en el mismo proyecto | Sí | Sí | ❌ Hay una conversación activa por proyecto. Se puede cambiar entre conversaciones guardadas, pero no tener dos trabajando al mismo tiempo: hoy el IDE deja un solo escritor por proyecto para que dos agentes no editen los mismos archivos a la vez. Para hacerlo bien hace falta coordinar qué conversación escribe y cuál solo lee. |

## Mejoras futuras

### Dictado propio, sin internet

En Windows, el botón del **micrófono**, al lado de **Enviar**, abre el dictado de Windows (lo mismo que **Win+H**) y escribe en el cuadro lo que decís. La mejora futura es un dictado propio del IDE, como proyecto aparte:

- **Qué es:** sumar un motor libre de voz a texto (por ejemplo, Whisper) que corra en tu computadora, sin mandar la voz a internet.
- **Ventajas:** funcionaría en Windows y Linux, y también en el chat integrado del IDE, porque se conectaría al servicio de voz que el IDE ya trae.
- **Costo:** suma una descarga de unos 75 a 150 MB y bastante más trabajo.
- **Por qué no usamos «VS Code Speech»:** su licencia permite usarla solo con productos de Microsoft y prohíbe distribuirla, y no está en Open VSX.

## Qué está probado

- Claude Code con sesión nativa: probado de punta a punta con el proveedor real.
- Codex con sesión nativa: probado con un simulador fiel al protocolo; falta la prueba con el proveedor real.
- La interfaz del chat: probada en un navegador real, con tema claro, oscuro y de alto contraste.
