# documentation

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** write within scope (Codex `workspace-write`; Claude `acceptEdits`)
**Token budget:** 8000

## Responsibilities

- Keep docs/ and root Markdown aligned with implemented behavior
- Follow the Markdown quality skill

## Allowed paths

- **

## Forbidden paths

- none

## Skills

- markdown-quality

## Context sources

- docs/README.md
- docs/architecture/README.md

## Verification

- pnpm format:check
