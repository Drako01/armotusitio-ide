# 5. Configuración

[← Anterior: Chat Harness](04-chat-harness.md) · [Índice](../../README.md#índice) · [Siguiente: Desarrollo →](06-desarrollo.md)

Abrí los ajustes con `Ctrl+,` y buscá `atsHarness`. Los ajustes de IA y permisos son **preferencias de usuario**: un repositorio no puede cambiarlos por vos.

## Los más importantes

| Ajuste | Valor predeterminado | Para qué sirve |
|---|---|---|
| `atsHarness.chatMode` | `act` | `act` (Actuar) o `ask` (Preguntar). |
| `atsHarness.agentTransport` | `structured` | `native` mantiene una sesión persistente del proveedor; `auto` la usa cuando la versión instalada es compatible. |
| `atsHarness.permissionsPreset` | `dev` | Perfil base de permisos: `readonly`, `dev` o `trusted`. |
| `atsHarness.claudeModel` / `atsHarness.codexModel` | vacío | Modelo de cada proveedor. Vacío usa el predeterminado del CLI. |
| `atsHarness.claudeEffort` / `atsHarness.codexEffort` | vacío | Nivel de razonamiento. |
| `atsHarness.codexSandbox` | `workspace-write` | Sandbox de Codex al editar. El interruptor **Acceso total** del chat lo cambia. |
| `atsHarness.protectedBranches` | `[]` | Ramas extra a las que la IA no puede hacer push (por ejemplo `release/*`). |
| `atsHarness.agentCommands.allow` | `[]` | Comandos extra que la IA puede ejecutar, como `make test`. |
| `atsHarness.nodeExecutable` | vacío | Ruta de Node.js. Vacío lo detecta solo. |

## Límites de uso (opcionales)

| Ajuste | Qué limita |
|---|---|
| `atsHarness.providerCallsPer24h` | Llamadas por proveedor y proyecto en 24 horas. |
| `atsHarness.providerTokensPer24h` | Tokens informados por el proveedor en 24 horas. |
| `atsHarness.providerCostUsdPer24h` | Costo estimado informado por el proveedor en 24 horas. |

En todos, `0` significa sin límite.

## Integraciones

| Ajuste | Para qué sirve |
|---|---|
| `atsHarness.mcp.enabled` | Conecta Work Management. La clave se carga con **ArmotuSitio: Configurar clave MCP**; nunca la pegues en archivos ni en el chat. |
| `atsHarness.notifyWebhook` | Webhook https para recibir avisos en el celular. |
| `atsHarness.otlpEndpoint` | Exporta trazas a un colector OpenTelemetry. |
| `atsHarness.n8nUrl` | Dirección de tu panel de n8n. |

La lista completa, con su descripción, aparece en la pantalla de ajustes.
