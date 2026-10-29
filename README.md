# ArmoTuSitio IDE — Native Harness integration increment

This patch adds a **native IDE-owned local execution engine**. Tasks are kept under the IDE extension global storage, scoped by a SHA-256 digest of the canonical workspace root. Projects do **not** need their own `.harness` directory. GitHub, Work Management and AI integrations remain optional.

## Commands

- `ArmoTuSitio: Diagnóstico del Harness nativo`
- `ArmoTuSitio: Crear tarea nativa`
- `ArmoTuSitio: Ejecutar tarea nativa`
- `ArmoTuSitio: Estado de tareas nativas`
- `ArmoTuSitio: Reconciliar estado nativo`
- `ArmoTuSitio: Cancelar tarea nativa`

## Scope

This is an incremental implementation, **not completion of PLAN_IDE.md**. It does not yet ship an AI agent scheduler, portable bundled runtime, automatic retry, multi-host remote support or parity with all RedEvent lifecycle features. Non-native project adapters remain unchanged. It does not create a release or activate GitHub Actions.

## Apply

Extract at the repository root (`feat/harness`). The changes consist of two TypeScript source files, a test and additive edits to `extensions/armotusitio-ide/extension.ts` and `extensions/armotusitio-ide/package.json`. Run `python tools/apply-native-harness.py` from this package only if you inspect the script first. Existing files are not overwritten by the archive.

## Hardening increment v4

- Unknown/foreign-host locks are **not** treated as stale or removed.
- Task files are bounded in size, symlink task entries are rejected, and schema/plan revision are verified.
- Stale-lock reconciliation is opt-in, never an implicit retry.
- Project workdirs are canonicalized and checked for symlink escape both at creation and execution.
- Persisted in-progress attempts require reconciliation before any new execution.
- Output is bounded and excessive output terminates the child process.
- Empty plans are rejected, so an execution cannot report success without actually running a gate.
- Existing RedEvent/ArmoTuSitio project-owned Harness entrypoints are not superseded by the native engine.

Tests run locally with Node 22 (type stripping): eleven passing. The patch installer was tested twice against a synthetic checkout, including command placement and idempotence. Full VS Code extension check, Windows/WSL testing, packaging, and CI parity have **not** been verified in this environment.

**Security limitation:** the current script suggestion uses `npm run`, which can execute shell-defined package scripts after explicit approval. Treat package scripts as untrusted until reviewed. Secret redaction by patterns is not a guarantee against arbitrary exfiltration by user-approved processes.

## V4 fixes and limitations

- Fixes registration of the five new commands into `contributes.commands` instead of the similarly named chat-participant command array.
- Validates that a second patch application is idempotent.
- Adds persisted-attempt schema checks, preventing corrupt state from being executed.
- Adds a concurrent-attempt regression test and an additional lock recheck before reconciliation.
- The status is **not** an E2E validation of a built IDE. For a complete PLAN_IDE delivery, agent orchestration, credential storage, process-tree cancellation on each host, remote runtime, state migrations and distribution acceptance remain open.

## V5: cancellation and local commit

- Adds `atsHarness.nativeCancel` (explicitly selected workspace, modal confirmation, no automatic invocation).
- Rejects an already-aborted execution before persisting an attempt.
- Extends suite to 12 passing unit tests locally (Node 22).
- `tools/commit-native-harness.sh` applies changes and creates a commit **locally** without requiring local tests first (run them afterwards). It does not push. It requires `feat/harness`. Review pre-existing changes before using it; only the listed integration files are staged.

Manual commands from the working copy after extraction:

```bash
python tools/apply-native-harness.py
node --experimental-strip-types --test extensions/armotusitio-ide/test/native-harness.test.mts
(cd extensions/armotusitio-ide && npm run check && npm run test)
git add extensions/armotusitio-ide/{extension.ts,package.json,src/native-harness.ts,src/native-integration.ts,test/native-harness.test.mts} tools/{apply-native-harness.py,commit-native-harness.sh}
git diff --cached --check
git commit -m 'feat(ide): add native project-independent harness engine and commands'
```

Remote publishing is intentionally not performed: the plan requires a fresh admin verification that GitHub Actions is disabled before any push.


## Incremento v6 — scheduler DAG acotado

- Los pasos independientes se ejecutan en tandas de hasta dos procesos, con evidencia persistida en el orden del plan.
- Los dependientes solo empiezan cuando todos sus prerrequisitos terminaron correctamente.
- Un fallo o cancelación detiene el avance del DAG; el intento no puede terminar con `passed`.
- Reconciliación exige que el identificador de tarea/intento y el inicio del lock sigan siendo los mismos, además del PID y hostname.
- Se agregaron pruebas para concurrencia y fallo en tanda, completando 14 pruebas del motor.
- Esto NO representa cumplimiento del plan completo: faltan proveedores reales, integración E2E y empaquetado.


## Incremento v7 (seguridad)

- Revalidación temprana de identidad del lock antes de alterar tareas durante reconciliación.
- Rechazo explícito de archivos de tarea que sean enlaces simbólicos.
- 15 pruebas unitarias aprobadas en Node.js; no es una validación del IDE empaquetado.
