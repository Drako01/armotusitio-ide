"""Dependency graph and concurrent executor for a plan's checks.

Edges come from the plan order: a check waits for every EARLIER check it conflicts with on a mutable resource (same
workspace output directory, node_modules mutation, database, port, temp dir, shared process, or an unknown command, which is
treated as exclusive). Edges are therefore always backwards, the graph is acyclic and the outcome is deterministic.
Two kinds of edge:
  ordering  - serialisation only; a failure upstream does not stop the dependent unless the run is fail-fast
  requires  - hard dependency (install before anything that reads node_modules, explicit `dependsOn` ids); a failed
              upstream marks the dependent NOT_RUN with the reason
Concurrency 1 is the old strictly sequential loop. A check may declare `resources` (['db', 'port:r']) and `isolate`
({'db': {'DB_SUFFIX': '_g{slot}'}}): an isolated resource is not serialised and its env is injected per gate (parallel only).
"""
import os
import re
import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from . import config

PASS, FAIL, NOT_RUN = 'PASS', 'FAIL', 'NOT_RUN'
WRITE_SCRIPTS = ('build', 'typecheck')
INSTALLERS = ('install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'dedupe', 'fetch', 'rebuild')
EXCLUSIVE = {'*': 'w'}


def concurrency(requested=None):
    """Explicit argument > HARNESS_GATE_CONCURRENCY > policy parallel.gateConcurrency > min(4, cpu)."""
    if requested is None:
        raw = os.environ.get('HARNESS_GATE_CONCURRENCY')
        if raw is not None:
            if not re.fullmatch(r'\d+', raw) or not 1 <= int(raw) <= 64:
                raise ValueError('HARNESS_GATE_CONCURRENCY must be an integer 1..64')
            return int(raw)
        requested = (config.policy().get('parallel') or {}).get('gateConcurrency')
    return max(1, int(requested)) if requested else max(1, min(4, os.cpu_count() or 1))


def access(item):
    """{resource: 'r'|'w'} a check touches. Unknown commands are exclusive ('*'), so parallelism is only ever opt-in by recognition."""
    found = {}
    for tag in item.get('resources', []) or []:
        name, _, mode = str(tag).partition(':')
        found[name] = 'r' if mode == 'r' else 'w'
    c = list(item['command'])
    if c[:1] == ['pnpm']:
        rest = c[1:]
        if len(rest) == 3 and rest[0] == '--filter' and rest[1].startswith('./'):
            found['node_modules'] = 'r'
            mode = 'w' if rest[2] in WRITE_SCRIPTS else 'r' if rest[2] in ('test', 'test:critical') else None
            if mode:
                found['out:' + rest[1][2:]] = mode
        elif rest[:1] and rest[0] in INSTALLERS:
            found['node_modules'] = 'w'
        elif rest[:2] == ['exec', 'prettier'] or rest[:1] == ['format:check']:
            found['node_modules'] = 'r'
        elif rest[:1] == ['agent-config:check']:
            pass
        else:
            return {**found, **EXCLUSIVE}
    elif c[:1] == ['go'] and len(c) > 3 and c[1] == '-C' and c[3] in ('vet', 'test'):
        found['go:' + c[2]] = 'w' if c[3] == 'test' else 'r'
    elif c[:2] == ['gofmt', '-l'] or c[:2] == ['bash', '-n'] or c[:3] == ['docker', 'compose', '-f']:
        pass
    elif not found:
        return dict(EXCLUSIVE)
    for tag in item.get('isolate', {}) or {}:
        found.pop(str(tag).partition(':')[0], None)
    return found


def conflicts(a, b):
    if '*' in a or '*' in b:
        return True
    return any(name in b and 'w' in (mode, b[name]) for name, mode in a.items())


def build(items):
    """({index: set(ordering deps)}, {index: set(hard deps)}); every dependency has a lower index."""
    ids = {item['id']: i for i, item in enumerate(items) if item.get('id')}
    touched = [access(item) for item in items]
    ordering, hard = {}, {}
    for i, item in enumerate(items):
        ordering[i] = {j for j in range(i) if conflicts(touched[j], touched[i])}
        hard[i] = set()
        for ident in item.get('dependsOn', []) or []:
            if ident not in ids or ids[ident] >= i:
                raise ValueError(f'check {i} depends on {ident!r}, which is unknown or not earlier in the plan')
            hard[i].add(ids[ident])
        hard[i] |= {j for j in ordering[i] if touched[j].get('node_modules') == 'w' and 'node_modules' in touched[i]}
        ordering[i] |= hard[i]
    return ordering, hard


def isolation_env(item, slot):
    env = {}
    for values in (item.get('isolate') or {}).values():
        env.update({k: str(v).format(slot=slot) for k, v in (values or {}).items()})
    return env


def run_dag(items, execute, not_run, workers=None, keep_going=False, cancel=None, emit=None):
    """Runs `items` and returns one result per item in plan order. `execute(item, env)` returns a result dict;
    `not_run(item, reason)` builds a NOT_RUN result. Quarantined failures are not failures. See the module docstring."""
    workers = concurrency(workers)
    failed = lambda r: r['status'] == FAIL and not r.get('quarantined')
    results = [None] * len(items)
    if workers == 1 or len(items) < 2:
        stopped = None
        for i, item in enumerate(items):
            if stopped or (cancel is not None and cancel.is_set()):
                results[i] = not_run(item, stopped or 'cancelled')
                continue
            results[i] = execute(item, {})
            if emit:
                emit(results[i])
            if failed(results[i]) and not keep_going:
                stopped = 'stopped after first failure (use --keep-going)'
        return results
    ordering, hard = build(items)
    pending, running, stop_reason, error = set(range(len(items))), {}, None, None
    lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix='gate') as pool:
        while pending or running:
            if cancel is not None and cancel.is_set():
                stop_reason = stop_reason or 'cancelled'
            for i in sorted(pending):
                if len(running) >= workers and not stop_reason:
                    break
                blocked = [j for j in hard[i] if results[j] is not None and results[j]['status'] in (FAIL, NOT_RUN) and not results[j].get('quarantined')]
                if blocked:
                    results[i] = not_run(items[i], 'dependency did not pass: ' + ' '.join(items[blocked[0]]['command'])[:120])
                elif stop_reason:
                    results[i] = not_run(items[i], stop_reason)
                elif all(results[j] is not None for j in ordering[i]) and len(running) < workers:
                    running[pool.submit(execute, items[i], isolation_env(items[i], i) if workers > 1 else {})] = i
                else:
                    continue
                pending.discard(i)
            if not running:
                continue  # everything left was resolved this pass, or the lowest pending check is submitted next pass
            done, _ = wait(list(running), timeout=0.2, return_when=FIRST_COMPLETED)
            for future in done:
                i = running.pop(future)
                try:
                    results[i] = future.result()
                except BaseException as caught:  # surface after in-flight gates finish; never lose the first error
                    error = error or caught
                    stop_reason = stop_reason or 'aborted by an internal error'
                    results[i] = not_run(items[i], 'aborted by an internal error')
                    continue
                if emit:
                    with lock:
                        emit(results[i])
                if failed(results[i]) and not keep_going:
                    stop_reason = stop_reason or 'stopped after first failure (use --keep-going)'
    if error:
        raise error
    return results
