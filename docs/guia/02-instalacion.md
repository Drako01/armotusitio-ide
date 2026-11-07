# 2. Instalación y actualizaciones

[← Anterior: Qué es](01-que-es.md) · [Índice](../../README.md#índice) · [Siguiente: Primeros pasos →](03-primeros-pasos.md)

## Descargar

Todas las versiones están en la página de [Releases](https://github.com/Drako01/armotusitio-ide/releases/latest). Cada versión se llama `ats-v<versión>-r<revisión>`, por ejemplo `ats-v1.145.2-r2`.

| Sistema | Archivo | Cómo instalar |
|---|---|---|
| Windows x64 | `ArmotuSitio-IDE-Setup-<versión>-x64.exe` | Doble clic y seguí el asistente. No necesita permisos de administrador. |
| Windows x64 (portable) | `ArmotuSitio-IDE-<versión>-win32-x64.zip` | Descomprimí y ejecutá el `.exe` de la carpeta. |
| Linux x64 (Debian/Ubuntu) | `.deb` | `sudo apt install ./archivo.deb` |
| Linux x64 (Fedora/RHEL) | `.rpm` | `sudo dnf install ./archivo.rpm` |
| Linux x64 | `.tar.gz` | Descomprimí y ejecutá el binario. |

Windows puede mostrar un aviso de SmartScreen porque el instalador no tiene firma de código de Windows. Las actualizaciones, en cambio, sí se verifican con la firma propia del proyecto (ver abajo).

## Requisitos para usar la IA

El chat necesita al menos uno de estos CLI, instalado en la misma máquina y con la sesión iniciada:

- [Claude Code](https://docs.claude.com/en/docs/claude-code): `npm install -g @anthropic-ai/claude-code` y después `claude` para iniciar sesión.
- [Codex](https://github.com/openai/codex): `npm install -g @openai/codex` y después `codex login`.

También necesitás **Node.js** (el IDE lo detecta solo; si tenés varios, elegí uno con **ArmotuSitio: Seleccionar Node.js**) y **git**.

## Actualizaciones

- **Windows**: el IDE consulta la última release, verifica el manifiesto firmado y te ofrece instalar la nueva versión. Nunca baja a una versión anterior.
- **Linux**: el IDE avisa que hay una versión nueva y abre la página de descargas. La instalación la hace tu gestor de paquetes.

## WSL y servidores remotos

Cada release incluye el servidor para Linux x64 y arm64, que el IDE usa al conectarse a WSL. Los detalles están en [WSL y Linux](../ATS-WSL-LINUX.md).
