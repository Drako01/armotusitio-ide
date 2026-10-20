# ArmotuSitio IDE: implementación y evidencia local

## Alcance de esta mejora

Las mejoras se desarrollaron localmente sobre `main`. El propietario autorizó luego el push y el empaquetado local.

Actions quedó desactivado en `Drako01/vscode` antes del push; no se abre PR ni se ejecutan workflows.
Se conservaron los archivos `pnpm-lock.yaml` y `pnpm-workspace.yaml` que ya estaban sin seguimiento.
No se modificaron los repositorios de ArmotuSitio 2.0 ni RedEvent.

## Implementación y comprobaciones

| Requisito | Implementación actual | Validación y evidencia |
| --- | --- | --- |
| Identidad real | PNG originales para inicio, Windows y Linux; trazos del SVG oficial para la barra lateral | Inspección visual contra los assets de ArmotuSitio 2.0; captura local |
| Distribución independiente | Nombre, protocolo, carpetas, mutexes e identificadores de instalación en `product.json` | Revisión del diff; falta validar instalación y actualización |
| Inicio | Proyectos, comandos detectados, herramientas y tareas de la sesión | `test/home.test.cts`; render en Chromium |
| Temas | Dark/Light con controles secundarios y enlaces coherentes | Dark verificado visualmente; Light pendiente de comprobación visual |
| Harness | Adaptadores existentes, selección de acción y confirmación | `test/core.test.cts`, `test/controller.test.cts`; detección real de ambos repositorios |
| Ejecución y cancelación | Tareas nativas; estados de éxito, fallo, cancelación y salida desconocida | Pruebas del controlador con API simulada; sin ejecución E2E de procesos reales |
| Seguridad de interfaz | CSP restrictiva, mensajes con acciones permitidas, texto sin interpolar HTML | Tests del host; Chromium verifica texto no ejecutable y botones deshabilitados sin confianza |
| Worktrees | Consulta y creación mediante Git con confirmación | Contrato de referencias en `test/tools.test.cts`; sin E2E de creación |
| Contexto | Inventario acotado; exclusión de secretos y dependencias | `test/tools.test.cts`; no hay memoria semántica ni mapa de dependencias |
| Agentes y planes | CLI Codex/Claude; validación estructural de DAG | Tests de planes; sin orquestación, streaming, recuperación ni chat integrado |
| GitHub y n8n | Consultas de `gh` y apertura de dashboard configurado | Dispatch de GitHub probado; sin ejecución autenticada ni API n8n |
| Quality Guardian y bases de datos | No implementados como centros integrados | Pendiente; no confundir accesos al harness con estos módulos |
| Métricas y recuperación | Solo estados reales de tareas durante la sesión | Sin tokens, costos, checkpoints ni persistencia de ejecuciones |
| Upstream y release | Identificadores preparados | Sin pipeline propio, instalador firmado, rollback ni actualizador verificado |

## Evidencia ejecutada

```powershell
npm run check --prefix extensions/armotusitio-ide
npm test --prefix extensions/armotusitio-ide
```

Sintaxis correcta y nueve tests aprobados. Las pruebas de host/controlador usan una API VS Code simulada.
La comprobación local en Chromium utilizó el HTML, CSS y JavaScript reales del inicio y detectó ambos proyectos.
Verificó el logo original, el acceso a GitHub, el ancho móvil de 390 px, el modo restringido y el escape de texto.
No equivale a una prueba E2E dentro del editor.

La captura de desarrollo queda en `.build/ats-home-preview.png`, excluida del control de versiones.
Se revisaron los textos en español argentino del nuevo inicio.

## Recuperación de íconos

La fuente `codicon.ttf` existía en dependencias y fuentes, pero faltaba en el cliente generado `out`.
Se regeneró con `node build/next/build-fast.ts --client-only`, que finalizó con código cero.
La fuente recuperada tiene 153500 bytes y el mismo SHA-256 que el archivo de la dependencia.
Chromium cargó la fuente recuperada con estado `loaded`; captura local en `.build/ats-icons-check.png`.
La ventana del editor abierta por el usuario debe recargarse para usar el recurso restaurado.

El primer intento mediante npm no conservó `--client-only` e inició también extensiones y Copilot.
Las extensiones transpilaron; el build de Copilot falló con código 1.
No se considera aprobada una compilación completa del producto ni se diagnosticó ese fallo independiente.

## Bloqueos y pendientes

Windows bloqueó por antivirus el launcher `.agents/skills/launch/scripts/launch.ps1` al invocarlo.
El archivo también desapareció del árbol de trabajo durante el bloqueo; se dejó señalado sin desactivar la protección.
No se restauró ni se ejecutó una copia del script bloqueado.
El lanzamiento E2E del editor quedó pendiente. La regeneración del cliente está aprobada.

La compilación completa no pasó y no se creó un instalador.
Los recursos nuevos de Windows deben incorporarse al regenerar el ejecutable; la copia previa no prueba el ícono final.
La identidad de macOS está preparada, pero su iconografía y plataforma no están validadas.

El objetivo Enterprise AAA del documento de misión sigue incompleto en las áreas indicadas.
Esta mejora no certifica los módulos pendientes. El empaquetado interno se describe en [distribución](DISTRIBUTION.md).
