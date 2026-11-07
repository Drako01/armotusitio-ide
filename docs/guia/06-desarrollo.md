# 6. Desarrollo

[← Anterior: Configuración](05-configuracion.md) · [Índice](../../README.md#índice) · [Siguiente: Releases →](07-releases.md)

Esta guía es para quien quiere compilar el IDE o modificar su código.

## Estructura

| Carpeta | Contenido |
|---|---|
| `extensions/armotusitio-ide/` | La extensión propia: chat, Harness, permisos, MCP. Casi todo el trabajo pasa acá. |
| `extensions/armotusitio-ide/src/runtime/` | Runtime de sesiones nativas de Claude Code y Codex. |
| `build/armotusitio/` | Identidad del producto (`product-overrides.json`): nombre, catálogo de extensiones, metadatos de actualización. |
| `scripts/ats-*.mts` | Build, empaquetado y release. |
| `src/` | El núcleo de Code - OSS. Se modifica lo mínimo para poder seguir actualizando desde upstream. |

## Preparar el entorno (Windows)

1. Instalá la versión de Node.js indicada en `.nvmrc`.
2. Instalá Visual Studio Build Tools 2022 con **Desktop development with C++**. El detalle está en [Compilación en Windows](../armotusitio-ide/WINDOWS-BUILD.md).
3. Verificá el entorno sin instalar nada:

```powershell
node scripts/ats-windows-preflight.mts
```

4. Instalá las dependencias:

```powershell
npm ci
```

## Compilar y abrir

```powershell
node build/next/build-fast.ts --client-only
npm run compile --prefix extensions/armotusitio-ide
.\scripts\code.bat
```

Si los íconos aparecen como cuadrados, repetí el primer comando: recupera las fuentes del cliente.

## Verificar antes de un PR

```powershell
npm run check --prefix extensions/armotusitio-ide
npm test --prefix extensions/armotusitio-ide
npm run check:conformance --prefix extensions/armotusitio-ide
npm run hygiene
```

El hook de pre-commit corre la higiene (formato, encabezados de copyright, ESLint) sobre los archivos que cambiaste.

En cada PR que toca la extensión, GitHub corre `check` y `test` con el workflow **ATS IDE Extension**.

## Pruebas con proveedores reales

Estas pruebas gastan cuota de tu cuenta, por eso piden confirmación explícita:

```powershell
cd extensions/armotusitio-ide
node test/native-real-e2e.mts --provider claude --acknowledge-real-model-call
```

Los resultados de referencia están en [R8_TEST_EVIDENCE.md](../R8_TEST_EVIDENCE.md).

## Actualizar desde upstream

El proceso para incorporar una nueva versión de VS Code está en [Actualizaciones](../armotusitio-ide/AUTOUPDATE.md).
