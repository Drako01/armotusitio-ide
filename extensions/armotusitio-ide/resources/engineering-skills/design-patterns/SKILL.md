---
name: design-patterns
description: Choose patterns for proven variation and lifecycle needs; avoid pattern-driven layers.
---

# Design patterns

Choose a pattern only when it resolves a concrete design pressure with less total complexity than the current code.

## Scope and inputs

Use for requests about patterns or a demonstrated need to vary behavior, adapt a boundary, or manage state transitions. Do not activate for cosmetic duplication or turn a small fix into a design exercise. Start with the affected callers, existing extension points, actual variants, ownership, and expected failure behavior.

## Decision procedure

1. Describe the current friction with a caller or change scenario. Identify which responsibility varies and which must remain stable.
1. Compare retaining the current implementation, a local function or conditional, and the smallest applicable pattern. Include the maintenance and testing cost of each.
1. Select the existing repository idiom when it solves the same problem. Do not introduce a second dependency injection mechanism or parallel event system.
1. Sketch the affected call path, ownership, disposal, error propagation, and compatibility before editing. Keep unchanged callers unchanged where possible.
1. Validate the actual variation or lifecycle requirement, then remove scaffolding that serves no consumer.

## Pattern selection heuristics

| Pattern | Useful pressure | Reason to decline |
|---|---|---|
| Strategy | Several real algorithms vary behind one use case | One stable algorithm with no demonstrated variant |
| Factory | Construction chooses implementations or coordinates required dependencies | A constructor call wrapped only for naming |
| Adapter | An external contract differs from a stable consumer contract | Both sides already share the same contract |
| Decorator | Orthogonal behavior composes around a stable interface | Ordering creates hidden business behavior |
| Observer | Independent consumers react to a published fact | The caller needs a synchronous result or transaction |
| Repository | Persistence details need a consumer-owned boundary | A generic CRUD wrapper hides required query semantics |
| Dependency injection | Ownership and substitution must be explicit | A new container only relocates simple construction |
| Command | Operations need queuing, undo, or durable dispatch | An object merely renames a direct function call |
| State | Allowed transitions and behavior vary by state | A small enum and validated transition suffice |
| Specification | Reused domain predicates must compose consistently | An expression framework replaces one simple condition |

## Examples and counterexamples

Two shipping providers expose different error and retry semantics. An adapter can translate both to the existing application contract while preserving provider-specific retry classification. Verify each translation and keep transport details outside the business decision.

A single in-process formatter does not need a factory, strategy interface, registry, and dependency injection container. Keep the function until an actual consumer requires variation. Similar-looking validation for unrelated domain invariants is not evidence that both need a shared specification.

## Verification and result

Exercise every real variant, rejected input, error translation, and relevant ordering or disposal behavior. For observers, prove unsubscription and partial-failure handling; for commands, verify duplicate and retry semantics when applicable. For state, test prohibited transitions as well as valid ones. Avoid mocks that merely reproduce the new abstraction.

Report the demonstrated pressure, alternatives, selected pattern or decision to use none, affected contracts, incremental change, and evidence. Mark speculative future benefits as assumptions. Do not claim flexibility alone justifies additional layers.
