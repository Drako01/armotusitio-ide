# Compilación Windows: diagnóstico previo

Esta guía aborda el error observado al compilar ArmoTuSitio IDE en Windows 11:

```
gyp ERR! find VS unknown version "undefined" found at "F:\\visual"
gyp ERR! using node-gyp@11.4.2
```

**Diagnóstico:** Visual Studio 2026 Insiders (MSVC 14.52) está instalado y funciona con otros `node-gyp`, pero **el node-gyp 11.4.2 que ejecuta npm ci no identifica correctamente esa versión**. Instalar Spectre repara MSB8040, pero no este detector. Ejecutar `vcvars64.bat` de VS 2026 tampoco soluciona el rechazo de versión.

## Preparación única, no destructiva

Desde PowerShell o Git Bash en la raíz de `vscode`:

```bash
node scripts/ats-windows-preflight.mjs
```

El diagnóstico comprueba Node de `.nvmrc`, `package-lock.json`, instalaciones de Visual Studio (incluidas prerelease) y presencia de `vcvars64.bat`. No altera el repositorio ni instala dependencias.

### Si informa que solamente existe VS 2026

La alternativa conservadora y compatible con node-gyp 11 es **instalar Visual Studio Build Tools 2022, versión 17, en paralelo**. Seleccionar:
- Desktop development with C++.
- MSVC v143 x64/x86.
- Windows 10/11 SDK.
- Bibliotecas Spectre mitigated para v143 x64/x86.

No desinstales VS 2026 ni hagas un downgrade global de Node o npm. La instalación de VS 2022 requiere espacio adicional; esta solución se debe validar en la máquina local.

Desde una **x64 Native Tools Command Prompt for VS 2022** ejecutar:

```bat
cd /d F:\vscode
npm ci
node -e "console.log(require.resolve('vinyl-fs'))"
npm run watch
```

Para ejecutar el IDE en una segunda consola, desde el mismo checkout:

```bat
scripts\code.bat
```

La compilación completa y el empaquetado siguen sujetos a pruebas reales.

### Si aparecen EBUSY o EPERM

Cerrá procesos de `watch`, Code - OSS y editores que utilicen la carpeta. Reiniciá Windows si hay archivos bloqueados. **No** hagas `taskkill /F /IM node.exe` indiscriminadamente, porque puede cortar servicios de otros proyectos. No elimines `node_modules` hasta que el proceso de compilación termine y los bloqueos estén liberados.

### Por qué no se reemplaza npm por pnpm

Esta revisión versiona `package-lock.json` y sus scripts de instalación usan npm. Una instalación parcial con pnpm puede generar un árbol incompleto y errores `ERR_MODULE_NOT_FOUND` como `vinyl-fs`. No hagas `pnpm add vinyl-fs` ni cambies el lockfile para ocultar un error de toolchain.

### Mejoras futuras

Se puede evaluar actualizar el `node-gyp` utilizado por el npm efectivo, **con pruebas de build completas**, o adoptar un toolchain 2026 cuando sea oficialmente compatible. No se fuerza ni parchea el detector de forma opaca desde el repositorio.
