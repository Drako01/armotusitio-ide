# Recuperacion y cupos locales del Harness nativo

> Ambito: `feat/native-harness-enterprise-upgrade`. Capacidades locales experimentales; no certifica sandbox OS, escrituras entre motores ni presupuestos monetarios.

## 1. Recuperacion de fence compartido

Los agentes directos, los workflows y las tareas nativas del IDE coordinan sus procesos mediante un unico fence por proyecto. La lease incluye un token de propietario, epoch monotono persistente y comprobacion de identidad antes de efectos importantes.

Un cierre inesperado puede dejar el fence ocupado. **Nunca se elimina automaticamente** ni se reutiliza solo porque el PID propietario ya no exista.

Procedimiento desde la paleta de comandos del IDE:

1. Confirmar que no existan tareas o workflows activos para ese proyecto.
2. Ejecutar las acciones separadas `ArmoTuSitio: Reconciliar estado nativo` o `ArmoTuSitio: Reconciliar workflows interrumpidos` cuando corresponda, y resolver los journals pendientes. Una escritura incierta debe conservarse para revision.
3. Verificar **en el sistema operativo** que no queden procesos de Codex, Claude o gates de la ejecucion anterior. Un proceso padre terminado **no implica** que terminaron todos sus procesos hijos.
4. Ejecutar `ArmoTuSitio: Reconciliar lock compartido obsoleto (confirmacion requerida)`. Hay dos confirmaciones independientes: consentimiento y verificacion manual de procesos.
5. El comando solo libera el fence si el propietario registrado ya no existe, el epoch e identidad del lock no cambiaron y no quedan locks locales, workflows en ejecucion, tareas incompletas o intenciones de rollback. Rechaza un propietario declarado como `project` porque el Harness externo todavia no participa del protocolo.
6. Si rechaza la operacion, conservar la evidencia. No borrar manualmente `shared-execution.lock` o `shared-execution.epoch` como solucion rutinaria, ni reiniciar writers inciertos.

Esta recuperacion es conservadora y requiere intervencion humana: **no demuestra aislamiento OS** ni transacciones distribuidas, y sus comprobaciones de filesystem no eliminan todas las carreras TOCTOU entre procesos maliciosos.

## 2. Limite opcional de invocaciones a proveedores

La configuracion `atsHarness.providerCallsPer24h` permite un limite entero de 0 a 1000 invocaciones **por proveedor y proyecto** durante una ventana movil de 24 horas.

- Valor predeterminado `0`: deshabilitado, para no modificar flujos existentes.
- Valores `1..1000`: se comprueba y reserva un credito **antes** de iniciar cada CLI de Codex o Claude.
- Los creditos se registran en el almacenamiento privado del IDE, sin prompts, credenciales, salidas, rutas del proyecto ni tokens de proveedor.
- El estado se puede consultar con `ArmoTuSitio: Consultar cupo local de llamadas de IA`.
- La escritura es serializada entre lectores concurrentes del mismo workflow y protegida por el fence compartido entre procesos del IDE.
- Un crash o cancelacion **no reembolsa** una reserva, porque no se puede demostrar que el proveedor no haya cobrado.
- Archivos de cuotas corruptos o cambios hacia atras del reloj generan bloqueo conservador, nunca reinicio silencioso.
- El limite solo cubre invocaciones lanzadas por estas rutas nativas del IDE. No controla llamadas desde terminales independientes, otros IDEs o Harnesses de proyecto que todavia no adopten el protocolo.
- **No es un limite USD, de tokens ni de facturacion.** Codex no ofrece aqui una garantia verificable de corte monetario por llamada; la contabilizacion real sigue dependiendo del proveedor.

La integracion MCP `atsIde.armotusitioMcp` es independiente de esta politica; no se modifican su transporte HTTP, endpoint ni autenticacion.

## 3. Comprobacion local (sin cuotas de IA)

Desde el checkout `feat/native-harness-enterprise-upgrade`:

```bash
node scripts/ats-harness-check.mts
npm test --prefix extensions/armotusitio-ide
npm run check --prefix extensions/armotusitio-ide
git diff --check
```

Las pruebas incluyen fallos de ownership, bloqueo de tareas pendientes, reconciliacion bajo guard, reservas concurrentes, ventana de 24 horas, ledger alterado, revocacion de Workspace Trust y rechazo del exceso de cupo **antes de iniciar el proveedor simulado**.

No se ejecutan modelos reales mediante estos comandos. Los resultados historicos de 252 PASS, 0 FAIL y 1 SKIP corresponden a un commit **anterior** a este lote y deben repetirse para acreditarlo.

## 4. Bloqueos que siguen abiertos

- Adopcion real del fencing por el Harness del proyecto y protocolo de ejecucion externa bidireccional.
- Sandbox Windows/macOS y sandbox validado para agentes con red; el wrapper Linux offline es solo una modalidad parcial.
- Rollback transaccional de modificaciones integradas y reanudacion granular tras writers inciertos.
- Presupuestos USD/tokens garantizados por el proveedor, quotas distribuidas y reglas de rate limiting globales.
- Pruebas de seguridad adversarial y builds completos de los tres sistemas operativos.
- E2E autenticado de Claude cuando exista cuota; no hay que solicitar llamadas reales ahora.
