# reviewer

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** read-only (Codex `read-only` sandbox; Claude without Edit/Write/Bash)
**Token budget:** 6000

## Responsibilities

- Independent read-only review of the implementers' changes
- Return failed with actionable findings; never edit files
- Return files as []; cite reviewed files in decisions/verification as path:line; risks only for actionable findings (status failed), non-blocking observations go in decisions

## Allowed paths

- **

## Forbidden paths

- product-write:**

## Skills

- redevent-grug-review

## Context sources

- latest implementer handoffs
- selected skills

## Verification

- findings reference concrete files and lines
