---
name: evidence-code-review
description: Review a diff or pull request for concrete defects with triggering paths, impact and targeted verification.
---

# Evidence code review

## Scope and inputs

Use for a requested review of a working tree, staged diff, commit, branch or pull request. Establish the exact base and head, changed paths, project rules and available verification evidence. A review remains read-only unless implementation is also authorized. Do not equate a request for review with permission to publish, merge or alter code.

## Review procedure

1. Bound the review and record exclusions. Inspect the complete intended diff, then only the surrounding code, consumers, tests, contracts and configuration needed to understand changed behavior. Reuse current evidence and avoid unrelated repository audits.
1. Reconstruct a reachable execution path for each candidate: concrete input, entrypoint, relevant authorization and state, changed operation, missing mitigation and observable failure. Check whether another layer already prevents it.
1. Evaluate correctness and invariants; module ownership and dependency direction; security and sensitive data; retries, cleanup and partial failures; maintainability with concrete impact; algorithmic or resource limits; regression coverage; public compatibility.
1. Check failure paths proportionally: denied access, invalid input, cancellation, duplicate delivery, concurrent updates and rollback when those paths exist. Do not assume every project uses tenancy, queues or network services.
1. Compare with the baseline to distinguish introduced regressions from pre-existing debt. If the change newly exposes an old defect, explain the new reachable path. Separate unrelated debt and optional suggestions from findings.
1. Run or inspect the smallest relevant checks. A passing happy-path test does not dismiss a reachable failure; a speculative missing test alone does not establish a product defect. Clearly identify missing evidence where the risk cannot be resolved.
1. Prioritize concrete findings by impact and confidence. Withdraw a candidate when its trigger is impossible or existing protection covers it. Do not manufacture findings or downgrade a failing assertion to obtain a favorable verdict.

## Finding standard

Every finding includes all of the following:

- Severity: critical, high, medium or low, justified by concrete impact.
- Confidence: high, medium or low, tied to available evidence and assumptions.
- Category: correctness, architecture, security, reliability, maintainability, performance, testing or compatibility.
- File and exact line in the reviewed revision, with the relevant changed location.
- Evidence and the triggering execution path, including absent mitigation.
- Observable impact and whether the defect is introduced, newly exposed or pre-existing.
- Smallest safe correction, preserving existing contracts where possible.
- Targeted verification that would fail before the correction and pass afterward.

Critical means compromise, broad outage or irreversible corruption; high means major incorrect behavior or significant exposure; medium means a bounded reachable failure; low means a concrete nonblocking defect. Do not infer severity from code size or terminology.

## Examples and counterexamples

A retry handler inserts a record before acknowledging delivery and the new path omits the existing unique key: identify the duplicate request sequence, resulting rows and regression test. Calling code “non-idempotent” without showing a retry path is insufficient.

A renamed response field breaks a checked-in consumer that still reads the old name: cite both locations and the failing response shape. An internal variable rename with unchanged serialization is not contract drift.

A long but cohesive function is not automatically a maintainability finding. A broad interface that forces a real caller to implement an unsafe no-op may be actionable when that path is demonstrated. Do not recommend an abstraction solely because a pattern exists.

## Result and limitations

Return findings first, followed by the exact scope reviewed, checks and their real outcomes, exclusions and residual risks. Say “No actionable findings in the reviewed scope” when supported. Never present a partial review as exhaustive, and never treat unavailable model, platform or integration checks as PASS. Keep readiness conditional on unresolved blocking evidence rather than issuing a numeric quality claim unsupported by verification.
