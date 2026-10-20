# Actualizaciones de ArmotuSitio IDE sin GitHub Actions

El flujo usa releases oficiales de Microsoft, candidatos locales y GitHub Releases para distribuir ArmotuSitio.
Windows x64 reutiliza el actualizador nativo del editor, con manifiestos Ed25519 y SHA-256 de los instaladores.
El ZIP recibe aviso y descarga; no reemplaza automáticamente una carpeta abierta.

## Estado y responsabilidades

La detección, preparación aislada, firma, validación, publicación y cliente están implementados.
El build, el ZIP y la prueba del instalador corresponden al propietario; no se ejecutan desde la tarea diaria.
La primera distribución con actualizador se instala manualmente como versión puente.
Las pruebas en una máquina limpia y el ensayo de actualización entre dos instalaciones siguen siendo gates de release.

La base actual es 1.143.0; la consulta del 20 de octubre de 2026 encontró como última estable oficial la 1.142.0.
La política elegida espera una estable estrictamente posterior a la base actual y nunca integra un downgrade.
Cada candidato registra el tag y el SHA oficial resuelto, además del commit del fork del que partió.

## Preparación inicial

Desde PowerShell, en `F:\vscode`, completá la instalación de dependencias antes de compilar.
No ejecutes `npm install` y el build simultáneamente.

```powershell
node scripts/ats-autoupdate.mts help
node scripts/ats-autoupdate.mts detect --dry-run
```

La clave de firma inicial ya fue creada localmente; su parte pública está en el repositorio.
La privada está en `.build/ats-autoupdate/signing/private.pem`, excluida de Git y con acceso restringido.
Hacé una copia segura fuera del checkout: perderla impide firmar versiones que confíen las instalaciones existentes.
No copies la clave a un ZIP, instalador, repositorio, chat ni carpeta compartida del equipo.

En otra computadora, restaurá esa clave desde el respaldo y usá `init-signing` para verificar la correspondencia.
El comando rechaza reemplazar silenciosamente una clave pública ya configurada.

```powershell
node scripts/ats-autoupdate.mts init-signing
```

Podés indicar una ubicación protegida externa mediante `ATS_IDE_SIGNING_KEY`.
Esto también permite firmar un candidato aislado sin copiar la clave privada a ese clon.
Rotar la clave pública requiere una distribución puente confiable; no alcanza con cambiar la clave del servidor.
La firma del manifiesto no sustituye una firma Authenticode del ejecutable de Windows.

## Detección y preparación

```powershell
node scripts/ats-autoupdate.mts detect
node scripts/ats-autoupdate.mts prepare --dry-run
node scripts/ats-autoupdate.mts prepare
```

Solo se consultan versiones estables de `microsoft/vscode`; se omiten borradores y prereleases.
La consulta usa caché ETag, timeout y reintentos acotados. Los errores de permisos no se reintentan automáticamente.
`prepare` crea un clon independiente en `.build/ats-autoupdate/candidates`; no cambia tu `main`.
El clon no comparte `node_modules` ni copia perfiles o credenciales. No ejecuta los scripts descargados.
El merge queda sin commit para revisar los cambios, dependencias, scripts, marca y extensión propia.
Ante conflictos se registra la lista de archivos y se detiene. No se elige automáticamente una de las versiones.
Un candidato ya existente no se vuelve a crear ni a compilar.

Los estados quedan en `.build/ats-autoupdate`: `detection.json`, archivos de candidatos y `last-error.json`.
Un bloqueo evita operaciones simultáneas y solo se recupera cuando el proceso anterior ya no existe.

## Tarea diaria de Windows

El script registra una tarea deshabilitada; la activación es un paso separado posterior a probar la detección.
En esta computadora quedó activada a las 10:00; la ejecución de prueba terminó con código cero, sin iniciar un build.
Usa el usuario actual sin guardar contraseñas, a las 10:00 de la hora local de Windows por defecto.
La computadora debe estar encendida, con acceso a Internet y el usuario con sesión iniciada.

En un equipo nuevo, registrala y activala con:

```powershell
.\scripts\ats-update-task.ps1 -Operation Register -At '10:00' -PrepareCandidates
.\scripts\ats-update-task.ps1 -Operation Enable
.\scripts\ats-update-task.ps1 -Operation Status
```

Con `-PrepareCandidates` detecta y prepara el merge aislado; sin ese parámetro solo detecta.
La tarea nunca compila, arma ZIPs, pushea ni publica releases.
Si se perdió un horario, Windows intenta recuperarlo; otra instancia activa impide duplicar el trabajo.

```powershell
.\scripts\ats-update-task.ps1 -Operation Disable
.\scripts\ats-update-task.ps1 -Operation Remove
```

## Revisar y validar una nueva distribución

