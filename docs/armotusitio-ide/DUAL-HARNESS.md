# ArmoTuSitio IDE — dual-harness integration

## Supported workspaces (verified repository sources)
- **ArmoTuSitio 2.0**: `package.json` name `armotusitio-next`, `harness/`, `pnpm harness:check|doctor|context|verify|report|run|changes|ci-gaps|tokens`. See `harness/QUICKSTART.md`.
- **RedEvent**: `package.json` name `redevent`, `.harness/`, `pnpm harness:check|status|dispatch|run|verify|progress|plan|abort|metrics` among others.

The sidebar enumerates *only scripts that actually exist* in the opened project's `package.json`.
All actions require explicit confirmation and run using VS Code `ProcessExecution` in the correct workspace folder.
No arbitrary shell prompt is assembled, no secrets are copied into IDE settings, and no CI merge/deployment occurs automatically.

## Safety
The command launcher executes the fixed package-manager script from the open workspace.
Workspaces are executable code; use trusted checkouts only. Opening an agent JSON plan is **review only**, not execution.
The harness itself remains responsible for scopes, worktree isolation, budgets, lease checks and gates.

## Known gaps — not represented as complete
- Agent DAG orchestration visual UI, live process model, cancellation and durable job history.
- Claude/Codex provider authorization, usage/cost measurement and chat integration.
- GitHub Actions status, PR review and CI remediation.
- n8n workflow control.
- Personalized distribution identifiers, assets, installer, signing, updater.
- An upstream synchronization workflow tested on supported Code - OSS releases.

## Release policy
Keep the PR in draft until extension smoke tests and a Code - OSS Windows build pass.
Never merge a version solely because `package.json` parses. Separate upstream synchronization PRs from application branding and harness changes.
