# 7. Releases

[← Anterior: Desarrollo](06-desarrollo.md) · [Índice](../../README.md#índice) · [Siguiente: Historial →](08-historial.md)

Hay dos formas de publicar una versión. Las dos producen exactamente lo mismo: instaladores de Windows y Linux, servidores para WSL, un manifiesto firmado y `SHA256SUMS.txt`.

| | Automática (GitHub Actions) | Manual (`release.sh`) |
|---|---|---|
| Cuándo | Al mergear a `main` un PR de este repositorio. | Cuando la corrés vos. |
| Dónde compila | Runners de GitHub (Ubuntu 22.04 y Windows 2022). | Tu PC con Windows y Docker Desktop. |
| Tiempo | Varias horas; no necesitás la PC prendida. | Varias horas en tu PC. |

## Release automático

El workflow [`ats-release.yml`](../../.github/workflows/ats-release.yml) hace esto:

1. **Prepara** (`prepare`): calcula la próxima revisión (`ats-v<versión>-r<N+1>`) a partir de las releases publicadas. Si hace falta, commitea en `main` solo el cambio de revisión en `build/armotusitio/product-overrides.json`, como `github-actions[bot]`.
2. **Linux** (`linux`): compila x64 y arm64 en paralelo.
3. **Windows y publicación** (`windows-and-publish`): compila el cliente de Windows, corre las validaciones (higiene, typecheck, tests), firma el manifiesto y publica la release como **Latest**.

La versión base (por ejemplo `1.145.2`) sale de `package.json`. La revisión sube sola en cada release.

**No se publica nada cuando:**

- el PR viene de un fork;
- el PR se cerró sin mergear;
- el PR tiene la etiqueta `sin-release` (útil para cambios solo de documentación).

Si se mergean varios PR seguidos, los releases se encolan y nunca corren dos a la vez.

### Ensayo antes de mergear

Agregale la etiqueta **`probar-release`** a un PR abierto. El workflow compila Linux y Windows, corre las validaciones y firma, igual que un release real, pero **no commitea nada ni publica**. Al terminar, el instalador de Windows queda dos días como artefacto del run (**Actions → el run → Artifacts**), para que lo pruebes.

Para repetir el ensayo, sacá la etiqueta y volvé a ponerla.

### Configuración inicial (una sola vez)

1. **Clave de firma.** Subí la clave privada que ya usás para firmar (la misma de `release.sh`) como secreto del repositorio:

   ```bash
   gh secret set ATS_RELEASE_SIGNING_KEY -R Drako01/armotusitio-ide < .build/ats-autoupdate/signing/private.pem
   ```

   Sin este secreto el workflow falla en el primer paso, antes de compilar. Nunca subas la clave al repositorio.

2. **Actions habilitado, solo con los workflows propios.** Los workflows heredados de VS Code usan runners de Microsoft que no existen en esta cuenta, y el publicador se niega a correr si alguno está activo. Para verificarlo:

   ```bash
   gh workflow list -R Drako01/armotusitio-ide --all
   ```

   Solo tienen que figurar como `active` **ArmotuSitio Release** y **ATS IDE Extension**. Si upstream agrega workflows nuevos en una actualización, desactivalos con:

   ```bash
   gh workflow disable "<nombre>" -R Drako01/armotusitio-ide
   ```

3. **Protección de `main` (si la activás).** El paso de preparación hace push a `main`. Si protegés la rama, permití que GitHub Actions la saltee o el release va a fallar en ese paso.

### Si un release falla

- Mirá el error en **Actions → ArmotuSitio Release**.
- Corregí la causa y volvé a lanzarlo con **Run workflow** (o mergeá el siguiente PR). Si quedó un borrador de la misma versión y del mismo commit, se reanuda. Si el borrador apunta a otro commit, el workflow se detiene sin tocarlo: revisalo y borralo antes de reintentar.
- Una release ya publicada nunca se reemplaza. Para corregirla, publicá una revisión nueva.

## Release manual

[`release.sh`](../../release.sh) sigue funcionando igual. Desde Git Bash, en `main` actualizado y limpio:

```bash
./release.sh --plan        # Solo muestra qué haría.
./release.sh --dry-run     # Verificaciones previas sin compilar ni publicar.
./release.sh --no-publish  # Compila y firma; vos probás el instalador y publicás después.
./release.sh               # Todo: prepara la revisión, compila, firma y publica.
```

El script se niega a publicar mientras haya un release automático en cola o en curso, así que nunca chocan.

Requisitos y detalle: [Distribución local](../armotusitio-ide/DISTRIBUTION.md), [Actualizaciones](../armotusitio-ide/AUTOUPDATE.md) y [ensayo del release](../release-dry-run.md).

## ¿Cuesta algo?

No. Según la [documentación de facturación de GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-actions), los minutos de los **runners estándar** son gratis en repositorios **públicos**, y este workflow usa solo runners estándar (`ubuntu-22.04`, `ubuntu-24.04`, `windows-2022`). Los únicos runners que GitHub cobra en repos públicos son los "larger runners", y esta cuenta no tiene ninguno.

Para minimizar el almacenamiento, los artefactos intermedios de Linux se borran al día siguiente (`retention-days: 1`).

Para tener la garantía total, revisá en **Settings → Billing and licensing → Budgets and alerts** que el presupuesto de Actions esté en `$0` con **Stop usage** activado. Así GitHub frena el uso en lugar de cobrarlo, aunque cambien las condiciones.
