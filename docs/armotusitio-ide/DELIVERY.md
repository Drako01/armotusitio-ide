# ArmoTuSitio IDE — delivery gates and product backlog

## Verified source contracts
- RedEvent: `redevent` package, `.harness/`, `pnpm harness:...`.
- ArmoTuSitio 2.0: `armotusitio-next` package, `harness/`, `pnpm harness:...`.
- Harness execution is only enabled for trusted VS Code workspaces and is always confirmed.
- Jobs are VS Code process tasks; the running task can be terminated and task completion is reflected in the explorer.
- Agent JSON plan is validated for duplicate IDs, cycles, hosts, basic shape and unsafe flags; validation does not execute the plan.

## Gates before any release
1. Run extension syntax/contract CI.
2. Verify extension activation, process termination and both project profiles manually on Windows.
3. Compile and smoke-test a redistributable Code - OSS app.
4. Review use of product identifiers, branding assets, license/extension marketplace terms and provenance.
5. Validate upstream synchronization and signed update manifests on real release artifacts.

## Not complete
The following are **not** implemented or proven: provider adapters and interactive chat, structured mission-control webviews, a live agent DAG orchestrator, worktree creation and merge review, memory indexing, architecture map, metrics/token telemetry, automatic CI remediation, GitHub Actions/PR actions, n8n control, database migration center, QA/security gates beyond current harness commands, signed installers, rollback, release updater, upstream sync robot.

This branch adds a useful harness task controller but must not be labelled full product completion. Do not merge solely on static contract tests.
