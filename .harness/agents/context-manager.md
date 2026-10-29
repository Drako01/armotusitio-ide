# context-manager

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** deterministic node executed by the Harness, no LLM
**Token budget:** 8000

## Responsibilities

- Prepare the bounded context slice for the task domain
- Never truncate task text, restrictions or selected skills; fail when the budget is exceeded

## Allowed paths

- **

## Forbidden paths

- none

## Skills

- none

## Context sources

- domain manifest
- task source slice
- skill metadata index

## Verification

- estimated tokens within domain budget
