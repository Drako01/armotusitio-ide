# Native engineering skills

The Chat Harness includes ten engineering capabilities without a global skill installation, project checkout, extra model call or new execution engine. Claude Code and Codex receive the same selected guidance through the existing structured and native transports.

## Available capabilities

| Priority | Skill | Decision it supports |
|---|---|---|
| P0 | `engineering-principles` | Apply KISS, DRY, YAGNI and SOLID proportionally to a concrete problem |
| P0 | `abstraction-auditor` | Classify necessary, optional, premature and harmful abstractions; keep good code unchanged |
| P0 | `architecture-guardian` | Discover existing architecture and enforce evidenced dependency boundaries |
| P0 | `safe-refactoring` | Preserve public behavior, consumers, errors and side effects through minimal transformations |
| P0 | `evidence-code-review` | Report reproducible defects with location, trigger, impact, confidence and verification |
| P1 | `design-patterns` | Compare a justified pattern with a simpler alternative |
| P1 | `testing-strategy` | Choose deterministic regression, integration, contract and concurrency tests by risk |
| P1 | `api-contract-integrity` | Keep implementation, specification, validation and consumers compatible |
| P2 | `security-by-design` | Inspect real trust boundaries, permissions, secrets and isolation |
| P2 | `performance-engineering` | Identify measurable resource problems before proposing optimization |

## Use and selection

`/skills` lists project and native skills with their source. `/skill safe-refactoring Preserve the public API` explicitly loads one skill for the current turn, including when the request itself does not contain a recognized trigger. A selected skill never starts commands automatically.

Ordinary requests use deterministic Spanish and English intent rules. An abstraction audit selects `abstraction-auditor` and `engineering-principles`; a refactor selects `safe-refactoring` and `architecture-guardian`; a PR audit starts with `evidence-code-review`. Explicit testing or security requirements and affected contract/security files can add a distinct capability. Unrelated conversation does not load engineering bodies merely because it mentions a source file.

Selection considers the current request and mentioned paths; approved plans also supply their actual file list. Language, architecture and risk hints are optional selector inputs, never guesses about frameworks or multi-tenancy. The selector does not crawl the repository or introduce another AI classifier. It is intentionally conservative; use `/skill` when intent wording is not recognized.

Automatic selection admits at most three skills and 12 KiB of rendered guidance, then retains only complete skill blocks that fit the remaining prompt budget. Omitted selections remain visible in the selection trace. A custom project skill can be larger than this automatic budget and still be invoked explicitly under the existing project reader limit of 64 KiB. Explicit invocation retains existing attachment behavior; it is not truncated silently to the automatic budget.

The catalog indexes only names, descriptions and hashes for shipped skills. Selected bodies are read and digest checked each turn. The existing project catalog still hashes project files during discovery for its integrity contract; it does not inject their bodies during discovery. Persistent native conversations omit identical previously delivered automatic guidance when continuing that provider session; a fresh-session fallback receives complete currently selected guidance. Structured runs receive self-contained guidance. Reset clears the delivery cache.

## Precedence and safety

Names are case insensitive. The first existing source wins: `.agents/skills`, `.codex/skills`, `.claude/skills`, then the distributed native catalog. A workspace skill with the same name specializes the native capability. Distinct project skills remain available for explicit invocation and approved plans. Existing project-specific Harness authority is unchanged.

All content is untrusted guidance within the current request and higher-priority rules. Closed data blocks escape embedded closing tags, redact secrets and explicitly deny any permission grant. Permissions, workspace trust, command policy, provider sandbox, leases and approval broker retain authority. No text classifier can prove that an arbitrary model will resist every instruction injection; tests certify the data and execution boundaries, not that guarantee.

The shared reader checks canonical roots and parents, rejects linked paths, bounds reads even when a file grows, and rejects changed digests before supplying selected content. Unsafe or invalid catalogs fail closed. No content cache survives changes. These checks are not a kernel filesystem sandbox against an adversary concurrently rewriting every checked path.

The existing `.codex/skills` checkout conventions and the independent `src/vs/sessions/skills` UI action workflows retain their contracts. They are not copies of this Chat Harness pack.

## Distribution and development

The canonical bodies live in `extensions/armotusitio-ide/resources/engineering-skills/<name>/SKILL.md`. `catalog.json` is generated metadata, not a second content source. It ships alongside the extension and works without the original checkout or global developer paths. Both native providers consume the same resources.

Edit a body with a matching YAML `name` and single-line `description`. Keep the document specialized: scope and exclusions, minimum evidence, technical procedure, tradeoffs, counterexamples, verification and expected output. Run `node sync-engineering-skills.mts --write` from the extension directory to refresh hashes. `npm run check`, `npm run compile` and `npm run check:native-package` reject stale indexes; `.vscodeignore` explicitly includes all ten bodies and their catalog. Add a new catalog capability only with matching selector tests and a distinct responsibility; the current ten-name catalog is deliberately closed and validated.

No additional dependencies are required. Generic principles were adapted from bounded RedEvent skills and ArmotuSitio's skill manifest; business routes, commands, roles, credentials and machine-specific skill paths were not copied.

## Verification boundaries

Deterministic suites exercise the catalog without body files, workspace precedence, invalid metadata, absent skills, changed digests, traversal, actual Windows junctions, excessive sizes, redaction, closed blocks, selection negatives and budgets. Chat integration tests use scripted Claude/Codex runtimes; one test invokes the real host integration with a synthetic Codex process to check final prompt composition. These tests do not call a live model.

A bounded independent Codex sample applied the shipped guidance to eight supplied scenarios. It classified unused interface obligations as an optional simplification without inventing a runtime failure; preserved two superficially similar but semantically distinct reductions; found a documented domain-to-infrastructure dependency violation; rejected an incompatible refactor signature; found an API/client response mismatch; requested missing retry/idempotency tests without asserting unproven duplication; declined a performance finding for a CSS color change; and identified an authenticated cross-tenant query. This is an observed review sample, not an automated semantic certification or a promise about future model decisions.

Live Claude/Codex end-to-end acceptance, clean installer startup, Linux/WSL execution and remote CI must be reported separately when performed. A resource or VSIX packaging check is not an installer release.
