---
name: architecture-guardian
description: Check existing module ownership and dependency direction when a change crosses architectural boundaries.
---

# Architecture guardian

## Use and boundaries

Use for changed module dependencies, shared-package extraction, domain ownership or cross-layer behavior. Obtain applicable architecture records, affected entrypoints, public contracts, imports and deployment boundaries. Do not assume a target diagram describes implemented code. Do not impose Clean Architecture, hexagonal architecture, DDD or microservices on a project that does not use them.

## Procedure

1. Establish the implemented style from code and project rules: layered application, modular monolith, monorepo, ports and adapters, Clean Architecture or independently deployed services. These can coexist; repository layout alone does not determine runtime boundaries.
1. Identify ownership of domain decisions, application orchestration, persistence, transport and external integration in the changed flow. Locate authoritative state and invariants. Preserve the existing equivalent boundaries even when their names differ.
1. Draw only the affected dependency path. For each edge identify source, target, public entrypoint and declared rule. Trace imports and runtime calls, including callbacks or events that hide the actual dependency. Distinguish a cycle from harmless shared low-level dependencies.
1. In layered or Clean Architecture code, check the project's intended dependency direction. Where policy should be infrastructure-independent, place a port with the policy owner and the concrete adapter at the composition boundary. Dependency inversion is useful at a real seam; it does not require wrapping every utility.
1. In a modular monolith, inspect module public contracts and domain boundaries. Reject reaching through another module into its tables or internals when it bypasses an invariant. Preserve transactions needed for consistency; do not replace them with asynchronous events for aesthetic decoupling.
1. In a monorepo, distinguish a library from an executable or deployment unit. Before extracting shared code, verify real consumers, stable semantics and a named owner. Search the existing owner before adding a new package. Avoid shared dumping grounds and a second authoritative implementation of domain rules.
1. For actual services, inspect contract ownership, version compatibility, failure modes and consistency across process boundaries. Do not recommend a new network hop without a requirement that outweighs operational and failure cost.
1. Propose the minimum correction to an evidenced violation. Preserve public interfaces where possible through an adapter. Update a contract or architecture record only when the implemented boundary changes, and separate approved architecture decisions from speculative improvements.

## Examples and counterexamples

- A domain calculation imports an HTTP response type only to signal failure: return the existing domain result and map it at the transport boundary. Do not restructure the entire application.
- A shared library imports a concrete application bootstrap module, creating a documented forbidden dependency: show the edge and move composition into the application. Importing a stable public contract from an allowed lower-level package is not the same defect.
- Two products need the same versioned schema with identical semantics and a responsible owner: extend its existing shared package. Two screens merely displaying similarly named entities do not establish shared domain ownership.
- A small monolith with correct encapsulation and no independent scaling or delivery requirement can remain a monolith. A microservice diagram is not evidence that decomposition is necessary.

## Verification and output

Use the project's boundary checker, dependency or cycle checks when present; do not add a new framework by default. Verify the affected consumer and producer paths, including failure propagation and transaction behavior. If only imports were checked, say runtime boundaries remain unverified.

Return the detected style with evidence, changed dependency edges, the exact rule and invariant violated, concrete impact, smallest correction and affected gates. List uncertainty where ownership is undocumented. When the change follows existing boundaries, report that no architectural correction is needed.
