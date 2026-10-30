# Native Harness Enterprise Upgrade — implementation ledger

Branch: `feat/native-harness-enterprise-upgrade`
Base: `main`

This ledger separates code shipped on the branch from work that has **not** been implemented or validated. Do not characterize this branch as an enterprise AAA completion or auto-merge it until all required gates are green.

## Implemented in this branch

- [x] Explicit approval for launching native Codex / Claude CLI agents from an IDE command.
- [x] Provider-specific read-only / write-mode permissions (no bypass flags).
- [x] Bounded subprocess lifetime, captured output, cancellation, and Windows npm CLI resolution.
- [x] A duplicate-start guard for an agent in the same IDE host.
- [x] Privacy-minimized local metrics: terminal status, duration, success rate and p95.
- [x] Contract tests and a fake-provider execution test (POSIX only).
- [x] Extended focused checks and updated local validation documentation.
- [x] Existing project Harness authority remains unchanged.
- [x] Durable plan → implement → review orchestration with explicit reviewer PASS and fail-closed gate verification.
- [x] Explicit Git worktree isolation as the default execution choice for a native workflow (retained for manual review).
- [x] Bounded read-only Git/sensitive-file scope attestation and explicit stale-workflow reconciliation.
- [x] Resource-aware gate waves for explicitly parallel-safe checks, up to four workers.
- [x] Observed gate/agent metrics shown in the IDE; v2 capability descriptor reports unsupported capabilities conservatively.
- [x] Cross-platform native-test workflow defined; actual workflow run and installer E2E still unverified.
- [x] Exactly one bounded corrective implement/re-review cycle when a reviewer rejects a change, preauthorized by the operator.
- [x] Strict terminal-only reviewer receipts; echoed, conflicting or truncated approvals fail closed.
- [x] Nested ignored secret-file integrity scanning and symlink avoidance; changes are detected without restoring user data.
- [x] Local provider concurrency limited to two active/pending operations and workflow duration bounded to one hour.
- [x] Conservative project capability declarations read from `.harness/manifests/ide-capabilities.json`, never trusted as verified runtime support.
- [x] Provider CLI version diagnostics via bounded `--version` calls without invoking a model or claiming authentication.


## Mandatory remaining work for an AAA release

- [ ] Consolidate the project Python Harness and IDE-native engine behind one versioned executable runtime protocol. A v2 **declaration-only** capability manifest is present, not an authenticated handshake.
- [ ] Extend the durable sequential chain with its single corrective cycle into a concurrent multi-agent DAG and adaptive planning/recovery.
- [ ] Add OS-level sandboxing with explicit filesystem/network permissions on top of the new default Git worktree isolation.
- [ ] Provide transactional integration, conflict resolution and granular retry of interrupted work (stale-state reconciliation is implemented).
- [ ] Add verified provider flag negotiation and quota/token/cost accounting (CLI versions, concurrent-slot backpressure, and time budgets are present).
- [ ] Run cold/warm real-provider benchmarks with CPU, RAM, cost, tokens, latency, success rate and reference workloads.
- [ ] Add fault injection, red-team prompt-injection, symlink/TOCTOU and secret-exfiltration exercises.
- [ ] Implement full streamed agent lifecycle and traces; the dashboard now shows recent workflow status and measured summary metrics.
- [ ] Validate Windows, Linux and macOS behavior under CI with actual installer builds and E2E smoke tests.
- [ ] Complete the project-independent migration of legacy RedEvent policies/docs and expand semantic contract tests.
- [ ] Verify CI is green on this exact branch SHA before review/merge.

## Local checks

From repository root after dependencies are available:

```bash
node scripts/ats-harness-check.mts
npm test --prefix extensions/armotusitio-ide
npm run check --prefix extensions/armotusitio-ide
```

These tests exercise contracts and local fake providers. A true Codex/Claude smoke test is opt-in and requires authenticated local CLI installations. The absence of a CI run or runtime results must be reported as **unverified**. The code has been pushed, but neither a successful CI run nor real authenticated agent execution was observed in this environment.
