# Actualizaciones de extensiones oficiales

Las siete extensiones oficiales incluidas en el IDE se distribuyen con versiones y SHA-256
fijados en `build/armotusitio/official-extensions.json`. Este archivo sigue siendo
determinista para builds, instalaciones sin conexión y recuperación.

## Usuarios del IDE

El runtime de Code - OSS ya admite actualizar extensiones integradas desde su galería.
Las siete extensiones se incluyen en `builtInExtensionsEnabledWithAutoUpdates`
y en `autoUpdateBuiltinExtensionsByDefault`, por lo que siguen la configuración del usuario
`extensions.autoUpdate`. Si el usuario desactiva las actualizaciones o fija una versión,
el IDE no debe forzar una actualización. La galería es Open VSX. Se conserva el
mecanismo nativo de compatibilidad, restricciones de la galería y recarga de ventanas.

Theme e Icons no son extensiones integradas en este manifiesto; cuando el usuario
las instala, el mecanismo nativo de extensiones de VS Code maneja sus actualizaciones.

## Mantenimiento de versiones de futuros builds

Cada lunes, `.github/workflows/ats-official-extensions-sync.yml` consulta
las versiones estables publicadas y genera **un PR para revisión** si existen cambios;
no hace merge, no instala nada a los usuarios y no publica releases. El PR lleva la etiqueta
`sin-release`: unirlo a `main` no dispara una versión nueva; los pines nuevos salen en la próxima
versión que se publique. Este workflow puede quedar activo: está en la lista de workflows permitidos
de la guarda de publicación (`scripts/ats-autoupdate.mts`).

Para consultar y actualizar el manifiesto **localmente** (necesita acceso a Open VSX):

```powershell
node --test scripts/ats-refresh-official-extensions.test.mts
node scripts/ats-refresh-official-extensions.mts
```

El actualizador valida identidad, licencia MIT, compatibilidad con el IDE, URLs
esperadas, cabecera ZIP, límite de tamaño y el SHA-256 descargado. Solo escribe el
manifiesto si todas las consultas y verificaciones terminan correctamente. Una
versión incompatible o prerelease no sustituye el pin anterior.

Si falla Open VSX, la versión integrada anterior sigue disponible. El mecanismo de
actualización nativo no se sustituye por un descargador propio en la extensión.

## Desarrollo

`scripts/code.bat` ejecuta la compilación local e integra las versiones fijadas
cuando se preparan las extensiones built-in. El `product.json` de desarrollo incluye
la misma galería y las mismas políticas de actualización que el paquete instalado.
