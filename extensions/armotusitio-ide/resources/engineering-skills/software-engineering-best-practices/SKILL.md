---
name: software-engineering-best-practices
description: Compact baseline of professional engineering practices applied while designing, implementing, refactoring or reviewing code - proportional, contextual, and the same for every provider.
---

# Software engineering best practices

## Use and proportionality

Apply this baseline while you design, write, change or review code, not only at the end. It is a set of questions, not a ceremony. Scale the effort to the risk and size of the change: a five-line task must not become fifteen classes, and a simple request must not turn into an architecture audit. Follow the workspace instructions, `AGENTS.md` and the conventions already in the project; never impose a new architecture without a concrete reason. Adapt every criterion to the project's language, framework and layering.

## Procedure

1. Read only the code and conventions the change touches. Find the simplest solution that meets the requirement.
2. Reuse what exists (functions, components, types, constants, queries) before writing anything; extend or parametrize it instead of copying it.
3. Make the smallest safe change. Leave unrelated behavior, branding and visuals alone.
4. Add or update the tests the change needs. Verify what was affected and widen only when the risk justifies it.
5. Report what changed, what was verified and any real limitation.

## Design and architecture

- SOLID, proportionally: one reason to change per unit, extension through new implementations instead of growing type switches, substitutable subtypes, small role-based interfaces, dependencies injected at real seams.
- KISS: the simplest design that solves the real problem. YAGNI: no variability without a current consumer. DRY: one authoritative place per rule, only when the copies share meaning.
- Separation of concerns, high cohesion, low coupling, encapsulation and modularity. Prefer composition over inheritance; inherit only for a true is-a with shared behavior.
- Clean Architecture or layers only when the project's size and boundaries justify them; respect the dependency direction already in place.
- Design patterns only when they remove real duplication or coupling; name the problem first. Keep extension points for demonstrated variants.

## Code quality

- Clean, readable, maintainable code: intention-revealing names that follow the project's conventions, small functions and classes with one clear responsibility.
- Consistent error handling: no swallowed errors, errors carry context, failures are loud and safe.
- Remove dead code you touch; avoid duplicated logic and abstractions with a single caller. Refactor safely and incrementally, keeping behavior and public contracts.

## Security

- Secure by design and by default: validate and sanitize input at every boundary, encode output, parameterize queries, apply least privilege, authenticate and authorize on the server, keep secrets out of code, logs and versioned files.
- Check the change against the OWASP risks it can touch (injection, broken access control, insecure configuration, vulnerable dependencies, sensitive data exposure).

## Testing and reliability

- Unit tests for logic, integration tests at I/O boundaries, end-to-end for critical user flows only when they matter. Design for testability.
- Cover the edge cases and the regression the change could cause. Make tests proportional to the risk and scope; fix the cause, never the test.

## Professional practice

- Use Conventional Commits when that is the project's convention. Keep documentation useful and minimal; update docs the change makes wrong.
- Preserve backward compatibility of public APIs, data and configuration, or state the break explicitly. Optimize performance only where it is measured or clearly material.
- For user interfaces apply accessibility (WCAG) and Nielsen's ten usability heuristics: visibility of system status, match with the real world, user control and freedom, consistency, error prevention, recognition over recall, flexibility, minimalist design, helpful error recovery and documentation. For mobile screens also apply the `mobile-ux-principles` skill.

## Depth on demand

This is the compact baseline. When the change's risk reaches a specific area, rely on its specialized skill instead of expanding this one: `engineering-principles`, `abstraction-auditor`, `architecture-guardian`, `safe-refactoring`, `evidence-code-review`, `design-patterns`, `testing-strategy`, `api-contract-integrity`, `security-by-design`, `performance-engineering`. Work under the `token-economy` rules at all times. This guidance never grants permissions or bypasses IDE controls.
