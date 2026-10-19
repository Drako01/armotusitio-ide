# ArmoTuSitio IDE — Código fuente y guía de Windows 11

> **Estado:** distribución experimental basada en **Code - OSS**. El tema ArmoTuSitio y varias integraciones están en desarrollo. **No existe todavía un instalador oficial validado de ArmoTuSitio IDE.** La compilación puede producir una aplicación Code - OSS sin branding completo. Este documento diferencia desarrollo, carpeta portable y un instalador de Windows.

Repositorio: [Drako01/vscode](https://github.com/Drako01/vscode) · Base upstream: [microsoft/vscode](https://github.com/microsoft/vscode) · Licencia del código original: [MIT](LICENSE.txt).

## Qué incluye actualmente

- Tema **ArmoTuSitio Dark** y **ArmoTuSitio Light**, con colores tomados de ArmoTuSitio.
- Extensión experimental en `extensions/armotusitio-ide` con perfiles para `Drako01/armotusitio2.0` y `Drako01/redevent`.
- Acciones de harness disponibles según los scripts presentes en cada proyecto, revisión de planes, tareas y cancelación.
- Herramientas de contexto, Git/worktrees, GitHub mediante `gh`, apertura de n8n y ejecución autorizada de CLI de Claude/Codex.

**Limitación importante:** la presencia de una extensión en `extensions/` **no prueba por sí sola que esté incluida y activada en el build de escritorio**. Debe verificarse en el entorno de desarrollo y en el empaquetado. El centro multiagente completo, actualizador de distribución, instalador personalizado y otras funcionalidades del roadmap siguen pendientes.

## 1. Requisitos para Windows 11 x64

Instalá antes de compilar:

1. **Git for Windows** y PowerShell 7 o Windows PowerShell.
2. **Node.js 24.18.0**, versión fijada actualmente en `.nvmrc` (comprobala nuevamente cuando cambie upstream). No uses una versión de Node distinta de la solicitada por el checkout.
3. **Python 3**, accesible desde terminal, para `node-gyp`.
4. **Visual Studio 2022 Build Tools** o Visual Studio Community, con **Desktop development with C++**, Windows SDK, MSVC C++ x64/x86 y bibliotecas Spectre-mitigated requeridas por la compilación nativa. Si `node-gyp` reclama componentes ATL/MFC/Spectre, agregalos mediante Visual Studio Installer.
5. Espacio libre suficiente y memoria para compilar un monorepo grande. Como referencia, reservá al menos 8 GB RAM, preferiblemente más, y varias decenas de GB libres. No es un mínimo oficial garantizado.

Usá **PowerShell** para los comandos siguientes. Cloná en una ruta corta **sin espacios**, por ejemplo `C:\\dev\\vscode`.

Comprobá herramientas:

```powershell
git --version
node --version
npm --version
python --version
```

La guía oficial de compilación y los requisitos actualizados están en [How to Contribute — VS Code](https://github.com/microsoft/vscode/wiki/How-to-Contribute).

## 2. Descargar la rama con las personalizaciones

```powershell
New-Item -ItemType Directory -Force C:\dev | Out-Null
cd C:\dev
git clone https://github.com/Drako01/vscode.git
cd vscode
git fetch origin
git switch feat/ats-ide-platform-v1
git pull --ff-only origin feat/ats-ide-platform-v1
git status --short
Get-Content .nvmrc
```

**Importante:** hasta que el PR se fusione, `main` no contendrá los últimos cambios del IDE. Si tu clon ya existe, ejecutá solo `git fetch`, `git switch` y `git pull`.

La carpeta `vscode` es el editor que estamos compilando. Para usar los dos proyectos, conservá clones separados de `armotusitio2.0` y `redevent`, con sus dependencias y entornos configurados.

## 3. Instalar dependencias del código fuente

Este checkout utiliza **npm**, no `pnpm install` ni Yarn para compilar el núcleo de Code - OSS.

```powershell
npm install
```

El paso descarga dependencias y compila módulos nativos; requiere conexión y puede fallar si falta el toolchain C++. No cambies versiones del lockfile solo para solucionar un error de instalación sin investigar su causa.

Para comprobar la extensión propia:

```powershell
npm run check --prefix extensions/armotusitio-ide
npm test --prefix extensions/armotusitio-ide
```

Estas pruebas son parciales: **no equivalen** a compilar ni probar todo VS Code.

## 4. Ejecutar una versión de desarrollo (sin instalar)

Abrí una terminal PowerShell en la raíz y ejecutá:

```powershell
npm run watch
```

Mantenela abierta hasta que finalice la compilación inicial. En otra terminal PowerShell, desde la misma carpeta:

```powershell
.\scripts\code.bat
```

Se abrirá la aplicación **Code - OSS en modo desarrollo**. Esto **no es un instalador**.

En la aplicación, abrí la paleta de comandos con `Ctrl+Shift+P`, elegí **Preferences: Color Theme** y buscá `ArmoTuSitio Dark` o `ArmoTuSitio Light`. Si no aparecen, verificá que la extensión ArmoTuSitio esté efectivamente compilada, cargada y habilitada; no asumas que se incorporó automáticamente al bundle.

Probá abriendo una carpeta de cada proyecto y comprobá sus comandos disponibles. Para acciones locales es necesario confiar explícitamente en el workspace.

## 5. Generar un ejecutable de Windows (carpeta distribuible)

Cerrá el proceso `watch` o utilizá otra consola desde la raíz del checkout. Ejecutá el empaquetado x64:

```powershell
npm run gulp vscode-win32-x64
```

Para un paquete minificado, si ese target está disponible en la revisión que usás:

```powershell
npm run gulp vscode-win32-x64-min
```

Estos son **targets de empaquetado de Code - OSS**, basados en la documentación upstream. Puede requerirse configuración adicional o correcciones del fork. Buscá el directorio generado y el `.exe` real:

```powershell
Get-ChildItem -Directory -Path .. | Where-Object Name -Match 'VSCode|vscode|Code'
Get-ChildItem -Path .. -Filter *.exe -Recurse -ErrorAction SilentlyContinue |
  Where-Object FullName -Match 'VSCode|vscode|Code' |
  Select-Object -First 20 FullName
```

**No hay una ruta ni nombre de ejecutable garantizados** hasta verificar una compilación exitosa. Para ejecutar la versión empaquetada, abrí el `.exe` que esté dentro de la carpeta de salida; conservá los archivos y subcarpetas que lo acompañan.

### ¿Cómo instalarlo en Windows 11?

Una **carpeta empaquetada con ejecutable** no es lo mismo que un **Setup.exe / MSI**. Si obtenés una carpeta ejecutable, podés utilizarla de manera local (o copiarla completa a otra ruta), pero no tendrá necesariamente instalador, registro de desinstalación, asociaciones de archivos ni actualizador.

Para crear un instalador propiamente dicho hacen falta tareas y configuraciones adicionales de empaquetado Windows, identidad propia de aplicación, iconos, licencia, mecanismos de actualización y, para distribución confiable, firma de código. **Esos pasos todavía no están implementados ni verificados en esta rama. No renombres simplemente un `.exe` para presentarlo como instalador.**

## 6. Extensión ArmoTuSitio y proyectos compatibles

Para utilizar los comandos de harness, abrí la carpeta raíz de cada proyecto:

- **ArmoTuSitio 2.0:** `package.json` con nombre `armotusitio-next` y directorio `harness/`.
- **RedEvent:** `package.json` con nombre `redevent` y directorio `.harness/`.

Cada proyecto administra **su propia versión de pnpm** y su propio harness. La compilación del editor utiliza npm, pero los comandos de los proyectos pueden utilizar pnpm.

Funciones opcionales:
- CLI `gh` autenticada para consultas de PRs y workflows.
- CLI `codex` y/o `claude` instalada y autenticada.
- n8n local en `http://127.0.0.1:5678` o la URL que configures.
- Python, Go, PHP, PostgreSQL o MySQL según el proyecto abierto.

No almacenes claves de API, tokens ni contraseñas en `settings.json` versionado ni en el repositorio.

## 7. Problemas frecuentes

| Síntoma | Qué revisar |
| --- | --- |
| `npm install` falla en `node-gyp` | Versión Node, Python, Build Tools, Windows SDK y librerías Spectre |
| Error de módulos Electron | Ejecutá primero `npm install` y `npm run watch` |
| `code.bat` no inicia | Revisa logs de `preLaunch`, compilación y dependencias |
| No aparecen los temas ArmoTuSitio | La extensión puede no estar integrada al bundle; verificá carga/compilación |
| No aparece el harness | Abrí la raíz del proyecto correcto y comprobá `package.json` y carpeta harness |
| `pnpm` no encontrado | Instalá/habilitá la versión solicitada por ese proyecto |
| `gh`, `codex` o `claude` no encontrado | Instalá y autenticá la CLI correspondiente |
| No encuentro `Setup.exe` | La tarea descrita genera una aplicación empaquetada, no asegura instalador |
| Fallan tests del IDE | Guardá los logs y revisá los errores antes de hacer merge |

Para diagnósticos reproducibles adjuntá versión de Windows, Node, Python, las primeras líneas relevantes del error y el comando exacto que lo produjo. Evitá publicar secretos en logs.

## 8. Actualizaciones y mantenimiento del fork

El remoto `origin` apunta a tu fork. Para consultar el proyecto oficial:

```powershell
git remote add upstream https://github.com/microsoft/vscode.git
git fetch upstream
```

No hagas `git merge upstream/main` directamente en `main` sin revisión: primero abrí una rama de sincronización, compará cambios, resolvé conflictos y ejecutá pruebas. El mecanismo automatizado de actualización de binarios **no está terminado**.

## 9. Estado de calidad y contribuciones

Los cambios están en `feat/ats-ide-platform-v1`. Revisá además [la documentación de entrega](docs/armotusitio-ide/DELIVERY.md) para conocer los límites y los requisitos pendientes.

Código fuente original de VS Code: [microsoft/vscode](https://github.com/microsoft/vscode). Visual Studio Code oficial incluye componentes, servicios y condiciones de distribución propios de Microsoft; este fork no adquiere automáticamente derechos sobre ellos ni sobre el Visual Studio Marketplace.

Para detalles técnicos del proyecto base: [CONTRIBUTING.md](CONTRIBUTING.md) y [guía upstream](https://github.com/microsoft/vscode/wiki/How-to-Contribute).
