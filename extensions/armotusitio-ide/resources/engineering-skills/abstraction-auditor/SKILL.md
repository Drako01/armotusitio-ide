---
name: abstraction-auditor
description: Audit interfaces, indirection and coupling to decide which abstractions to retain, simplify or avoid.
---

# Abstraction auditor

## Use and minimum evidence

Use when reviewing an abstraction, oversized interface, generic layer or proposed extraction. Start with the relevant implementation, actual callers, implementations and tests, plus a concrete maintenance or correctness concern. Do not infer a defect from names such as Manager, Repository or Factory alone. For a straightforward behavior fix without abstraction pressure, stay within the fix.

## Audit procedure

1. Write the abstraction's promise in one sentence: what varies, which invariant it protects and which consumers rely on it. Trace one ordinary path and one failure path through the indirection.
1. Find actual implementations and consumers. Distinguish a public compatibility seam, an external-system adapter and test isolation from an interface created solely for a hypothetical second implementation.
1. Examine consumer requirements. A consumer that implements irrelevant methods, throws unsupported-operation errors or receives a broad service to access one capability may indicate an oversized interface. Preserve compatibility through a narrow adapter when changing a public interface would break callers.
1. Separate semantic duplication from textual similarity. Shared rules with the same authority and change reason justify consolidation; superficially similar workflows with different invariants often do not.
1. Trace dependencies to detect circular imports, deep access to concrete internals and business policy coupled to database or transport details. Explain the reachable dependency path and violated ownership rather than prescribing layers by name.
1. Check lifecycle assumptions: required init-before-use calls, order-dependent setters, mutable global state and hidden transaction boundaries. Identify the invalid sequence that causes temporal coupling to fail.
1. Review generic repositories, factories, helpers and inheritance hierarchies for lost guarantees. Look for erased query capabilities, switches repeated outside the abstraction, unchecked casts, unrelated responsibilities and subclasses weakening invariants.
1. Compare retain, inline, narrow, split and adapt. Choose the smallest transformation addressing demonstrated harm; account for public consumers, errors, concurrency and rollback cost. Auditing does not authorize a rewrite.

## Classification

| Verdict | Evidence required | Default action |
| --- | --- | --- |
| Necessary | Protects a real invariant, compatibility seam or current variation | Retain; repair only concrete defects |
| Convenient but optional | Improves a present workflow with bounded cost | Keep or simplify according to local conventions |
| Premature | Models unrequested variation with no current benefit | Avoid adding it; consider local simplification |
| Harmful | Creates a reachable failure or measurable maintenance obstacle | Propose the minimum corrective change |

One implementation alone does not prove an interface is premature. A stable plugin or external provider boundary may require it. Many implementations alone do not prove a good abstraction if they share no substitutable contract.

## Examples and counterexamples

- A generic repository forces every caller to reconstruct tenant predicates and transaction rules: show the unsafe caller and move the invariant to the responsible operation. Do not replace every repository in the project.
- A factory switches among two real providers with different construction needs: retain it. A factory wrapping a single pure constructor without policy or lifecycle benefit may be unnecessary.
- An interface requiring a file exporter to implement database transactions violates consumer cohesion. A narrow adapter can isolate the required export capability without a broad migration.
- A helper used by two unrelated domains with subtly different rounding rules should remain separate. Removing it solely to reduce indirection can also be wrong when it owns one genuine invariant.

## Verification and output

Return a bounded inventory: location, promise, consumers, classification, evidence, cost of change, smallest recommendation and checks. Include counterevidence and confidence. State “No refactoring required” when appropriate. For an applied change, verify representative callers and the invalid lifecycle or invariant case; a shorter dependency graph alone does not prove preserved behavior.
