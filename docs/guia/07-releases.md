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

1. **Prepara** (`prepare`): calcula la próxima revisión (`ats-v<versión>-r<N+1>`) y exige que coincida con los metadatos ya revisados en `main`. Si falta actualizarla, se requiere un PR de metadatos; este paso no escribe en `main`.
2. **Linux** (`linux`): compila x64 y arm64 en paralelo, cada uno en su runner nativo. Un fallo de una arquitectura no cancela la otra. El arm64 se compila con el compilador de la imagen (Ubuntu 22.04), así que sus módulos nativos exigen como mínimo glibc 2.35; el x64 sigue usando el sysroot de glibc 2.28.
3. **Windows y publicación** (`windows-and-publish`): compila el cliente de Windows, corre las validaciones (higiene, typecheck, tests), firma el manifiesto y publica la release como **Latest**.

La versión base sale de `package.json`. La revisión de cada release debe estar aprobada en los metadatos del repositorio.

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

3. **Protección de `main`.** El paso de preparación es de solo lectura. No necesita una excepción para saltarse la protección de rama.

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

La firma Authenticode usa un servicio externo con facturación y requiere aprobación de costos antes de activarlo. La facturación de runners y almacenamiento es independiente; revisar las condiciones de [GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions) y de la cuenta Azure.

Para minimizar el almacenamiento, los artefactos intermedios de Linux se borran al día siguiente (`retention-days: 1`).

Configurar presupuestos y alertas en ambos servicios. Un presupuesto de GitHub no limita el consumo de Azure Artifact Signing.

## Paquete para Microsoft Store

El workflow **ArmotuSitio Release** genera un MSIX x64 como artefacto después de publicar una release estable. También responde a la publicación manual de una release. No lo genera durante ensayos con `probar-release`.

Para empaquetar una release existente, abrir **Actions → ArmotuSitio Release → Run workflow** y completar `store_release_tag`, por ejemplo `ats-v1.146.0-r2`. Con ese campo completo solo se ejecuta el empaquetado para Store: no se compila otra release ni se necesitan credenciales de Azure. Dejarlo vacío conserva el flujo completo de release, que exige la configuración de firma indicada abajo.

Descargar el artefacto `ats-store-msix-<run-id>` del job `store-msix` y cargar su `.msix` en Partner Center. El artefacto se conserva 14 días e incluye los hashes y la procedencia. La subida y certificación de Store siguen siendo manuales; este flujo no configura ni consume credenciales de publicación de Store.

El empaquetado comprueba el SHA256 y tamaño del ZIP contra la API de GitHub antes de ejecutarlo con MakeAppx. Usa la identidad reservada de ArmotuSitio IDE, idiomas español e inglés, Windows Desktop y `runFullTrust`. Deshabilita el actualizador propio únicamente en la copia empaquetada para que las actualizaciones de esa instalación correspondan a Store. La versión se calcula como `MAJOR.MINOR.(PATCH × 1000 + REVISION).0`; rechaza revisiones de 1000 o más y componentes fuera del rango de MSIX.

Para generar el mismo candidato localmente, con Node de `.nvmrc`, PowerShell 7 y Windows SDK instalados:

```powershell
node scripts/ats-store-release.mts ats-v1.146.0-r2
```

El MSIX no se firma localmente: es un candidato para envío a Store, que aplica su firma en su proceso de distribución. Crear el paquete no demuestra instalación correcta ni certificación aprobada. Las releases EXE y su firma Authenticode siguen siendo un flujo independiente.

## Firma del editor en Windows

La firma Ed25519 de `ATS_RELEASE_SIGNING_KEY` protege el manifiesto de actualización; no identifica al editor ante Windows. La distribución Windows ahora exige además Authenticode con sello de tiempo y el Subject exacto del editor esperado. Sin configuración, el release se detiene: no hay fallback a ejecutables sin firma.

### Activación pendiente del propietario

