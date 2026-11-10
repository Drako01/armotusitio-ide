<p align="center">
  <img src="extensions/armotusitio-ide/resources/logo.png" alt="ArmoTuSitio IDE" width="124" height="124">
</p>

<h1 align="center">ArmoTuSitio IDE</h1>

<p align="center">
  Editor basado en Code - OSS, con Chat Harness y agentes Claude Code / Codex
  sujetos a permisos explícitos y verificaciones del proyecto.
</p>

<p align="center">
  <a href="https://github.com/Drako01/armotusitio-ide/releases/latest">Releases</a> ·
  <a href="docs/guia/02-instalacion.md">Instalación</a> ·
  <a href="docs/guia/04-chat-harness.md">Guía del chat</a> ·
  <a href="docs/CHAT_HARNESS_UPGRADE_PROGRESS.md">Evidencia de desarrollo</a>
</p>

**Autor:** Alejandro Daniel Di Stefano — [ArmoTuSitio.com.ar](https://armotusitio.com.ar).
Este fork conserva los avisos y la licencia MIT de [Microsoft Code - OSS](https://github.com/microsoft/vscode).

## Inicio rápido

1. Instalá la versión publicada desde [Releases](https://github.com/Drako01/armotusitio-ide/releases/latest).
2. Instalá e iniciá sesión en **Codex CLI** o **Claude Code** de forma local.
   El IDE no ofrece credenciales ni ejecuta proveedores sin tu acción.
3. Abrí una carpeta confiable y ejecutá **ArmoTuSitio: Chat Harness**
   desde `Ctrl+Shift+P`. También podés usar el panel lateral o `@harness`.

La rama de trabajo del [PR #86](https://github.com/Drako01/armotusitio-ide/pull/86)
incorpora el upgrade de Code - OSS a 1.145.3 y el alcance resumido abajo.
**Es código en revisión, no una release instalada ni evidencia de aprobación.**

## Chat Harness: funciones y límites

| Área | Capacidad incorporada al PR #86 | Verificación pendiente |
|---|---|---|
| Conversación | Chat central, lateral y `@harness` con permisos/sesiones compartidos | Candidato instalado y accesibilidad |
| Contexto | Referencias de archivo, selección, símbolo, diagnósticos, carpeta y diff | Pruebas UX instaladas |
| Imágenes | Adjuntar, pegar y arrastrar PNG/JPEG; vista previa y consentimiento | E2E de interfaz y proveedor |
| Documentos | `/documento` opt-in: texto de PDF/notebook en worker acotado | CI Linux/Windows y VSIX instalado |
| MCP | Stdio, HTTP JSON/SSE y legacy SSE; credenciales en host | Contratos y ciclo completo |
| Subagentes | Roles Claude aislados y subagentes Codex opt-in, máximo dos, solo lectura | Cuota, medición integral y cancelación E2E |
| Checkpoints | Deshacer por corrida/archivo y checkpoints limitados por herramienta | Integridad, pruebas y recuperación instalada |
| Extensiones | Sección ArmoTuSitio con seis extensiones del ecosistema | Activación real de las seis en IDE instalado |

Las nuevas funciones usan controles de confianza, límites de tamaño/tiempo y
denegación por defecto. **La salida de una IA o de un MCP no concede permisos.**
El consentimento de cada archivo y de cada acción sensible no se reutiliza
implícitamente. Los proveedores, herramientas, configuraciones y licencias del
upstream permanecen separados del branding propio.

### Subagentes nativos Codex

Desde **Ejecutar agente IA con autorización**, elegí Codex con rol `planner`
o `reviewer` y activá explícitamente la delegación. El valor predeterminado
es no crear hijos. Se configuran como máximo dos hilos hijos, profundidad uno
y ejecución de solo lectura. Con límite diario de llamadas se reservan hasta
tres invocaciones (padre + hijos); con presupuesto rígido de tokens/USD
la delegación se bloquea hasta disponer de contabilidad auditable por hijo.

La ejecución con proveedor autenticado **consume cuota** y no se lanzó en
esta auditoría. El comportamiento real depende también de la versión del CLI.

### Checkpoints y recuperación

Después de herramientas secuenciales que producen cambios medibles, el IDE
puede conservar hasta 24 snapshots privados, con límites de archivos y bytes.
**ArmoTuSitio: Restaurar checkpoint de herramienta del Chat Harness** permite
revisarlos y restaurar bajo confirmación, fence de escritura y comparación de
huellas. Si un humano editó el resultado o los eventos son ambiguos/concurrentes,
no se aplica una restauración automática. Para descartar una corrida completa
seguís teniendo `/deshacer`.

### Documentos, imágenes y MCP

`/documento` exige habilitar `atsHarness.documentInput`, seleccionar un
archivo del proyecto y confirmar su envío después de la vista previa.
Los notebooks aportan solo código/Markdown fuente; no se incluyen outputs,
metadatos ni adjuntos. Los PDF se procesan sin renderizar ni llamar a servicios.

Los servidores MCP se gestionan mediante permisos del IDE y sus credenciales
no se pasan al modelo. El transporte HTTP y el legacy SSE prohíben redirects,
limitan los datos y rechazan solicitudes privilegiadas iniciadas por el servidor.

## Documentación

| Guía | Contenido |
|---|---|
| [Introducción](docs/guia/01-que-es.md) | Producto, alcance y principios |
| [Instalación](docs/guia/02-instalacion.md) | Plataformas, actualizaciones |
| [Primeros pasos](docs/guia/03-primeros-pasos.md) | Primer proyecto y verificación |
| [Chat Harness](docs/guia/04-chat-harness.md) | Modos, permisos y comandos |
| [Configuración](docs/guia/05-configuracion.md) | Preferencias y seguridad |
| [Desarrollo](docs/guia/06-desarrollo.md) | Build, tests y tooling |
| [Releases](docs/guia/07-releases.md) | Publicación protegida |
| [Referencia de la extensión](extensions/armotusitio-ide/README.md) | API, integración y comandos |
| [Checklist PR #86](docs/CHAT_HARNESS_UPGRADE_PROGRESS.md) | Evidencia por commit y pendientes |
| [Capturas de aceptación](docs/PR86_SCREENSHOT_CAPTURE.md) | Matriz para capturas reales del candidato |

## Verificación del upgrade en la rama del PR

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm ci --prefix extensions/armotusitio-ide --ignore-scripts --omit=optional --no-audit --no-fund
npm run check --prefix extensions/armotusitio-ide
npm test --prefix extensions/armotusitio-ide
npm run compile --prefix extensions/armotusitio-ide
npm run check:native-package --prefix extensions/armotusitio-ide
npm run precommit
```

Estos son **comandos para verificar**, no resultados ya aprobados.
Consultar los workflows de Linux/Windows y el checklist del **SHA final**
antes de levantar Draft o realizar el merge.

## Evidencia visual

No se incorporaron capturas sintéticas. Las capturas definitivas de
interfaz, consentimientos, accesibilidad, MCP y las seis extensiones
deben provenir de un **IDE instalado y verificable**, conforme al
[protocolo de capturas](docs/PR86_SCREENSHOT_CAPTURE.md).
Se agregarán a esta sección únicamente tras inspeccionar su procedencia
y anonimizar credenciales y rutas.

## Licencia y atribución

[MIT](LICENSE.txt). Code - OSS y los componentes de terceros mantienen
sus licencias y atribuciones. ArmoTuSitio IDE: Alejandro Daniel Di Stefano —
[ArmoTuSitio.com.ar](https://armotusitio.com.ar).
