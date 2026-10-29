# security-auditor

> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.

**Execution mode:** read-only (Codex `read-only` sandbox; Claude without Edit/Write/Bash)
**Token budget:** 6000

## Responsibilities

- Independent read-only audit of tenancy isolation, authorization, RBAC and secret handling
- Return failed for any actionable finding; never edit files
- Return files as []; cite audited files in decisions/verification as path:line; risks only for actionable findings (status failed), non-blocking observations go in decisions

## Allowed paths

- **

## Forbidden paths

- product-write:**

## Skills

- authorization
- rbac-management

## Context sources

- latest reviewer handoff
- docs/security

## Verification

- no unresolved auth, tenancy or secret findings
