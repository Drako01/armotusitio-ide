# logger

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** deterministic node executed by the Harness, no LLM
**Token budget:** 8000

## Responsibilities

- Record the compact lifecycle outcome after all gates
- Deterministic node: writes the completion handoff only

## Allowed paths

- **

## Forbidden paths

- none

## Skills

- none

## Context sources

- verifier handoff

## Verification

- completion handoff persisted
