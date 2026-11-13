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
incorpora el upgrade de Code - OSS a 1.146.0 y el alcance resumido abajo.
**Es código en revisión, no una release instalada ni evidencia de aprobación.**

## Chat Harness: funciones y límites

| Área | Capacidad incorporada al PR #86 | Verificación pendiente |
|---|---|---|
| Conversación | Chat central, lateral y `@harness` con permisos/sesiones compartidos | Candidato instalado y accesibilidad |
| Contexto | Referencias de archivo, selección, símbolo, diagnósticos, carpeta y diff | Pruebas UX instaladas |
| Imágenes | Adjuntar, pegar y arrastrar PNG/JPEG; vista previa y consentimiento | E2E de interfaz y proveedor |
| Documentos | `/documento` opt-in: texto de PDF/notebook en worker acotado | CI Linux/Windows y VSIX instalado |
| MCP | Stdio, HTTP JSON/SSE y legacy SSE; credenciales en host | Contratos y ciclo completo |
| Subagentes | Roles Claude aislados y subagentes Codex opt-in: apagados explícitamente por defecto, dos simultáneos, cuatro por turno, profundidad uno, solo lectura | Proveedor autenticado (requiere cuota) e IDE instalado |
| Checkpoints | Deshacer por corrida/archivo y checkpoints por turno y herramienta, con restauración reanudable; `/checkpoints` los lista y restaura desde el chat | Recuperación en IDE instalado |
| Extensiones | Sección ArmoTuSitio con siete extensiones del ecosistema | Activación real de las siete en IDE instalado |
| Codex CLI | Compatibilidad por rango (0.166.0 a 0.169.0 validados; versiones más nuevas siguen en transporte nativo con aviso), política `on-request`, aprobaciones `humanCommand` de decisión única y errores tipados con próximo paso | Proveedor autenticado (requiere cuota) |
| Objetivos | `/objetivos` muestra los objetivos autónomos de la ventana y permite pausarlos o detenerlos | IDE instalado |

Las nuevas funciones usan controles de confianza, límites de tamaño/tiempo y
denegación por defecto. **La salida de una IA o de un MCP no concede permisos.**
El consentimento de cada archivo y de cada acción sensible no se reutiliza
implícitamente. Los proveedores, herramientas, configuraciones y licencias del
upstream permanecen separados del branding propio.

### Subagentes nativos Codex

Desde **Ejecutar agente IA con autorización**, elegí Codex con rol `planner`
o `reviewer` y activá explícitamente la delegación. El valor predeterminado
es no crear hijos. Se configuran como máximo dos hilos hijos **simultáneos**, profundidad uno
y ejecución de solo lectura. Si existe un límite diario de invocaciones o un
presupuesto rígido de tokens/USD, la delegación se **bloquea** hasta disponer
de contabilidad auditable por hijo. El límite simultáneo no equivale a un
límite acumulado de consumo.

Codex CLI trae sus subagentes **activados de fábrica**. Por eso el IDE los apaga
de forma explícita en cada ejecución (`features.multi_agent=false` y, desde la
versión 0.169 donde esa clave quedó en desuso, también `agents.enabled=false`) y
solo los enciende con tu opt-in. Cuando el servidor informa el consumo de cada
hilo hijo, `/costo` lo suma al turno como «Subagentes»; si no hay recibos, no se
estima nada y el presupuesto sigue bloqueado. Además vigila el flujo de eventos: si aparece un hijo sin
opt-in, un hijo que intenta delegar otra vez o más de **cuatro hijos en un turno**,
detiene el proceso completo del proveedor y la corrida se informa como fallida
(`HARNESS_DELEGATION_CHILD_UNEXPECTED`, `_DEPTH`, `_LIMIT`). Cambiar la búsqueda
web cierra las sesiones abiertas para que nunca convivan búsqueda e hijos.

Las claves de configuración se comprobaron contra **Codex CLI 0.166.0 y 0.169.0**
sin llamar al modelo. La ejecución con proveedor autenticado **consume cuota** y no
se lanzó: la herencia efectiva del sandbox en los hijos sigue sin evidencia real.

### Compatibilidad con Codex CLI

Los tipos del protocolo app-server se generan desde el CLI real (0.169.0). El IDE
acepta cualquier versión desde la 0.166.0: una más nueva que la validada sigue
usando el transporte nativo y lo avisa una vez; una más vieja cae al canal
estructurado y dice por qué. Los escritores usan la política de aprobación
`on-request` que documenta Codex (la antigua `untrusted` fue retirada), las
aprobaciones `humanCommand` se responden con una decisión única y los errores
del proveedor (contexto excedido, límite de uso, sesión vencida, servicio no
disponible, modelo inexistente, política) llegan con un código estable y el
próximo paso sugerido.

### Checkpoints y recuperación

Después de herramientas secuenciales que producen cambios medibles, el IDE
puede conservar hasta 24 snapshots privados, con límites de archivos y bytes.
**ArmoTuSitio: Restaurar checkpoint de herramienta del Chat Harness** permite
revisarlos y restaurar bajo confirmación, fence de escritura y comparación de
huellas. Cada registro indica el turno y el orden de la herramienta que lo produjo,
y la lista muestra primero los más recientes. Si un humano editó el resultado o
los eventos son ambiguos/concurrentes, no se aplica ninguna restauración. Si una
restauración se interrumpe, volver a confirmarla la **reanuda**: los archivos ya
restaurados se respetan y una edición humana posterior la bloquea entera. Desde el
chat, `/checkpoints` lista los mismos registros y `/checkpoints restaurar ID` usa
exactamente el mismo camino de confirmación y bloqueo. Para descartar una corrida
completa seguís teniendo `/deshacer`.

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
| [Upgrade Codex 0.169 y paridad](docs/CHAT_HARNESS_UPGRADE_2026-11.md) | Auditoría contra el CLI real, checklist maestro, evidencia y límites |
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

No se incorporaron capturas sintéticas ni mockups. Al 2026-11-10 los únicos
binarios disponibles en el equipo de desarrollo corresponden a la versión
anterior (IDE 1.145.2, commit `45d7e83`), por lo que **no hay capturas de este PR**.
Las capturas definitivas de interfaz, consentimientos, accesibilidad, MCP y las
siete extensiones deben provenir de un **IDE instalado y construido desde el SHA
final**, conforme al [protocolo de capturas](docs/PR86_SCREENSHOT_CAPTURE.md).
Se agregarán a esta sección únicamente tras inspeccionar su procedencia
y anonimizar credenciales y rutas.

## Licencia y atribución

[MIT](LICENSE.txt). Code - OSS y los componentes de terceros mantienen
sus licencias y atribuciones. ArmoTuSitio IDE: Alejandro Daniel Di Stefano —
[ArmoTuSitio.com.ar](https://armotusitio.com.ar).
