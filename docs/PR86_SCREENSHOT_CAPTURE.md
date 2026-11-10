# PR #86 — capturas verificables del upgrade

Este documento **no equivale a aceptación visual**. El PR incluye código
de UI, pero la evidencia definitiva debe surgir del producto instalado.
No crear capturas mediante mockups o HTML recreado y presentarlas como reales.

## Protocolo

1. Instalar o abrir el candidato creado a partir del **SHA exacto del PR**.
   Registrar versión, sistema operativo, arquitectura, fecha y SHA del binario.
2. Abrir un workspace de prueba sin credenciales y con contenido sintético.
   No abrir cuentas, tokens reales ni nombres de clientes durante la captura.
3. Capturar en PNG directamente desde el IDE, sin alterar estados de interfaz.
   Guardar las pruebas en `docs/images/chat-harness/` con nombres estables.
4. Comprobar visualmente que cada imagen coincide con una interacción real;
   ocultar antes de publicar cuentas, rutas privadas y claves.
5. Registrar en el checklist el SHA, la plataforma y el procedimiento
   de reproducción, indicando PASS, FAIL o NO EJECUTADO.

## Matriz de capturas requeridas

| Archivo destino | Estado requerido |
|---|---|
| `01-chat-harness-central.png` | Chat central con la sesión y timeline |
| `02-chat-harness-lateral.png` | Misma sesión en la barra lateral |
| `03-multimodal-preview.png` | Imagen pegada o arrastrada en vista previa antes de consentimiento |
| `04-documento-permiso.png` | Selección/confirmación de PDF o notebook sintético |
| `05-mcp-approval.png` | MCP local de prueba con autorización/denegación |
| `06-checkpoints-granulares.png` | Selector real de checkpoints, sin rutas sensibles |
| `07-extensiones-armotusitio.png` | Sección con seis extensiones instaladas/activas |
| `08-accesibilidad.png` | Foco de teclado y evidencia de navegación |

## Criterios de salida

- Windows x64 instalado: apertura, teclado, lector de pantalla,
  guardado/reanudación de sesión, cinco permisos negativos y seis extensiones.
- Linux/macOS/WSL instalados: marcar NO EJECUTADO cuando no exista entorno,
  nunca inferir PASS de unit tests.
- Codex/Claude autenticados: requieren autorización de cuota y
  un escenario real sin credenciales en las capturas.
- Checkpoints y herramientas: cada captura debe tener prueba funcional
  asociada; una captura por sí sola no verifica aislamiento ni permisos.

**Estado a 2026-11-10:** NO EJECUTADO. Los únicos binarios disponibles en el equipo de desarrollo son IDE 1.145.2 (commit `45d7e833c3d`), anteriores a este PR, y no sirven como evidencia. Falta construir el candidato desde el SHA final con `scripts/ats-package-windows.mts`. Sin capturas auténticas nuevas en la rama.
El checklist permanece abierto hasta obtenerlas.
