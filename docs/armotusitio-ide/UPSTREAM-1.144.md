# Integración de VS Code 1.144.0

Análisis del 29 de octubre de 2026. Base anterior: `1.143.1`; nueva base: `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`. Referencia: [notas oficiales de VS Code 1.144](https://code.visualstudio.com/updates/v1_144).

## Alcance

Se integra el código estable de Microsoft y se conservan las personalizaciones de ArmotuSitio.

Un commit anterior de personalización también contenía cambios internos de Microsoft.

Los conflictos de esos archivos se resuelven con el código de la nueva etiqueta estable.

Los cambios propios se identifican por el historial y se revisan por separado.

| Área | Resultado |
| --- | --- |
| Editor, terminal, diffs y Markdown | Se incorpora la implementación estable nueva. |
| Sesiones y Agent Host | Se incorpora el código nuevo, respetando sus opciones experimentales y requisitos de proveedor. |
| Copilot y servicios conectados | Se incorpora el código disponible en el repositorio; su disponibilidad requiere servicios, autenticación y políticas compatibles. |
| Electron y dependencias | Electron `43.8.3`; Node de desarrollo según `.nvmrc`: `24.22.1`. |
| Harness propio | Se conserva íntegra `extensions/armotusitio-ide`, incluidos sus temas, MCP y controles nativos. |
| Identidad e instalación | Se conservan nombres, identificadores, carpetas de datos, recursos e instalador de ArmotuSitio. |
| Extensiones y WSL | Se conservan Open VSX, su verificación de firmas y la distribución propia de servidores Linux. |
| Actualización | Se conserva el feed propio y la clave pública; se prepara `ats-v1.144.0-r1`. |

## Revisiones por versión

`release.sh` calcula la revisión dentro de cada versión base: la primera publicación de `1.144.0` es `r1`.

El actualizador compara primero la versión base; exige una revisión mayor cuando la versión base coincide.

Sigue rechazando versiones anteriores, revisiones repetidas, firmas inválidas y artefactos alterados.

Las instalaciones anteriores, como `1.143.1-r5`, conservan un actualizador que exige revisiones globalmente crecientes.

No pueden recibir automáticamente `1.144.0-r1`: el primer salto requiere ejecutar manualmente el instalador propio.

Otra opción es publicar primero una versión puente de la base anterior con el comparador corregido.

Esta integración no publica ninguna de esas versiones.

## Verificación y release

La evidencia local se guarda en `.build/upstream-1.144-*.log`.

Se verifican Harness, tipos, distribución, firmas, revisiones, empaquetado y posición de las acciones de Markdown.

- Harness: 90 pruebas aprobadas; tipos y bundle de la extensión aprobados.
- Distribución, actualizador, release y empaquetado: 47 pruebas aprobadas.
- Electron 43.8.3: 41 pruebas focalizadas del actualizador aprobadas.
- Tipos del cliente y herramientas de build, compilación de desarrollo y ESLint focalizado: aprobados.
- Higiene completa: 14.085 archivos comprobados; calidad Markdown de los dos documentos: aprobada.

El chequeo general debe ejecutarse con las dependencias nuevas instaladas.

Los errores obtenidos con dependencias anteriores no constituyen validación de esta base.

El build final, las pruebas del instalador, la aceptación visual y la publicación quedan a cargo del usuario.

Antes de publicar, ejecutar `./release.sh --plan` desde Git Bash con Node compatible con `.nvmrc`.

Se requiere Docker disponible y `main` limpio y sincronizado.

`./release.sh --no-publish` permite generar y probar los artefactos antes de publicarlos.

GitHub Actions debe permanecer deshabilitado durante toda la integración.

No se habilitan workflows, no se despachan ejecuciones y no se publica un release durante esta integración.
