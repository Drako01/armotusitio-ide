---
name: testing-strategy
description: Select deterministic tests by changed contracts, failure modes, and regression risk.
---

# Testing strategy

Build evidence for the changed behavior and its failure modes; coverage percentages alone do not establish correctness.

## Scope and minimum context

Use when designing tests, addressing missing regression protection, or planning verification across boundaries. For a small change already covered by an applicable gate, reuse that evidence instead of proposing a new test framework. Read the exact diff, affected consumers, existing fixtures, project commands, and relevant CI requirements. Identify unavailable services before relying on them.

## Procedure

1. List changed observable contracts and plausible failures. Link each risk to an assertion and the lowest layer that can observe it reliably.
1. Reproduce a reported defect before fixing it when feasible. A regression test should fail on the old behavior for the expected reason, rather than fail because the new API is absent.
1. Use the repository's test runners, fixtures, and isolation conventions. Run focused checks first and the applicable project delivery gates after implementation stabilizes.
1. Control time, randomness, locale, ordering, and external boundaries. Use explicit synchronization for concurrent tests rather than sleeps. Reset owned state and verify cleanup.
1. Record commands, inputs or revision, environment, outcomes, and limitations. Reuse a passing check until its relevant inputs change.

## Select tests by risk

- Unit tests: business decisions, invariants, validation, error classification, and boundary values; assert observable results rather than private call order.
- Integration tests: persistence constraints, transaction rollback, query semantics, real serialization, and adapter boundaries. A database mock does not prove locking or uniqueness behavior.
- Contract tests: request and response compatibility, authorization, error codes, and generated client agreement across producer and consumer.
- Regression tests: the precise prior failure plus a nearby unaffected case that guards against an overly broad fix.
- Property-based tests: useful invariants over generated inputs, such as round trips or monotonicity. Save the seed and minimized counterexample.
- Mutation tests: use existing infrastructure when changed logic warrants it; inspect surviving mutations rather than maximizing a score mechanically.
- Concurrency tests: races, lost updates, cancellation, lock ordering, and cleanup under controlled interleavings.
- Security tests: permitted and denied actors, malformed inputs, resource ownership, and isolation where the product has such boundaries.
- Partial failures: timeout after a side effect, rollback, retry exhaustion, duplicate delivery, and interrupted recovery.

## Decision examples

For a same-key idempotency race, submit concurrent equal requests, a changed payload with the same key, and a different key. Assert stable replay semantics and durable row or event counts, not merely successful HTTP statuses. Use the real persistence engine when its constraints implement the invariant.

For a pure label change, existing rendering or accessibility checks may be sufficient. Do not add snapshots of every markup detail or a test that copies the implementation expression. A passing mock expectation that `save` was called does not prove the transaction committed once.

## Guardrails and output

Never remove required gates, weaken assertions, reduce the coverage denominator, or hide flaky failures to obtain green output. Distinguish a deterministic system test from an evaluation of a model's judgment. Prompt text checks cannot prove an AI always recognizes a defect.

Return a compact risk-to-test matrix, commands actually run, PASS/FAIL/WARN/SKIP/NOT VERIFIED status, evidence paths, and residual gaps. State which behaviors remain unproven and why. An unavailable integration environment is NOT VERIFIED, even when corresponding unit tests pass.
