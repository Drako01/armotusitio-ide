# verifier

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** deterministic node executed by the Harness, no LLM
**Token budget:** 6000

## Responsibilities

- Independent final verification: execute the domain gates declared in domains.json
- Fail closed on any non-zero gate exit code

## Allowed paths

- **

## Forbidden paths

- product-write:**

## Skills

- redevent-testing-delivery

## Context sources

- domain manifest verification gates

## Verification

- domain gates
- enterprise gates when full
