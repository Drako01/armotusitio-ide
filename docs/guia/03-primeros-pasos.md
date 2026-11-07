# 3. Primeros pasos

[← Anterior: Instalación](02-instalacion.md) · [Índice](../../README.md#índice) · [Siguiente: Chat Harness →](04-chat-harness.md)

Abrí la paleta de comandos con `Ctrl+Shift+P` (`Cmd+Shift+P` en macOS). Todos los comandos propios empiezan con **ArmotuSitio:**.

## 1. Revisá tu entorno

Ejecutá **ArmoTuSitio: Revisar mi entorno**. Detecta Node.js, git, Claude Code, Codex y Docker, y te dice cómo resolver lo que falte.

Para ver solo los proveedores de IA, usá **ArmoTuSitio: Diagnosticar Codex y Claude locales**. No gasta tokens.

## 2. Abrí tu proyecto

1. Ejecutá **ArmotuSitio: Inicio** (también se abre solo cuando no hay editores abiertos).
2. Elegí **Abrir un proyecto** y seleccioná la carpeta.
3. Si VS Code te pregunta si confiás en la carpeta, respondé que sí solo si es tu código. El chat y el Harness **no ejecutan nada en carpetas que no son de confianza**.

## 3. Elegí la IA

Ejecutá **ArmotuSitio: Elegir IA del Harness** y elegí Claude Code o Codex. Podés cambiarla cuando quieras desde la cabecera del chat.

## 4. Abrí el chat

Ejecutá **ArmotuSitio: Chat Harness** y escribí lo que necesitás, por ejemplo:

```text
Agregá validación de email al formulario de registro y corré los tests.
```

La IA te va a mostrar lo que hace en una línea de tiempo y te va a pedir permiso con una tarjeta cuando quiera hacer algo sensible. Seguí con [Chat Harness](04-chat-harness.md) para ver cómo funciona.

## Comandos más usados

| Comando | Qué hace |
|---|---|
| ArmotuSitio: Inicio | Pantalla de inicio con proyectos y tareas. |
| ArmotuSitio: Chat Harness | Abre el chat con la IA. |
| ArmoTuSitio: Revisar mi entorno | Diagnóstico de la máquina. |
| ArmoTuSitio: Gestionar permisos | Ver y editar tus reglas de permisos. |
| ArmoTuSitio: Ver cambios de una ejecución | Diff de lo que cambió la IA en una corrida. |
| ArmotuSitio: Historial del Harness | Tareas anteriores con su resultado. |
| ArmotuSitio: Configurar clave MCP | Guarda tu clave de Work Management de forma segura. |
