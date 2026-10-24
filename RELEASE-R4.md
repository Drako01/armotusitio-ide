# Compilar y publicar ArmotuSitio IDE r4

La candidata r4 usa VS Code **1.143.1**, revisión **4**, y se publica con el tag `ats-v1.143.1-r4`.
Estos pasos se ejecutan localmente en PowerShell desde `F:\vscode`; no usan GitHub Actions.

## Antes de empezar

- Usá `main` actualizado y sin cambios versionados. No edites fuentes ni cambies de rama durante el build.
- Cerrá el IDE que se ejecuta desde `F:\ArmotuSitio-IDE-win32-x64` para evitar archivos bloqueados.
- Tené Docker Desktop iniciado con contenedores Linux para el escritorio Linux y los servidores WSL x64/ARM64.
- Conservá la clave existente `.build/ats-autoupdate/signing/private.pem`. No la regeneres ni la compartas.
- Para publicar, `gh auth status` debe confirmar una sesión con acceso al repositorio.

## Compilación completa

Ejecutá este bloque. Cada control detiene la secuencia si falla:

```powershell
cd F:\vscode
git switch main
if ($LASTEXITCODE -ne 0) { throw 'No se pudo seleccionar main.' }
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'No se pudo actualizar main.' }

$actionsEnabled = gh api repos/Drako01/armotusitio-ide/actions/permissions --jq '.enabled'
if ($LASTEXITCODE -ne 0 -or $actionsEnabled -ne 'false') { throw 'Actions debe estar deshabilitado.' }

node scripts/ats-autoupdate.mts validate
if ($LASTEXITCODE -ne 0) { throw 'Falló la validación. No compilar ni publicar.' }

node scripts/ats-build-all.mts
if ($LASTEXITCODE -ne 0) { throw 'Falló el build completo. No publicar.' }

node scripts/ats-autoupdate.mts artifacts
if ($LASTEXITCODE -ne 0) { throw 'Falló la preparación o firma de los artefactos. No publicar.' }
```

El build completo genera Windows e instalador, ZIP, salida de desarrollo para `code.bat`, escritorio Linux x64
y servidores Linux x64/ARM64. No uses `--windows-only` para una release completa: la firma exige todos los destinos.
El paso `artifacts` agrega los nombres con revisión, los hashes y el manifiesto firmado.

## Resultados

| Resultado | Ruta |
| --- | --- |
| Carpeta completa de Windows | `F:\ArmotuSitio-IDE-win32-x64` |
| Instalador para distribuir r4 | `F:\vscode\.build\releases\ArmotuSitio-IDE-Setup-1.143.1-r4-x64.exe` |
| ZIP para distribuir r4 | `F:\vscode\.build\releases\ArmotuSitio-IDE-1.143.1-r4-win32-x64.zip` |
| Artefactos Linux, manifiesto y hashes | `F:\vscode\.build\releases` |
| Instalador sin sufijo de revisión | `F:\vscode\.build\releases\ArmotuSitio-IDE-Setup-1.143.1-x64.exe` |
| ZIP sin sufijo de revisión | `F:\vscode\.build\releases\ArmotuSitio-IDE-1.143.1-win32-x64.zip` |

Los archivos sin sufijo se generan durante `build-all`; los archivos con `r4` se preparan en `artifacts`
y son los que publica la receta de releases.

Probá el ejecutable empaquetado y, después de cerrar las ventanas de desarrollo anteriores, la salida de desarrollo:

```powershell
& 'F:\ArmotuSitio-IDE-win32-x64\ArmotuSitio IDE.exe'
# Para probar la salida de desarrollo por separado:
.\scripts\code.bat --new-window
```

## Publicar en GitHub

Después de verificar los resultados, ejecutá:

```powershell
cd F:\vscode
node scripts/ats-autoupdate.mts publish --approve
if ($LASTEXITCODE -ne 0) { throw 'No se confirmó la publicación. Revisá el error antes de reintentar.' }
gh release view ats-v1.143.1-r4 --repo Drako01/armotusitio-ide
```

La receta comprueba que Actions esté deshabilitado antes de las escrituras, crea un borrador, sube los archivos
firmados, compara tamaños y hashes remotos y recién después publica como release estable más reciente.
Si falla una carga, conserva el borrador: podés repetir el mismo comando sin reemplazar una release publicada.
No subas manualmente toda la carpeta de releases, porque puede contener versiones anteriores.

La publicación quedará en [ArmotuSitio IDE r4](https://github.com/Drako01/armotusitio-ide/releases/tag/ats-v1.143.1-r4).
La firma del manifiesto de actualización no equivale a un certificado de editor de Windows para el instalador.