En el candidato indicado por `prepare`, resolvé conflictos y revisá el diff antes de instalar dependencias.
Protegé la identidad, el catálogo Open VSX, las claves públicas, la extensión propia y los cambios de empaquetado.
Revisá especialmente Electron, Node, SDK de Windows, archivos de lock y scripts de instalación recibidos de upstream.

Para la siguiente release incrementá la revisión propia, incluso si no cambió la versión base de VS Code.
La versión puente inicial usa revisión 1; la siguiente debe usar al menos 2.

```powershell
node scripts/ats-autoupdate.mts revision 2
```

Revisá y commiteá el candidato antes de validar y construir. Los mensajes deben conservar `[skip ci]`.
Los checks de release incluyen higiene nativa, typecheck del cliente y extensión, tests propios y del actualizador.

```powershell
node scripts/ats-autoupdate.mts validate
```

La validación queda vinculada al commit; un cambio posterior requiere validar de nuevo.
El comando no compila el producto ni publica. Ante un fallo no se registra aprobación.

## Build y ZIP a cargo del propietario

Ejecutá estos comandos desde un commit limpio, sin otro build ni una instalación de dependencias en curso.

```powershell
node scripts/ats-package-windows.mts
node scripts/ats-autoupdate.mts artifacts
```

El primer comando genera la aplicación e instalador y un recibo con el commit y hashes del resultado.
El segundo comprime la aplicación completa, copia el instalador y genera manifiesto firmado y `SHA256SUMS.txt`.
Conserva archivos ocultos y rechaza perfiles portables, links simbólicos y resultados que no coinciden con el recibo.
Los nombres incorporan versión y revisión, por ejemplo `ArmotuSitio-IDE-Setup-1.143.0-r1-x64.exe`.
Los resultados quedan en `.build/releases`; el comando `artifacts` sí realiza el ZIP y debe ejecutarlo el propietario.

El instalador anterior no sirve para validar este código: necesita un build nuevo con el cliente de actualización.

## Publicación aprobada

Antes de publicar, probá arranque, íconos, Open VSX, el inicio propio y los flujos habituales del equipo.
Probá la instalación y desinstalación en Windows limpio y la conservación de un perfil de prueba existente.
La prueba del actualizador necesita dos releases distintas; no se considera realizada por pasar tests unitarios.

Subí los commits revisados a `main` después de confirmar `enabled: false` en Actions.
El script de publicación comprueba que el commit compilado ya pertenezca a `origin/main`.

```powershell
gh api repos/Drako01/armotusitio-ide/actions/permissions
node scripts/ats-autoupdate.mts publish --approve
```

`--approve` confirma que revisaste los artefactos y completaste los ensayos requeridos.
La publicación crea un borrador, sube los archivos, verifica los digests remotos y publica al final como última estable.
Nunca reemplaza assets de una release publicada. Un fallo deja el borrador sin anunciarlo a los clientes.
Se comprueba Actions antes de cada mutación; una respuesta distinta de `enabled: false` detiene la operación.
No se necesita un servidor propio ni workflows de Actions para este canal.

## Cliente Windows y recuperación

El cliente consulta GitHub Releases con el mecanismo nativo y respeta `update.mode`, políticas y conexiones medidas.
Valida firma, repositorio, tag, arquitectura, revisión, versión base, tamaño y SHA-256 antes de aceptar una descarga.
La descarga y el reinicio usan la interfaz nativa; los perfiles y extensiones no se incorporan al instalador.
También se verifica el hash de un instalador ya almacenado en caché antes de reutilizarlo.
Un error de red, firma o integridad conserva la instalación actual; no se ejecutan archivos desconocidos.

Para retirar una release defectuosa del canal estable:

```powershell
node scripts/ats-autoupdate.mts withdraw ats-v1.143.0-r2 --approve
```

Publicá una corrección con revisión superior para los equipos que ya la instalaron; no hay downgrade automático.
Para recuperación manual, cerrá el editor, respaldá su perfil y usá un instalador anterior comprobado.
No asumas que una migración de perfil admite volver atrás: ensayalo en una copia antes de usar datos reales.
Podés usar `update.mode: none` para pausar el actualizador de un equipo.

La limpieza muestra primero los candidatos fallidos de más de 30 días; no toca releases, claves ni trabajo en revisión.

```powershell
node scripts/ats-autoupdate.mts cleanup
node scripts/ats-autoupdate.mts cleanup --approve
```

## Evidencia y límites

Se ejecutaron tests de firmas válidas, metadatos y paquetes alterados, URLs ajenas, revisión y downgrade.
También se verificaron tipos, lint, la detección contra Microsoft y la sintaxis del script de tareas.
El [TODO](../../TODO-AUTOUPDATE.md) conserva los ensayos operativos pendientes.
El propietario ejecutará el build, el ZIP y la publicación del puente; no se realizaron en esta implementación.
