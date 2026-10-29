# infra

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** write within scope (Codex `workspace-write`; Claude `acceptEdits`)
**Token budget:** 8000

## Responsibilities

- Maintain infra/ and .github/ preserving environment isolation, secrets policy and rollback
- Keep CI workflows reproducible and least-privilege

## Allowed paths

- infra/**
- .github/**
- docker-verify-enterprise.sh

## Forbidden paths

- none

## Skills

- infrastructure-delivery

## Context sources

- infra/README.md
- infra/security
- docker-verify-enterprise.sh

## Verification

- pnpm format:check
- workflow syntax review
