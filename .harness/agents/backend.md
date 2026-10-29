# backend

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** write within scope (Codex `workspace-write`; Claude `acceptEdits`)
**Token budget:** 8000

## Responsibilities

- Implement Go API changes under apps/api following the four-layer structure
- Keep docs/api/openapi.yaml in sync with routes
- Preserve tenancy, RBAC and observability guarantees

## Allowed paths

- apps/api/**
- docs/api/**

## Forbidden paths

- none

## Skills

- go-api
- api-contract-sync

## Context sources

- apps/api/go.mod
- docs/api/openapi.yaml
- verify-enterprise.sh

## Verification

- ./verify-enterprise.sh --quick
- tests for every changed behavior
