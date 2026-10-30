# Verificación y reanudación del release

Desde Git Bash, con `main` limpio y actualizado, Node de Windows, Docker Desktop
iniciado y la clave de firma existente:

```bash
set -o pipefail
./release.sh --dry-run 2>&1 | tee test.log
```

El código de salida es distinto de cero si falla alguna comprobación. El archivo
`test.log` queda en la raíz del repositorio y se puede compartir para diagnosticar
el resultado. No contiene la clave de firma.

El modo comprueba los requisitos locales y las arquitecturas Docker antes de
ejecutar pruebas del flujo completo con Git, GitHub, compilación y publicación
simulados en directorios temporales. También verifica la firma y los hashes de
los artefactos existentes y los compara con los archivos de GitHub si existe ese
release. Si falta el manifiesto, informa que omitió esa comparación.

No compila el producto, firma con la clave real, modifica metadatos ni crea ramas,
PR, tags o releases. Tampoco vuelve a publicar el release existente. Las pruebas
crean archivos y claves de prueba temporales que eliminan al terminar. Una salida
correcta valida la orquestación y los archivos disponibles; la compilación real,
la instalación y los permisos de escritura de GitHub requieren una ejecución real.
Los artefactos históricos se identifican por su propio commit y nunca se presentan
como una compilación del `main` actual.

## Modos de ejecución

| Comando | Resultado |
| --- | --- |
| `./release.sh --plan` | Consulta GitHub y muestra la próxima revisión; no ejecuta pruebas ni comprueba todos los requisitos locales. |
| `./release.sh --dry-run` | Comprueba el entorno, audita artefactos existentes y prueba la orquestación aislada, sin publicar. |
| `./release.sh --no-publish` | Valida, compila y firma una revisión nueva; se detiene antes de publicar. |
| `./release.sh` | Valida, compila, firma y publica una revisión nueva. |
| `./release.sh --rebuild --no-publish` | Fuerza validación y compilación, sin reutilizar etapas completas ni publicar. |

## Recuperación de una ejecución interrumpida

Volver a ejecutar el mismo comando reutiliza las etapas completas únicamente para
el mismo commit y entorno de Node, con sus salidas verificadas mediante SHA-256.
Los checkpoints están en `.build/ats-release-recipe/checkpoint.json` y
`.build/ats-build-all/checkpoint.json`. Una etapa fallida queda pendiente y se
ejecuta nuevamente. Las etapas ya completas se anuncian como reutilizadas.

Linux reutiliza cada arquitectura por separado si su recibo identifica el mismo
commit, versión y canal y todos sus archivos conservan tamaño y hash. Las salidas
de otro commit, incompletas o modificadas se reconstruyen. La compilación de una
arquitectura pendiente puede repetir sus tareas internas, aprovechando los volúmenes
de dependencias existentes.

El publicador espera de forma acotada a que GitHub liste un borrador recién creado.
Si la espera se agota, el borrador queda disponible para reanudar el mismo release;
no se reemplazan archivos publicados. Una publicación terminada hace que la próxima
ejecución normal seleccione otra revisión: para verificar la anterior, usar
`--dry-run`.

Si una actualización de metadatos deja un PR abierto, hay que resolverlo y volver
a `main` limpio antes de reintentar. El script conserva las comprobaciones de
Actions deshabilitadas, firma, identidad del commit y hashes antes de publicar.
