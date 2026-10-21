# Distribución Windows, Linux y WSL

## Identidad de cada versión

El cliente y los servidores REH se compilan desde un único commit de Git.
`build/lib/armotusitioProduct.ts` aplica la configuración de `build/armotusitio/product-overrides.json`.
Coinciden versión, calidad, revisión, nombre y carpeta de datos del servidor.
Las herramientas usan el Node de `.nvmrc`; el runtime del REH usa el de `remote/.npmrc`.
Son versiones distintas y no deben sustituirse entre sí.

Cada publicación requiere aumentar `armotusitioUpdate.revision` antes de compilar.
El tag es `ats-vVERSION-rREVISION` y no puede reutilizarse para otro commit.
No se deben editar archivos, cambiar de rama ni mergear durante una compilación.

## Compilar

Desde Windows x64, con Docker Desktop en modo Linux y emulación ARM64 disponible:

```powershell
node scripts/ats-build-all.mts
```

Genera Windows x64 (instalador y ZIP), desarrollo para `code.bat`, Linux x64 y los dos servidores REH.
El entorno Linux es un contenedor Ubuntu 22.04; no comparte `node_modules` con Windows o WSL.
Compila primero REH x64 y el cliente x64; después REH arm64 en un contenedor arm64.
Las dependencias nativas de cada arquitectura se compilan dentro de su propio entorno.
Se comprueba la identidad y se ejecutan el Node del servidor y `bin/armotusitio-ide-server --help`.
El comando no publica releases, instala el IDE ni activa GitHub Actions.

Para regenerar solo Windows y `code.bat`, sin Docker:

```powershell
node scripts/ats-build-all.mts --windows-only
```

Para compilar Linux por separado desde Windows o Linux:

```powershell
node scripts/ats-build-linux.mts
node scripts/ats-build-linux.mts --arch x64
node scripts/ats-build-linux.mts --arch arm64
```

Los artefactos y recibos quedan en `.build/releases`.
Los clientes Linux incluyen `.deb`, `.rpm` y `.tar.gz`; el cliente arm64 queda fuera del alcance inicial.
Los tarballs REH contienen un solo directorio raíz con `bin/armotusitio-ide-server`, `node` y `product.json`.
Los nombres incluyen la arquitectura y el commit completo.

Las imágenes y volúmenes Docker tienen prefijos `armotusitio-build` y `ats-linux`.
Los volúmenes de trabajo están separados por arquitectura y commit; los caches de npm y ccache, por arquitectura.
No borres volúmenes de otros proyectos. Los volúmenes de commits antiguos se pueden retirar manualmente
cuando no haya builds activos y ya no sean necesarios.

## Open Remote WSL

Instalá `jeanp413.open-remote-wsl` desde Open VSX en el cliente Windows.
No se incorpora como built-in ni se instalan extensiones opcionales automáticamente.
El producto habilita sus propuestas `resolvers` y `contribViewsRemote`.

