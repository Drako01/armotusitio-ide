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

## Mandatory remaining work for an AAA release

- [ ] Consolidate the project Python Harness and IDE-native engine behind one versioned runtime protocol.
- [ ] Implement a persistent multi-agent DAG for the generic native engine, including handoffs, retries and feedback loops.
- [ ] Isolate every writing agent in a disposable worktree/container or equivalent sandbox with filesystem/network policy.
- [ ] Provide transactional integration, conflict resolution and recovery of interrupted agent work.
- [ ] Implement complete provider capability negotiation, CLI-version compatibility, quota/backpressure and token/cost budgets.
- [ ] Run cold/warm real-provider benchmarks with CPU, RAM, cost, tokens, latency, success rate and reference workloads.
- [ ] Add fault injection, red-team prompt-injection, symlink/TOCTOU and secret-exfiltration exercises.
- [ ] Wire agent lifecycle/progress, structured evidence and metrics into the main dashboard (currently command-only).
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

These tests exercise contracts and local fake providers. A true Codex/Claude smoke test is opt-in and requires authenticated local CLI installations. The absence of a CI run or runtime results must be reported as **unverified**.
