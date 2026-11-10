---
name: safe-refactoring
description: Refactor an existing implementation with explicit before-and-after evidence that observable contracts remain intact.
---

# Safe refactoring

## Scope and inputs

Use for an authorized internal transformation that must preserve observable behavior. Obtain the exact scope, current code, callers, contract definitions and available tests or equivalent evidence. Separate an intentional behavior change from a refactor before editing. Do not include opportunistic API redesign, migrations or unrelated cleanup.

## Required workflow

1. Inventory observable contracts and consumers: public names, signatures and types; HTTP or message schemas; persisted data; error identities and status codes; side effects and their ordering; cancellation; concurrency; resource ownership; externally visible timing guarantees.
1. Establish the baseline on unchanged code with existing tests, a bounded characterization test, representative recorded outputs or another reproducible oracle. Capture inputs and relevant environment. A test added only after the refactor cannot establish prior behavior by itself.
1. Identify risks by transformation. Moving code can alter initialization order; extracting a helper can change captured state; replacing iteration can change side-effect order; changing await boundaries can affect atomicity and cancellation. Name the concrete invariant at risk.
1. Choose the smallest transformation that achieves the authorized goal. Keep compatibility adapters if required by current consumers. Avoid combining a rename, algorithm replacement and persistence redesign into one unreviewable step.
1. Implement incrementally. Preserve error propagation, cleanup in every exit path, transaction scope and synchronization. Avoid broad mechanical rewrites that obscure the behaviorally relevant diff.
1. Run affected verification. Include regression inputs from the baseline and meaningful boundary, failure and concurrency cases. Use repository-native tooling; reserve broader gates for dependencies and behavior actually affected.
1. Compare before and after under equivalent inputs and conditions. Normalize only nondeterministic fields that are irrelevant to the contract; never normalize away a changed error, missing event, ordering guarantee or persisted value.
1. Report evidence, incompatibilities and residual uncertainty. If a critical contract cannot be shown preserved, say so explicitly and identify the missing oracle or environment. Passing compilation proves type compatibility only within its checked scope.

## Transformation heuristics

- Preserve stable public entrypoints while moving internal responsibility behind them. Verify both ordinary consumers and dynamically referenced names such as configuration keys or reflection hooks.
- Keep synchronous and asynchronous failure behavior equivalent when callers depend on it. A rejected promise is not always interchangeable with an immediate exception.
- Test observable persistence semantics: null versus absent fields, serialization defaults, ordering where promised and transaction rollback. An in-memory mock may not prove database behavior.
- For concurrent paths, compare synchronization and ownership, not just final values in a serial test. Exercise cancellation and cleanup without relying on arbitrary sleeps.
- Treat an existing accidental behavior as part of the compatibility question when consumers depend on it. Fixing it is a separate behavior change requiring explicit scope.

## Examples and counterexamples

A parser helper extraction returns identical values and errors for a representative corpus before and after; callers retain their original signature. This can be a refactor. Renaming a persisted JSON key because the new helper uses a cleaner property name is a schema change.

Splitting a handler into orchestration and mapping functions can preserve behavior. Moving a write outside its transaction or parallelizing two previously ordered notifications changes semantics even if the happy-path response stays the same.

If the existing small function is cohesive and the proposed split adds indirection without a concrete gain, retain it. A request to refactor does not require inventing a transformation when the stated problem is absent.

## Output

Return scope, protected contracts and consumers, baseline oracle, transformation and rationale, comparison results, exact checks and residual risks. Label each check PASS, FAIL, WARN, SKIP or NOT VERIFIED. Never report “behavior preserved” for an unverified critical path; state the practical limit of the evidence.
