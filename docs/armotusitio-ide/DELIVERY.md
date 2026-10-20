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
| Distribución independiente | Nombre, protocolo, carpetas, mutexes e identificadores de instalación en `product.json` | Revisión del diff; arranque del binario con perfil vacío; actualización pendiente |
| Inicio | Proyectos, comandos detectados, herramientas y tareas de la sesión | `test/home.test.cts`; render en Chromium y apertura en el binario |
| Temas | Dark/Light con controles secundarios y enlaces coherentes | Dark verificado en el binario; Light pendiente de comprobación visual |
| Harness | Adaptadores existentes, selección de acción y confirmación | `test/core.test.cts`, `test/controller.test.cts`; detección real de ambos repositorios |
| Ejecución y cancelación | Tareas nativas; estados de éxito, fallo, cancelación y salida desconocida | Pruebas del controlador con API simulada; sin ejecución E2E de procesos reales |
| Seguridad de interfaz | CSP restrictiva, mensajes con acciones permitidas, texto sin interpolar HTML | Tests del host; Chromium verifica texto no ejecutable y botones deshabilitados sin confianza |
| Worktrees | Consulta y creación mediante Git con confirmación | Contrato de referencias en `test/tools.test.cts`; sin E2E de creación |
| Contexto | Inventario acotado; exclusión de secretos y dependencias | `test/tools.test.cts`; no hay memoria semántica ni mapa de dependencias |
| Agentes y planes | CLI Codex/Claude; validación estructural de DAG | Tests de planes; sin orquestación, streaming, recuperación ni chat integrado |
| GitHub y n8n | Consultas de `gh` y apertura de dashboard configurado | Dispatch de GitHub probado; sin ejecución autenticada ni API n8n |
| Quality Guardian y bases de datos | No implementados como centros integrados | Pendiente; no confundir accesos al harness con estos módulos |
| Métricas y recuperación | Solo estados reales de tareas durante la sesión | Sin tokens, costos, checkpoints ni persistencia de ejecuciones |
| Upstream y release | Identificadores preparados | Sin pipeline propio, firma, rollback ni actualizador verificado; empaquetado local disponible |

## Evidencia ejecutada

```powershell
npm run check --prefix extensions/armotusitio-ide
npm test --prefix extensions/armotusitio-ide
```

Sintaxis correcta y nueve tests aprobados. Las pruebas de host/controlador usan una API VS Code simulada.
La comprobación local en Chromium utilizó el HTML, CSS y JavaScript reales del inicio y detectó ambos proyectos.
Verificó el logo original, el acceso a GitHub, el ancho móvil de 390 px, el modo restringido y el escape de texto.
Esa primera prueba no equivalía a una prueba dentro del editor. Luego se ejecutó el smoke del binario descrito abajo.

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
Ese intento inicial falló; la compilación y el empaquetado posteriores se completaron como se detalla abajo.

## Distribución interna de Windows

El empaquetado local de la aplicación Windows x64 finalizó con código cero.
Se usaron los recursos ya compilados mediante la tarea local `vscode-win32-x64-ci`.
El sufijo de esa tarea no implica ejecución de GitHub Actions: todos los procesos corrieron en esta computadora.

La extensión propia se migró a TypeScript y usa el build de extensiones del repositorio.
Su typecheck, linter, nueve tests y hook de higiene pasan.
La detección asíncrona volvió a comprobar ambos proyectos reales.
Se conservó el SDK de Copilot en el paquete y se prepararon sus dependencias nativas compatibles con la versión fijada.
El comando de distribución detecta el Windows SDK instalado y prepara las herramientas de Inno Setup.

El binario abrió con un perfil de prueba vacío, sin copiar sesiones ni credenciales personales.
El smoke comprobó el renderer, la fuente `codicon`, la apertura del inicio desde la paleta y el logo original.
La captura `.build/ats-packaged-app.png` muestra también el logo real en la barra de título.
El logo de esa barra usa un recurso independiente, que se corrigió en `src/vs/workbench/browser/media/code-icon.svg`.

El instalador por usuario y el ZIP completo quedaron generados en `.build/releases`, fuera del control de versiones.

- `ArmotuSitio-IDE-Setup-1.143.0-x64.exe`: 284610597 bytes, compilación de Inno Setup con código cero.
- `ArmotuSitio-IDE-1.143.0-win32-x64.zip`: 469416694 bytes; recursos clave idénticos al binario probado.
- `SHA256SUMS.txt`: sumas de ambos archivos para comprobar su integridad.

La versión del binario es `1.143.0`, x64, con commit de fuentes `a315e1c43175ce2dd30c7fee87685dcd335dacaa`.
Ambos ejecutables carecen de firma digital. El paquete no contiene perfiles ni credenciales personales.
No hay `updateUrl` configurada: las actualizaciones de VS Code requieren integración y nueva distribución.
El proceso y las condiciones para compartirlos se describen en [distribución](DISTRIBUTION.md).
La instalación en una máquina limpia, la firma digital y el actualizador propio siguen pendientes.

## Alcance pendiente

El launcher auxiliar `.agents/skills/launch/scripts/launch.ps1` sigue bloqueado por Windows en este checkout.
Su desaparición local no se incorporó al commit; el smoke del binario usó una instancia temporal independiente.
Las plataformas Linux/macOS y las integraciones completas no fueron certificadas.

El objetivo Enterprise AAA del documento de misión sigue incompleto en las áreas indicadas.
Esta distribución interna no certifica esos módulos pendientes.
