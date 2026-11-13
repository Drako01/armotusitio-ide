# Claude Code parity matrix (2026-11-13)

Scope: what the ArmoTuSitio IDE Chat Harness offers against Claude Code CLI 2.1.x on the capabilities the
upgrade targeted. Every row names the IDE implementation and how it was verified. Nothing below was verified
with a paid model call: "fake" means a protocol-faithful fake run as a real process, "browser" a Playwright test
of the real webview, "unit" a Node test of the module.

| Status | Meaning |
|---|---|
| DONE | Implemented and verified locally with the evidence named in the row |
| PARTIAL | Implemented for the verifiable part; the limit is stated |
| BLOCKED | Needs a provider capability, quota, service or hardware that is not available |

## Subagents and teams

| Capability | Claude Code | ArmoTuSitio IDE | Status |
|---|---|---|---|
| Project-defined specialists | `.claude/agents/*.md` with model, tools and prompt | `.armotusitio/agents.json`: `planner`/`reviewer` profiles with instruction, model and turn limit; the file is data, never authority | DONE (unit) |
| Independent tools and permissions per agent | per-agent tool allowlist | Children are tool-free by design (no filesystem, shell, MCP or nested delegation); a profile may only lower limits | DONE, narrower on purpose |
| Delegation with minimal context | explicit prompt | `delegate_readonly` tool with the instruction only; profile context is prefixed as data | DONE (fake) |
| Concurrency and launch budgets | none built in | 2 concurrent, 2 launches per session, lowered by profiles; failed launches count | DONE (unit) |
| Write conflict prevention | shared worktree | Children never write; the parent holds the writer fence and lease | DONE (existing) |
| Traceability per agent | transcript | Timeline step per child with profile, model, turns, duration and reported tokens; the JSON result carries the same | DONE (unit) |
| Agent map with state, progress and usage | `/agents` | Control Center "Agentes de la tarea" (role, provider, status, duration) and "Consumo por proveedor" | DONE (browser) |
| Agent Teams (persistent inter-agent messaging) | experimental | Not exposed by either provider as a stable API; Codex `multi_agent` stays off | BLOCKED (provider) |
| Cancellation and cleanup | Ctrl+C | Parent stop cancels children; receipts from earlier turns are ignored | DONE (unit, fake) |

## Hooks and plugins

| Capability | Claude Code | ArmoTuSitio IDE | Status |
|---|---|---|---|
| Discover hooks, agents, skills, commands, plugins | settings and `.claude-plugin` | `/integraciones` lists `.claude/settings*.json` hooks, `.claude/{agents,commands,skills}` and plugin manifests with a SHA-256 digest; nothing is loaded | DONE (unit) |
| Inspect a configuration | editor | `/integraciones ver ID`: redacted, size-bounded content labelled untrusted | DONE (unit) |
| Enable or disable each integration | settings | `/integraciones habilitar` and `deshabilitar ID`: in memory, per project and digest; reset on restart | DONE (unit) |
| Run compatible hooks | all events, stdin JSON | Only `UserPromptSubmit` command hooks without options or stdin; confirmation on every run; IDE command policy; a failure cancels the send | PARTIAL (other events need their own mediation) |
| Effective permissions and risks shown | settings | The enable prompt states project, file, command, digest and that the hook never receives the message | DONE |
| Avoid MCP duplication | merge | MCP servers from Claude settings are never registered; `--setting-sources ''` and `--strict-mcp-config` stay in place | DONE (existing guard test) |

## Memory and context

| Capability | Claude Code | ArmoTuSitio IDE | Status |
|---|---|---|---|
| Persistent per-project memory | `CLAUDE.md`, auto memory | `DecisionLog` per project (locked JSON, 512 KiB, 500 records, redacted) | DONE (unit) |
| Confirmed decisions, conventions, verified solutions | manual edits | `/memoria guardar decision`, `convencion` or `solucion TEXTO`; only user commands write | DONE (unit) |
| Inspect, correct, delete | edit file | `/memoria`, `/memoria corregir ID TEXTO`, `/memoria quitar ID` | DONE (unit) |
| Relevance-based recall | whole file | Term match against the request, then recency; 2 KiB snapshot labelled as background data | DONE (unit) |
| No repeated context per turn | n/a | Native follow-ups resend the snapshot only when it changed | DONE (unit) |
| Prompt-injection protection | n/a | Memory never authorizes tools; model output is never recorded automatically | DONE |
| Deterministic compaction | auto-compact | Prioritized 4 KiB memory: decisions and requirements reserved, newest first | DONE (unit, saturation) |

## Tokens and observability

| Capability | Claude Code | ArmoTuSitio IDE | Status |
|---|---|---|---|
| Usage per session, agent and provider | `/cost` | `/costo`: last turn, child receipts, first token; Control Center per provider (input, output, cached) | DONE |
| Cache tokens | reported | Shown only when the provider reports them | DONE |
| Budgets per operation | none | `atsHarness.providerCallsPer24h`, `providerTokensPer24h`, `providerCostUsdPer24h`; launches fail closed at 100% | DONE (existing, unit) |
| Preventive alerts | none | One warning per limit at 80% of recorded use; `/costo` marks the near limit | DONE (unit) |
| Direct vs delegated comparison | n/a | Child results carry duration and tokens next to the parent turn | PARTIAL (no aggregate view) |
| Recommendations | none | `usage-unavailable`, `partial-usage`, `context-dominates` from recorded figures | DONE (unit) |
| Measured savings | n/a | Not claimed: no authenticated runs were made | BLOCKED (quota) |

## History and recovery

| Capability | Claude Code | ArmoTuSitio IDE | Status |
|---|---|---|---|
| Checkpoints per tool | `/rewind` | Tool checkpoints per turn; `/checkpoints` and the menu's "Historial de checkpoints" | DONE (unit, browser) |
| Before/after comparison | none | "Ver diff" opens the bytes before the tool against the file now, from a read-only content provider | DONE (unit) |
| Affected files and conflicts | none | Each file shows added, modified or deleted and whether a later edit blocks the restore | DONE (unit, browser) |
| Protect later human edits | none | A changed fingerprint blocks the whole restore; nothing partial | DONE (existing) |
| Keyboard and screen reader | TUI | Cards are labelled groups; focus moves to the title and back to the menu on Escape | DONE (browser) |

## Browser and remote sessions

| Capability | Claude Code | ArmoTuSitio IDE | Status |
|---|---|---|---|
| Agent-driven browsing, remote sessions, device continuity | Chrome extension, remote control | Not implemented: requires a separate service and authority (ADR in `CHAT_HARNESS_COMPETITIVE_PARITY_2026.md`) | BLOCKED |

## Known risks

- Hook commands run through the IDE command policy, not a shell; hooks that rely on shell features are reported as incompatible.
- Profiles and hooks are re-read and digest-checked between approval and launch; a changed file aborts the launch.
- Secret redaction in memory and hook output is heuristic.
- All PASS evidence is local; CI on the final SHA and authenticated provider runs remain pending.
