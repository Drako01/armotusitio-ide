# ArmotuSitio IDE

Distribución personalizada de Code - OSS con herramientas locales para ArmotuSitio 2.0 y RedEvent.

## Inicio y apariencia

Ejecutá **ArmotuSitio: Inicio** desde la paleta o el botón de inicio de la vista lateral ArmotuSitio.
La pantalla se abre automáticamente en ventanas sin editores; podés desactivarlo en `atsHarness.showWelcome`.

- Agregá la carpeta de uno o ambos proyectos al workspace con **Abrir un proyecto**.
- Los comandos se obtienen de los scripts reales del harness de cada repositorio.
- Las ejecuciones del harness y sus resultados se muestran durante la sesión actual.
- Los logs siguen disponibles en las terminales de tareas del editor.
- Los accesos a Claude/Codex, contexto, worktrees, GitHub, n8n y planes usan las integraciones existentes.
- **Cambiar tema** abre el selector nativo. ArmotuSitio Dark es el valor inicial; tu preferencia tiene prioridad.

El logo de inicio y los íconos de Windows/Linux provienen de los PNG originales de ArmotuSitio 2.0.
El ícono lateral usa los trazos del SVG oficial, sin su fondo para permitir la máscara nativa del editor.
No se generó un logo nuevo. El nombre de aplicación, protocolo y almacenamiento tienen identidad propia.

## Desarrollo y validación

Prepará el entorno según [la guía de Windows](WINDOWS-BUILD.md). Antes del primer arranque, regenerá el cliente:

```powershell
node build/next/build-fast.ts --client-only
npm run compile --prefix extensions/armotusitio-ide
.\scripts\code.bat
```

La existencia de `out` no garantiza que sus recursos estén completos.
Si los íconos aparecen como cuadrados, verificá `out/vs/base/browser/ui/codicons/codicon/codicon.ttf`.
El comando anterior recupera los recursos del cliente, incluida esa fuente.
En PowerShell se usa Node directamente para conservar el argumento `--client-only`.
Después de regenerar, recargá la ventana del IDE o cerrala y abrila nuevamente.
Los recursos de aplicación requieren regenerar Electron o el paquete; un ejecutable anterior conserva su ícono.
El panel se compila con `npm run compile --prefix extensions/armotusitio-ide`.
Los cambios se cargan desde la extensión `extensions/armotusitio-ide`, sin modificar el workbench.

```powershell
npm run check --prefix extensions/armotusitio-ide
npm test --prefix extensions/armotusitio-ide
```

Los comandos requieren un workspace confiable y confirmación antes de ejecutar procesos.
`atsHarness.enabled` controla la detección de proyectos. Los worktrees conservan su confirmación propia.

## Límites actuales

El inicio es una vista de herramientas y tareas de la sesión, no un orquestador multiagente completo.
La ejecución de agentes usa las CLI instaladas; no integra un chat ni informa tokens que no recibe.
El acceso a n8n abre su dashboard; la integración GitHub consulta mediante `gh`.
No existe todavía un instalador firmado ni un actualizador propio validado.
No se configura acceso al Marketplace de Microsoft ni se agregan extensiones propietarias.

Consultá [el estado y las evidencias](DELIVERY.md) antes de considerar esta distribución una release.

## Compartir con el equipo

Consultá [la guía de distribución local](DISTRIBUTION.md) para generar la aplicación y el instalador de Windows.

Actions permanece desactivado en el fork por pedido del propietario.
