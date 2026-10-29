# api-contract-sync

## Purpose
Maintain API contracts and their consumers with backwards-compatible schemas, endpoint verification and documented migration strategy, without inventing endpoints.

## Workflow
1. Discover the current repository structure, language, commands and constraints; do not assume another project's layout.
2. Inspect the relevant files and existing contracts before suggesting changes.
3. Make the smallest additive change within the authorized scope, keeping compatibility and security boundaries.
4. Run applicable project-defined checks; report real results, missing tools and platform-specific limitations.
5. Record changed paths, decisions, risks and verification evidence without exposing credentials.

## Guardrails
- Never invent files, commands, routes, infrastructure or successful test outcomes.
- Never bypass workspace trust, access controls or fail-closed path validation.
- Avoid destructive Git operations, releases, deployments and network changes without authorization.
- Respect the existing project's skills and build system; this is reusable guidance, not a replacement for project authority.
