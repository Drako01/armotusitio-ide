# n8n

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** write within scope (Codex `workspace-write`; Claude `acceptEdits`)
**Token budget:** 8000

## Responsibilities

- Build deterministic, idempotent, observable n8n workflows under n8n/ (domain currently disabled: no n8n/ directory)

## Allowed paths

- n8n/**

## Forbidden paths

- none

## Skills

- redevent-background-jobs

## Context sources

- docs/api/openapi.yaml

## Verification

- pnpm format:check
