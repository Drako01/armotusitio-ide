---
name: engineering-principles
description: Evaluate engineering tradeoffs, cohesion and complexity when deciding how to implement or simplify a change.
---

# Engineering principles

## Use and inputs

Use for a design decision, competing implementations or a request to improve maintainability. Obtain the concrete behavior requested, affected code and consumers, existing project conventions and the cost of leaving the code unchanged. For a small mechanical edit, apply existing conventions without starting an architecture audit. Other specialized skills own detailed abstraction classification, contract analysis and security assessment.

## Decision procedure

1. State the observable requirement and constraints. Separate current needs from imagined future consumers. Identify the owning responsibility before choosing a file or abstraction.
1. Inspect the smallest working path from input to output and its immediate dependencies. Name the invariants that must stay true and the actual reasons this code changes.
1. Compare the existing approach, a local change and the smallest reusable alternative. Include transition cost, failure handling, discoverability and testing cost, rather than counting lines alone.
1. Apply principles as questions with evidence. KISS asks whether a reader can follow the essential flow; YAGNI rejects variability without a current consumer. DRY centralizes one authoritative rule only when consumers share semantics and change reasons.
1. Apply SOLID proportionally: separate distinct change reasons; add extension points for demonstrated variants; preserve substitutability including errors and side effects; expose only what consumers need; invert dependencies at genuine policy or external-system seams.
1. Preserve cohesion, encapsulation and separation of responsibilities. Keep state transitions beside their invariants and avoid exposing mutable internals. Prefer composition when behavior can vary independently; retain inheritance when its substitution contract is real and stable.
1. Adopt domain-oriented vocabulary or bounded contexts when existing business complexity justifies them. Do not add DDD layers to a small utility. Prefer one authoritative domain rule over copies embedded in transport, persistence and UI.
1. Recommend the least complex option that satisfies the requirement. Explicitly say when the existing implementation is adequate. Record a deferred alternative only with the concrete condition that would justify it.

## Decision examples and counterexamples

- Two payment paths implement the same rounding policy and must evolve together: centralize the policy and test both consumers. Two similarly shaped validation loops enforce unrelated rules: keep them separate until shared semantics are established.
- A policy has two current interchangeable algorithms: composition can isolate the variation. One function with a single stable implementation does not need an interface and factory merely to satisfy SOLID vocabulary.
- A large service owns unrelated transaction and delivery lifecycles: separate responsibilities at their actual change boundary. A cohesive function is not defective solely because it exceeds an arbitrary line count.
- Low coupling does not mean eliminating every dependency. An explicit dependency on the owning module's public API can be simpler and safer than an event bus introduced for theoretical independence.

## Verification and output

For each recommendation state the concrete code location, principle involved, observed pressure, smallest change, tradeoff and affected verification. Check public behavior and failure cases when applying the change. Reuse valid test evidence while its inputs remain unchanged; do not claim that naming a principle proves correctness.

Return prioritized recommendations with an explicit retain/change/defer decision. Distinguish a defect from an optional improvement and explain why a new abstraction pays for itself. If no change is warranted, report that conclusion without manufacturing a cleanup task.
