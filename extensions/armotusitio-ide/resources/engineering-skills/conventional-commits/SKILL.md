---
name: conventional-commits
description: Native commit guidance when the user requests commits - Conventional Commits, strict separation of implementation, tests and documentation, explicit staging, preserved hooks and authorization.
---

# Conventional commits and coherent changes

Apply when the user asks to create commits. Follow the [Conventional Commits 1.0.0 specification](https://www.conventionalcommits.org/en/v1.0.0/) and the project's conventions. This guidance does not grant commit permission, override an explicit no-commit instruction or authorize push, PR creation, merge or release.

## Message format

Use `type(scope): short description`; scope is optional. Mark a breaking change with `!` after type/scope or a `BREAKING CHANGE:` footer. An optional body explains relevant behavior and reasoning; footers record issues or breaking changes.

- Use lowercase English types and concise English scopes. Follow the project's or user's language for the description.
- `feat` adds behavior; `fix` corrects a defect; `refactor` changes structure without changing behavior; `perf` improves performance.
- `test` changes tests; `docs` changes ordinary documentation; `ci`, `build` and `chore` describe their respective operational purpose.
- These additional types follow project policy; the specification defines the semantic meaning of `feat`, `fix` and breaking changes without requiring this full type list.
- Describe the actual coherent change, not vague messages such as "updates" or "fix stuff".

## Strict separation for this IDE workflow

The user's policy is stricter than the specification: do not mix implementation, tests and ordinary project documentation in the same commit, even when they belong to one feature. Separate CI, build and maintenance changes by their own purpose. Split independent changes within one type as well.

Classify by purpose, not extension: distributed `SKILL.md` files and generated catalogs consumed at runtime are product artifacts and belong with their implementation. Contributor guides, runbooks and project documentation belong in `docs` commits. A regression-test change belongs in a separate `test` commit.

Plan meaningful groups before staging. Usually commit the implementation first, then its tests and documentation; respect actual dependencies. Avoid empty commits or artificial fragments with no coherent purpose. If a split would break an essential security or build invariant, explain the concrete dependency and request a bounded clarification instead of silently mixing types.

## Safe staging and verification

1. Inspect status, staged and unstaged diffs, repository instructions and the current branch. Identify the authorized files and coherent commit groups.
2. Preserve unrelated staged and unstaged work, including other people's changes. Exclude secrets and generated artifacts unless the project explicitly tracks them.
3. Stage explicit paths or reviewed hunks only; do not use `git add -A` or `git add .`. Verify the exact staged diff and prevent unrelated pre-staged files from entering the commit.
4. Run the affected checks on the combined candidate, review concrete correctness and security risks, and fix regressions. Reuse valid evidence while inputs stay unchanged; do not rerun whole suites after each split commit.
5. Create only the authorized commits and keep repository hooks enabled. Do not bypass hooks or weaken tests to obtain a commit.
6. After each commit, update the existing persistent checklist with its hash, purpose, included files, verification evidence, blockers and exact next step. Use the project's existing state rather than creating a second checklist.
7. Report final commit hashes and actual checks. Say when evidence covers the combined candidate; never imply that each intermediate commit was independently validated.

Do not amend, rebase, reset or otherwise rewrite history without explicit authorization. A commit request does not imply publication. Keep existing permission prompts, branch protections and approval controls intact; this skill is guidance only.
