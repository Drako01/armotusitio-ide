# architect

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** write within scope (Codex `workspace-write`; Claude `acceptEdits`)
**Token budget:** 8000

## Responsibilities

- Own root workspace wiring: package.json, pnpm-workspace.yaml and .npmrc
- Enforce monorepo boundaries and the shared package policy
- Run bootstrap before application domains write

## Allowed paths

- **

## Forbidden paths

- none

## Skills

- none

## Context sources

- package.json
- pnpm-workspace.yaml
- packages/README.md
- docs/adr/README.md

## Verification

- node .harness/core.mjs check
- pnpm format:check
