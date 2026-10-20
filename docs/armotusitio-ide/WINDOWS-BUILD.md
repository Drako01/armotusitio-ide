# Compilación de ArmotuSitio IDE en Windows

## Entorno de desarrollo

Usá Node de `.nvmrc` y el lockfile npm del repositorio.
El diagnóstico local no instala paquetes ni altera las dependencias:

```powershell
node scripts/ats-windows-preflight.mts
```

El problema previo de `node-gyp@11.4.2` era su detección de Visual Studio 2026 Insiders.
Las bibliotecas Spectre no corrigen por sí solas ese detector.
Una instalación de Visual Studio Build Tools 2022 en paralelo sigue siendo una alternativa para ejecutar `npm ci`.

Componentes del toolchain de Windows:

- Desktop development with C++.
- MSVC v143 x64/x86.
- Windows 10/11 SDK.
- Bibliotecas Spectre mitigated para v143 x64/x86.

No hace falta desinstalar Visual Studio 2026 ni cambiar globalmente Node o npm.
Si las dependencias ya están preparadas, no repitas su instalación para cada arranque.

## Compilar y abrir

Desde PowerShell en la raíz del checkout:

```powershell
node build/next/build-fast.ts --client-only
npm run compile --prefix extensions/armotusitio-ide
.\scripts\code.bat
```

La compilación del cliente recupera también recursos como `codicon.ttf`.
Tener una carpeta `out` incompleta puede permitir abrir la ventana y mostrar los íconos como cuadrados.
El comando directo de Node conserva `--client-only` en PowerShell.

Para generar la aplicación distribuible y el instalador, consultá [distribución local](DISTRIBUTION.md).

## Problemas frecuentes

### Acceso denegado o archivos bloqueados

Cerrá la instancia específica que utiliza los archivos antes de regenerarlos.
No termines todos los procesos Node del equipo: otros proyectos pueden usarlos.
No borres dependencias mientras una compilación está ejecutándose.

### Mezcla de gestores de paquetes

Este checkout versiona `package-lock.json` y sus tareas usan npm.
Una instalación parcial con pnpm puede dejar dependencias o recursos faltantes.
No agregues paquetes individuales para ocultar un fallo de instalación o de toolchain.

### Consulta del usuario de Windows

Un entorno restringido puede hacer fallar `os.userInfo()` durante el postinstall de Copilot.
El proceso local de empaquetado necesita acceso normal a la información del usuario y a sus herramientas de build.
Esto no requiere desactivar el antivirus ni ejecutar GitHub Actions.
