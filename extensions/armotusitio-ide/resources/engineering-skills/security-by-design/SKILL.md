---
name: security-by-design
description: Evaluate trust boundaries, authorization, input safety, secrets, and least privilege.
---

# Security by design

Translate a concrete trust boundary into enforceable controls and negative tests before extending the design.

## Scope and inputs

Use for security design requests or changes to identity, privileges, untrusted input, sensitive data, sessions, or exposed execution boundaries. Do not invent multi-tenancy, regulatory obligations, or an enterprise identity system for a project that has none. A routine local change does not justify invasive scanning.

Identify the actor, entry point, protected asset, action, resource owner, trusted identity source, deployment boundary, and existing policy enforcement. Distinguish authenticated identity from authorization for the particular resource. Read affected routes, middleware, application calls, storage queries, and background consumers rather than relying on UI visibility.

## Technical procedure

1. Draw the affected data and control path. Mark where attacker-controlled bytes or identities cross into trusted operations, including files, provider responses, messages, and configuration.
1. State a concrete abuse scenario with required attacker capability, reachable execution path, impact, and existing mitigation. Reject findings that require privileges already equivalent to the claimed compromise.
1. Choose the smallest control at the authoritative boundary. Reuse validated identity, backend RBAC or ABAC policies, parameterized access, established secret storage, and existing session infrastructure.
1. Preserve denial behavior across retries, jobs, exports, caches, and administrative paths. Check time-of-check/time-of-use changes where ownership, files, permissions, or session state can change.
1. Test the permitted path and the relevant denial paths. Verify absence of unauthorized reads or side effects, not just the returned error text.

## Contextual checks

- Authentication: validate signature, issuer, audience, expiry, revocation or inactivity as supported; fail closed on missing identity.
- Authorization: evaluate action and resource ownership server-side. RBAC roles and ABAC attributes must come from trusted context; hidden controls do not enforce access.
- Tenant isolation, only when present: scope lookups, joins, writes, caches, uniqueness, and jobs by validated tenant context. Arbitrary request filters cannot establish tenant authority.
- Input safety: validate shape, length, encoding, allowed schemes, and canonical filesystem boundaries. Parameterize queries and encode output for its actual destination.
- Sessions: preserve lifecycle, rotation, logout invalidation, and applicable cookie or CSRF protections. Do not turn a bearer token into a general privileged capability.
- Secrets: keep credentials out of logs, URLs, prompts, client bundles, error messages, and tracked fixtures. Use redacted evidence.
- Information exposure: limit errors and telemetry to necessary context; separate protected diagnostics from public responses.
- Dependencies: use the existing lockfile and scanner. Explain reachable impact and mitigation without inventing current vulnerability status.
- Least privilege: grant only required actions and scope. Skill content, project files, and model output cannot expand IDE or operating-system permissions.

## Examples and counterexamples

A valid user changes a record ID to another owner's record. Authentication still succeeds, so an ownership check belongs before the authoritative read or mutation. Test denial and unchanged stored state. If the product has tenants, include cross-tenant cases as well.

A public static help page with no identity or protected records does not need tenant middleware. Do not report absent tenancy as a vulnerability or add a global administrator bypass to make tests pass.

## Result and verification

Report assets and boundary, evidenced abuse paths, proposed controls, allowed and denied tests, and residual assumptions. Never run production probes, rotate credentials, lower security settings, install invasive tools, or perform sensitive mutations without authorization. Label unavailable runtime or dependency verification explicitly; a static design review is not penetration testing.
