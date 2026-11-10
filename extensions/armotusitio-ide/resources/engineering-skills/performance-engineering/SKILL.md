---
name: performance-engineering
description: Investigate measured latency, throughput, memory, CPU, and database bottlenecks.
---

# Performance engineering

Identify a concrete bottleneck or bounded growth risk before changing the implementation. Quantitative improvement claims require comparable measurements.

## Scope and baseline inputs

Use for performance requests, observed resource pressure, or a demonstrated scaling risk in changed code. Do not optimize a cold path on intuition or introduce caches and asynchronous infrastructure without evidence. If no material problem is found, recommend retaining the current design.

Collect the affected operation, workload and cardinality, expected latency or resource budget, environment, relevant revision, runtime configuration, existing metrics, and measurement tools. Separate user-visible latency from total throughput and identify the resource ceiling that matters. Do not assume the project's database, deployment topology, or production traffic profile.

## Investigation and change procedure

1. Reproduce the symptom with representative synthetic or authorized data. Establish warm-up, sample count, concurrency, error rate, and workload distribution. Record a baseline before editing.
1. Profile the relevant path using the existing tools. Distinguish CPU work, allocation and retained memory, blocking, network time, query work, lock contention, and queueing.
1. Form one falsifiable hypothesis. Compare the minimal correction with retaining the current implementation; include correctness, operational, and invalidation costs.
1. Change the proven bottleneck, preserve contracts, and repeat the same measurement conditions. Compare distributions and resource use, not one favorable elapsed time.
1. Run correctness and failure checks affected by the optimization. Report a rejected optimization or inconclusive result without manufacturing a success claim.

## Technical decision heuristics

- Algorithmic complexity: identify input growth and actual bounds. A quadratic loop over a fixed tiny collection may be simpler and sufficient; unbounded input may justify an asymptotic change.
- Memory: distinguish temporary allocations from retained state. Check ownership, disposal, cache bounds, and peak usage rather than only aggregate allocations.
- Database: count queries per operation, detect N+1 paths, inspect representative query plans, cardinality, index selectivity, sorting, and pagination. Indexes incur write and storage costs.
- Cache: define key scope, consistency tolerance, invalidation, TTL, bounds, stampede behavior, and failure fallback. Preserve authorization and tenant scope where they exist.
- Concurrency: measure contention and saturation before increasing workers. Bound queues, propagate cancellation, and preserve ordering and idempotency requirements.
- Asynchronous work: distinguish faster acknowledgement from faster completion. Include queue age, retries, duplicate delivery, and result visibility in the contract.
- Resource limits: account for CPU, memory, I/O, connections, timeouts, and deployment replica count. Increasing a pool can move the bottleneck to a shared dependency.
- Latency and throughput: include tail latency and errors under representative load. A throughput gain with timeouts or worse tail behavior may violate the objective.

## Examples and counterexamples

A list endpoint performs one query per returned item and measurements show query count grows with page size. Compare a bounded batch query or targeted preload using representative plans, response equivalence, and query counts. Avoid fetching every relation by default.

An unmeasured formatter is called once for a short label. Replacing it with memoization adds retained state and invalidation without a demonstrated benefit. Keep it unchanged. A single laptop timing does not support a production throughput percentage claim.

## Output and verification

Return the symptom, baseline conditions, profile evidence, hypothesis, minimal change, comparable results, and correctness checks. Include CPU, memory, latency, throughput, or query metrics only when measured. Mark synthetic results and platform limits explicitly. Do not run destructive load, production experiments, or paid infrastructure without authorization. If measurement cannot run, report the risk and proposed experiment as NOT VERIFIED.
