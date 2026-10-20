# Compilar ArmotuSitio IDE en Windows

`scripts\code.bat` abre el IDE desde `out` y las extensiones del checkout local.
No se compila el archivo `.bat`: se actualizan las salidas que carga.
El empaquetador de Windows genera otra salida y no actualiza ese `out` de desarrollo.
Si `out` ya existe, la preparación de `code.bat` no vuelve a compilarla.

## Todo en un comando: instalador, ZIP y desarrollo

Cerrá las ventanas anteriores de ArmotuSitio IDE y ubicá el checkout en `main`, sin cambios versionados.
Ejecutá desde PowerShell 7, con `pwsh.exe` disponible en `PATH`:

```powershell
node scripts/ats-build-all.mts
```

El orden es: empaquetar Windows e instalador, comprimir la aplicación completa y compilar la salida de `code.bat`.
Si falla un paso, los siguientes no se ejecutan.
El comando comprueba antes si hay procesos usando el ejecutable de la carpeta empaquetada; no los termina.
No cambies archivos ni commits y no inicies otra compilación durante la receta.

- Instalador: `.build/win32-x64/user-setup/VSCodeSetup.exe`.
- ZIP: `.build/releases/ArmotuSitio-IDE-win32-x64.zip`.
- Desarrollo: listo para abrir con `.\scripts\code.bat --new-window` al finalizar correctamente.

Las rutas se calculan desde el repositorio, sin depender de que esté clonado en `F:\vscode`.
El ZIP anterior se reemplaza solo después de completar la compresión.
Este ZIP manual no genera el manifiesto firmado ni publica una release; ese flujo usa `ats-autoupdate.mts artifacts`.
La receta no instala extensiones personales, no abre el IDE automáticamente y no ejecuta GitHub Actions.

## Probar main completo

Cerrá las ventanas anteriores de ArmotuSitio IDE para evitar reutilizar un proceso con código viejo.
Desde PowerShell, ejecutá estos comandos en orden y continuá solo si cada uno termina correctamente:

```powershell
cd F:\vscode
git switch main
git pull --ff-only origin main
node scripts/ats-build-dev.mts
.\scripts\code.bat --new-window
```

El comando de desarrollo verifica TypeScript de la extensión propia y fuerza las tres etapas de `build-fast`.
Actualiza el cliente en `out`, las extensiones integradas y Copilot.
Además compila explícitamente `armotusitio-ide`, que no forma parte de la lista de transpilation de upstream.
Incluye `dist/extension.js`, `dist/home.js` y `dist/chat.js`.
Comprueba que la bienvenida compilada referencie el logo real y que su imagen coincida con la fuente.
No genera instalador ni ZIP y no invoca GitHub Actions.

No cambies de rama ni edites archivos versionados mientras compila.
Si cambia el commit o quedan cambios versionados, el comando no informa un build completo.
Los archivos locales sin seguimiento no se incluyen en esa comprobación ni se borran.
El recibo de desarrollo se guarda en `.build/ats-autoupdate/dev-build-receipt.json`.
El comando comparte el bloqueo del empaquetador para evitar compilaciones concurrentes.

## Generar instalador y ZIP

Con main actualizado, sin cambios versionados y sin otras compilaciones activas:

```powershell
node scripts/ats-package-windows.mts
node scripts/ats-autoupdate.mts artifacts
```

El mensaje `Source changed during packaging` indica que cambió el commit o algún archivo versionado durante el build.
Aunque Inno Setup haya creado el EXE, falta una validación final satisfactoria para generar los artefactos.
Volvé a empaquetar sin cambios simultáneos; no se debe omitir esa comprobación.
El instalador intermedio está en `.build/win32-x64/user-setup/VSCodeSetup.exe`.
