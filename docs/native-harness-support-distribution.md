# Harness nativo: soporte, compatibilidad y distribución

## Estado y alcance

Este documento describe el módulo nativo de la extensión `extensions/armotusitio-ide`. No sustituye a los Harness particulares que ya están instalados en proyectos como RedEvent. El motor local y sus tareas se almacenan de forma aislada por raíz de proyecto; la configuración compartida opcional está en `.ats-harness.json`.

El trabajo de ejecución real de Codex y Claude, delegación automática de agentes y pruebas E2E completas se realiza por separado.

## Diagnósticos y evidencias

Desde la paleta de comandos ejecutar **ArmoTuSitio: Diagnósticos y evidencias del Harness nativo**. Requiere un workspace confiable. Muestra un documento JSON con estado del lock, identificador derivado de la raíz y resultados resumidos por intento. La exportación requiere seleccionar expresamente **Export JSON** y un destino nuevo.

El informe no incluye rutas absolutas, argumentos de procesos, contenido de salidas, instrucciones de agentes, valores de configuración ni credenciales. No es un respaldo de las tareas ni sirve para recuperarlas. La exportación nunca sobrescribe archivos. Mantener estos informes fuera de repositorios públicos salvo revisión humana.

## Compatibilidad de estados y migraciones

- Contrato de configuración: `.ats-harness.json`, `schemaVersion: 1`, `runtime: ide-native`.
- Contrato de tareas: `schemaVersion: 1`, con validación de planes y revisiones antes de ejecutar.
- Contrato de evidencia de soporte: `schemaVersion: 1`. Versiones desconocidas se rechazan.
- No convertir automáticamente versiones futuras o desconocidas: conservar los archivos originales, registrar diagnóstico y exigir migración explícita, reversible y probada.
- No reconciliar automáticamente intentos inciertos o locks obsoletos; la reconciliación existente exige decisión del operador.
- No modificar los archivos de un Harness de proyecto que conserve la autoridad de sus tareas.

## Controles locales

En el checkout con dependencias instaladas:

```bash
cd extensions/armotusitio-ide
npm run check
npm run test
node --experimental-strip-types --test test/native-harness.test.mts test/native-project.test.mts test/native-providers.test.mts test/native-support.test.mts
npm run compile
npm run check:native-package
```

El último comando comprueba manifiesto, comandos registrados y recursos compilados. **No certifica** que el instalador incluya correctamente toda la extensión; esa evidencia requiere inspeccionar los artefactos reales de la distribución.

## Matriz de distribución pendiente de ejecutar

| Destino | Comprobación requerida | Estado |
| --- | --- | --- |
| Windows x64 | Compilación, empaquetado, instalación limpia y apertura de proyecto | Pendiente |
| Linux x64 | Las mismas pruebas en un host Linux real | Pendiente |
| WSL | Comprobar ejecución del motor en host de extensión y herramientas del lado WSL | Pendiente |
| Linux arm64 remoto | Solo declarar soporte después de comprobar runtime y servidor remoto | Pendiente |

Revisar `.vscodeignore` y las salidas de empaquetado: el bundle de `dist/extension.js` debe contener los módulos nativos importados. No incluir archivos privados, historiales, secretos ni artefactos temporales. Evitar dependencias en herramientas globales sin diagnóstico explícito.

## Límites y cierre

La prueba de recursos no sustituye una prueba E2E. No activar GitHub Actions, no despachar workflows ni publicar instaladores automáticamente. El release final queda a cargo del operador. Antes de cada publicación remota, comprobar que GitHub Actions está deshabilitado.

La evidencia del fallo del release anterior aún debe estudiarse con sus logs originales; no se asume corregido por agregar controles de empaquetado.