La extensión 0.0.5 lee `commit`, `quality`, `release`, `serverApplicationName`, `serverDataFolderName`
y `serverDownloadUrlTemplate` de `product.json`; obtiene la versión desde `vscode.version`.
Admite `${quality}`, `${version}`, `${commit}`, `${os}`, `${arch}` y `${release}` en la plantilla.
El ajuste `remote.WSL.serverDownloadUrlTemplate` tiene prioridad sobre el producto.
El servidor se instala en `~/.armotusitio-ide-server/bin/COMMIT`.
La extensión extrae el tarball con `--strip-components 1` y ejecuta `bin/armotusitio-ide-server`.
Fuentes: [configuración del servidor](https://github.com/jeanp413/open-remote-wsl/blob/master/src/serverConfig.ts),
[instalación](https://github.com/jeanp413/open-remote-wsl/blob/master/src/serverSetup.ts)
y [ajustes de la extensión](https://github.com/jeanp413/open-remote-wsl/blob/master/package.json).

Las URLs apuntan a Releases de `Drako01/armotusitio-ide`.
El repositorio es público; una descarga 404 antes de publicar el tag no implica que el repo sea privado.
No se incrustan tokens ni credenciales en la plantilla.
Una actualización de cliente usa su nuevo commit para instalar el servidor correspondiente.
Un build local sin publicar no tiene todavía una URL pública de servidor disponible.

## Hosting y publicación

Se elige Releases del mismo repo público: mantiene identidad, tags y validación del updater en un solo lugar.
Un repo público separado sirve si se privatiza el código, pero exige migrar también la confianza del updater.
Pages es útil para documentación; no se recomienda como almacén de estos binarios grandes.
S3/R2 permite controlar dominio y caché, pero agrega credenciales, administración y un feed de publicación propio.

Después de compilar todas las plataformas y verificar los instaladores:

```powershell
node scripts/ats-autoupdate.mts validate
node scripts/ats-autoupdate.mts artifacts
node scripts/ats-autoupdate.mts publish --approve
```

`artifacts` necesita la clave privada que corresponde a la clave pública versionada.
Nunca subas esa clave al repositorio ni la incluyas en un tarball, cache o artefacto del workflow.
Se validan los recibos Linux contra el mismo commit y se firman también sus hashes.
La publicación queda en draft si la verificación de un archivo falla.
La publicación manual exige Actions desactivado y conserva las comprobaciones de validación existentes.
Después de publicar, verificá las URLs con `curl -I -L` sin headers de autenticación.

## Actualizaciones Linux

El cliente Linux consulta la release pública y verifica el manifiesto firmado, como el cliente Windows.
Una release inexistente se trata como ausencia de actualizaciones.
Linux ofrece abrir la página pública de descargas: no ejecuta instaladores Windows ni modifica paquetes del sistema.
La instalación de una nueva versión `.deb` o `.rpm` sigue siendo responsabilidad del gestor de paquetes del usuario.

## Workflow preparado y desactivado

`.github/workflows/ats-release.yml.bak` no es descubierto por GitHub Actions.
Los permisos de Actions del repositorio deben permanecer desactivados durante esta entrega.
El workflow preparado usa tags, dependencias separadas por SO/arquitectura, cache y referencias fijadas de acciones.
No incluye REH Windows ni clientes Linux arm64, que son extensiones opcionales del alcance.

Una activación futura requiere autorización explícita: desactivar individualmente todos los workflows antiguos,
configurar `ATS_RELEASE_SIGNING_KEY`, renombrar el archivo a `.yml`, revisar el costo y habilitar Actions.
El publicador de CI rechaza tags incorrectos y cualquier ejecución con otro workflow activo.
No habilites Actions solo por pushear o mergear este cambio.

## Comprobaciones de aceptación

Usá el ejecutable Windows empaquetado para WSL: `scripts/code.bat` es un entorno de desarrollo y no representa
la identidad publicada del cliente y del servidor.
El build ARM64 en una máquina x64 requiere emulación ARM64 habilitada en Docker.
El workflow preparado incluye esa preparación; en una instalación local verificá `linux/arm64` antes del build.
Los paquetes Linux no incluyen el CLI Rust de túneles, que requiere un proceso de compilación independiente.

- Abrir una carpeta Linux mediante **Connect to WSL** en el cliente Windows empaquetado.
- Confirmar que terminal, Git y Node son de la distribución remota, sin copiar claves privadas de Windows.
- Instalar ESLint, Prettier y otras extensiones de workspace del lado WSL desde Open VSX.
- Verificar Claude Code en remoto con la sesión del usuario; compilar no demuestra que esté autenticado.
- Instalar el `.deb` y abrir el cliente en Ubuntu 22.04.
- Probar una revisión posterior: debe descargar un servidor nuevo bajo otro directorio de commit.

Los resultados reales se informan al entregar. La existencia de Docker, de un tarball o de una URL configurada
no sustituye una conexión WSL, una prueba de interfaz Linux ni una descarga pública satisfactoria.
