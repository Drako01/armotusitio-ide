# Distribución local de ArmotuSitio IDE para Windows

Esta distribución interna usa el núcleo Code - OSS 1.143.0 y la extensión propia de ArmotuSitio.
El alcance Enterprise AAA continúa pendiente según [el estado de entrega](DELIVERY.md).

## GitHub Actions

GitHub Actions está desactivado a nivel del repositorio `Drako01/vscode` por pedido del propietario.
Se verificó `enabled: false` mediante la API antes de preparar el push.
Los archivos YAML se conservan para futuras validaciones; no se renombran ni se eliminan sus controles.

Antes de un push, comprobá que Actions siga desactivado:

```powershell
gh api repos/Drako01/vscode/actions/permissions
```

Si devuelve `enabled: true`, detené el push y revisá la configuración del repositorio.
El marcador `[skip ci]` agrega protección; la barrera principal es desactivar Actions en el repositorio.
No vuelvas a habilitar Actions hasta que el propietario decida hacerlo.

## Generar los binarios localmente

Usá el entorno Windows x64 preparado para este checkout, con Node y las dependencias requeridas.
Las tareas oficiales pueden descargar componentes de build; no ejecutan GitHub Actions.
Su salida principal es `../VSCode-win32-x64`, fuera de la carpeta del checkout.

```powershell
node --experimental-strip-types --max-old-space-size=8192 node_modules/gulp/bin/gulp.js vscode-win32-x64
node --experimental-strip-types --max-old-space-size=8192 node_modules/gulp/bin/gulp.js vscode-win32-x64-user-setup
```

La primera tarea genera la aplicación completa; la segunda crea un instalador por usuario con Inno Setup.
El instalador se escribe en `.build/win32-x64/user-setup`.
La aplicación necesita sus DLL y su carpeta `resources`: no alcanza con compartir únicamente el `.exe`.
Para compartir sin instalar, comprimí la carpeta completa generada.

## Contenido y configuración de cada compañero

Se incluyen las extensiones incorporadas por el build de Code - OSS y la extensión propia `armotusitio-ide`.
Las extensiones personales no se incorporan al instalador; cada compañero debe instalarlas según sus permisos de uso.
El [perfil enfocado](extensions.focused.json) conserva los 18 identificadores elegidos para PHP, Next.js y Go.
El [inventario original](extensions.snapshot.json) permite recuperar otras extensiones más adelante.

Cada compañero inicia sus propias sesiones de GitHub, Codex, Claude y otras integraciones.
Los proyectos y sus runtimes siguen siendo necesarios: Git, Node/pnpm y PHP o Go, según el proyecto abierto.
La distribución no incorpora bases de datos ni los repositorios de trabajo.

## Firma y alcance de validación

Los artefactos locales no están firmados con un certificado de distribución de ArmotuSitio.
Windows puede mostrar un aviso de editor desconocido; verificá el SHA-256 antes de compartir o instalar.
Las pruebas de arranque y empaquetado no sustituyen una certificación Enterprise ni pruebas de todas las integraciones.
El resultado de las comprobaciones ejecutadas se registra en [el estado de entrega](DELIVERY.md).