1. Contratar o habilitar Azure Artifact Signing únicamente después de aprobar el costo y verificar la elegibilidad de la identidad y región. Crear un perfil de confianza pública con identidad validada; un certificado autofirmado o un perfil de confianza privada no sirve para distribución pública.
2. Crear una identidad de aplicación con permiso de firmante limitado a ese perfil. Configurar el environment `windows-signing` en GitHub con aprobación humana obligatoria. Revisar siempre el SHA antes de aprobar un ensayo de PR: ejecuta código de esa rama con acceso a la identidad de firma.
3. Definir las variables de repositorio `ATS_WINDOWS_PUBLISHER` (Subject completo y exacto del certificado, no el nombre comercial inventado), `ATS_SIGNING_ENDPOINT`, `ATS_SIGNING_ACCOUNT` y `ATS_SIGNING_PROFILE`.
4. Guardar en el environment los secretos `ATS_SIGNING_TENANT_ID`, `ATS_SIGNING_CLIENT_ID` y `ATS_SIGNING_CLIENT_SECRET`. No son la clave Ed25519. Rotar el secreto de aplicación y no imprimirlo en logs.
5. Autorizar un ensayo con `probar-release`, revisar las firmas y probar instalación, actualización y desinstalación en Windows. Ese ensayo consume servicio de firma y recursos de build: no forma parte de las pruebas locales de este PR.

El workflow instala versiones fijadas de Windows SDK BuildTools y Artifact Signing Client. El script firma los `.exe`, `.dll` y `.node` del payload después de modificar los recursos; Inno Setup firma su desinstalador embebido y el instalador exterior. Las verificaciones exigen firma embebida válida, sello de tiempo y editor exacto antes de registrar hashes, crear artefactos y publicar el instalador.

Para el flujo manual se requiere PowerShell 7, .NET 8 y las herramientas oficiales de firma x64. Exportar `ATS_SIGNTOOL` y `ATS_SIGNING_DLIB` con sus rutas, las cuatro variables públicas anteriores y las credenciales `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. No se descarga software ni se crea una cuenta desde el script local. Las versiones fijadas y los requisitos del proveedor están en el workflow y en la [integración oficial de Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations).

La firma permite identificar al editor; no garantiza que SmartScreen omita inmediatamente sus avisos de reputación. Ver [reputación de SmartScreen](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation). No pedir a los usuarios que desactiven Defender. El error anterior de `new_ArmotuSitio IDE.exe` ausente no queda demostrado ni resuelto por agregar firma.

### Checklist de incorporación

- DONE: integración de firma, verificación obligatoria de editor y sello de tiempo; sin fallback inseguro.
- VERIFIED local: pruebas de configuración, selección de archivos, rechazo de enlaces y rechazo real de archivo sin firma en Windows; contratos de orden de empaquetado y publicación.
- BLOCKED externo: cuenta, identidad verificada, permisos, variables, secretos y aprobación de costos.
- BLOCKED externo: firma positiva real y ensayo de instalación/actualización/desinstalación del candidato firmado.
- Sin recursos contratados, secretos configurados ni release ejecutada durante la preparación del PR.

Regla operativa: usar PowerShell 7 (`pwsh.exe`) igual que el runner; Windows PowerShell 5.1 puede bloquear scripts con su política local. No cambiar la política del equipo ni usar bypass para ejecutar las verificaciones.

Validación del PR: 100 tests únicos PASS entre `ats-authenticode`, `ats-autoupdate`, `ats-release-ci`, `ats-release-script`, `ats-release-state`, `ats-build-all`, `ats-release-retry`, `ats-release-check`, `ats-ci-changes` y `ats-linux-build-script`. Typecheck focalizado del módulo nuevo, ESLint de los TypeScript afectados, formatter y parseo YAML PASS. El checker Markdown solo informa LEN001: se respeta la regla del repositorio de no cortar párrafos a un ancho fijo. No se compiló ni firmó un instalador real.

Commit de implementación: `650576f00f5` (`feat(release): require verified Windows Authenticode signatures`), con revisión del diff y hook hygiene PASS. Rama: `feat/windows-authenticode-release`. Próximo paso externo: activar identidad/servicio y autorizar el ensayo; no mergear antes de completar esa configuración.
