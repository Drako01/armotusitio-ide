# ArmoTuSitio IDE — foundation (0.1.0)

This branch establishes a **low-upstream-diff** foundation over Code - OSS.

## Implemented
- ArmoTuSitio Dark theme with color tokens sourced from `Drako01/armotusitio2.0/tailwind.config.ts` and `app/globals.css`: `#141b22`, `#2c3e50`, `#f9ed32`.
- Workspace-local harness detection via `.harness` and `package.json` scripts.
- Activity bar Harness & Agents view with check/status/run entry points, multi-root workspace awareness, and confirmations for check/status.
- The existing VS Code workbench/editor remains untouched.

## Run in development
Follow upstream VS Code development setup for your platform, then select **ArmoTuSitio Dark** in Color Theme.
Open a workspace containing `.harness` and `harness:check` in `package.json`.
The initial extension uses built-in Node APIs and VS Code APIs, with no external dependencies.

## Important limitations / next work
- The `run` action opens a terminal with the command **unexecuted**, so project-specific arguments must be entered manually. This is intentional: harness argument formats differ across projects.
- The sidebar is a command launcher, not yet a structured multi-agent orchestration dashboard.
- Branding of the installed application and the updater are **not yet implemented**. Separate application identifiers and release signing are prerequisites.
- Code - OSS redistribution does not automatically grant Microsoft Visual Studio Marketplace access or rights to proprietary extensions.
- Keep custom UI in `extensions/armotusitio-ide/`. Rebase/merge upstream into this fork only after CI verification; do not auto-publish unvalidated artifacts.

## Next increments
1. Exact branding assets and independent distribution identifiers.
2. Typed adapters for RedEvent and ArmoTuSitio harnesses (status JSON, jobs, cancel, progress).
3. Tests for process lifecycle and extension UI.
4. Upstream sync PR workflow and signed Windows release pipeline.

This is a **foundation commit**, not a verified production binary.
