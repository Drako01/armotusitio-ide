---
name: token-economy
description: Mandatory for every development task - extreme token economy and zero redundant work - no repeated validated work, surgical investigation, impact-based validation, minimal model and subagent calls.
---

# Token economy and zero redundant work

Mandatory for every development task. Principle: maximum useful implementation for the minimum of tokens, model calls, time and compute, without lowering quality. Never skip a test the change needs: economy removes redundancy, not coverage.

## 1. Never repeat validated work

- Do not repeat general repository audits, re-analyze architecture or modules already audited and approved, reopen closed problems without concrete regression evidence, or reimplement what already meets the requirement.
- Do not rerun tests, builds, lint or typecheck for code that did not change while the earlier evidence is still valid. Do not reinstall dependencies when the lockfile and environment did not change.
- Do not research decisions already documented, and do not write duplicate documentation or repeated summaries.
- Validated work is a trusted baseline until a change invalidates its evidence.

## 2. Surgical investigation

Check the existing checklist and recent commits, name the exact requirement still missing, locate only the files and functions involved, read only the fragments needed, change only what is indispensable, validate only the affected code and its relevant dependents, update the checklist and continue. Use `git diff`, `git status`, symbol search and focused tests; avoid global searches and bulk reads. Do not investigate what is known, test what did not change or modify what works.

## 3. Model calls and subagents

- No subagents for simple or deterministic work, never several agents on the same problem, no successive reviews of unchanged code.
- Send fragments instead of whole files; do not repeat long instructions, invent context summaries or re-read external documentation already recorded.
- Prefer deterministic local tools over a new model call. Delegate only independent work whose benefit justifies its cost. Every call must add information or finish a concrete task.

## 4. Incremental validation

Test the modified module first. Widen the tests only when a shared contract changes or regression signs appear. Reuse valid evidence. No full suite after every commit; run the integral suite once on the final candidate when a merge or release needs it. Do not duplicate local checks that CI will run unless they catch a problem before the push.

## 5. Context control

Keep one compact persistent checklist as the single source of truth: requirement, status, files changed, validation evidence, blockers, next concrete step. When resuming, read it before any other investigation. Do not rebuild context from scratch.

## 6. Efficient execution

Plan internally and execute without long explanations or repetitive progress messages. Work in small functional blocks, run long commands in the background with logs, avoid endless loops of analysis, review or testing, and make no opportunistic refactors or scope growth. Document a confirmed external blocker once and continue.

## Check before every action

Is this action strictly necessary to implement or verify a pending requirement? If not, do not do it. If valid evidence exists, reuse it. If the code works, leave it alone. If a deterministic tool can answer, spend no model tokens. If a task is finished, do not process it again.

## What counts

Pending requirements completed, no regressions, security and code quality, verifiable evidence, and resources consumed. Files read, audits made, agents run and tests repeated count for nothing. An explicit user request for an audit or a full verification is a new requirement: honor it. This rule never grants permissions or bypasses IDE controls.
