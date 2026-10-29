"""Single provider-independent DAG lifecycle with bounded correction and recovery."""
import os
import time
import threading
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from .config import H, NON_IMPLEMENTERS, DOWNSTREAM, max_retries, effective_limits, isolation, local_hook
from .state import Lock, assert_task_id, persist_task, move_task, handoff, log
from .tasks import load_task
from .context import get_domain
from .delegation import execute_node, run_gate
from .snapshot import verify_interrupted
from . import progress
from . import planner, worktree, checkpoint, retention
from .budget import BUDGET
from .verification import task_verify_plan, selected


def task_width(task):
    """Parallel width the plan justifies (1 for legacy chains); multi-domain parents use their widest child wave."""
    if task['domain'] == 'multi':
        return max([task_width(load_task(c)) for c in task['children']] + [len(task['children']) if len(task['children']) > 1 else 1])
    plan = task.get('plan') or {}
    return plan.get('width', 1) if plan.get('parallel') else 1


def execute(identity):
    assert_task_id(identity)
    max_retries()
    try:
        width = task_width(load_task(identity))
    except Exception:
        width = None  # an unreadable task is reported by execute_locked; sizing falls back to the configured defaults
    # Also validates HARNESS_MAX_WORKERS / HARNESS_ROLE_LIMITS / HARNESS_HOST_LIMIT before any lock is taken.
    BUDGET.configure(width=width)
    with Lock(H / 'state/workspace.lock'), Lock(H / 'state' / (identity + '.lock')):
        cleaned = clean_orphans(identity)
        task = execute_locked(identity)
        record_workers(task, cleaned)
        return task


def clean_orphans(identity):
    """Orphan worktrees of dead tasks break verifier gates and waste disk: remove them before running, never failing."""
    try:
        from . import preflight
        return preflight.cleanup_orphan_worktrees([identity])
    except Exception:
        return []


def record_workers(task, cleaned):
    """Evidence of how the pool was sized (requested/effective/source) and what the automatic cleanup removed."""
    try:
        snapshot = BUDGET.snapshot()
        task['metrics'] = {**(task.get('metrics') or {}),
                           'workerSizing': {'effective': snapshot['configured'], 'source': snapshot['source'], 'cleanedWorktrees': len(cleaned)}}
        persist_task(task)
    except Exception:
        pass


def execute_locked(identity):
    task = load_task(identity)
    if task['status'] in ['completed', 'failed']:
        return task
    if task.get('scopeViolation'):
        move_task(task, 'failed')
        return task
    return run_multi(task) if task['domain'] == 'multi' else run_dag(task)


def run_multi(task):
    if task.get('bootstrap'):
        child = execute_locked(task['bootstrap'])
        if child['status'] != 'completed':
            if child['status'] == 'failed':
                move_task(task, 'failed')
            return task
    order = ['repo', 'api', 'infra', 'backoffice', 'docs']
    children = sorted([load_task(c) for c in task['children']], key=lambda t: order.index(t['domain']) if t['domain'] in order else len(order))
    for wave in child_waves(children):
        if len(wave) == 1 or not parallel_enabled(len(wave)):
            for child in wave:
                result = execute_locked(child['id'])
                if result['status'] != 'completed':
                    if result['status'] == 'failed':
                        move_task(task, 'failed')
                    return task
            continue
        results = run_wave(wave)
        if any(r['status'] != 'completed' for r in results):
            if any(r['status'] == 'failed' for r in results):
                move_task(task, 'failed')
            return task
    # The combined state gets each distinct gate once, never untested concurrent mutations.
    seen, gates = set(), []
    for child in children:
        for gate in selected(task_verify_plan(child)):
            key = tuple(gate['command'])
            if key not in seen:
                seen.add(key)
                gates.append(gate)
    try:
        for index, gate in enumerate(gates):
            progress.record_gates(task['id'], 'final-gates', index, len(gates), gate['command'])
            run = run_gate(task, gate)
            if run.get('skipped'):
                # Fail closed: an unverified combined state is never completed; the task stays active, blocked.
                log('errors', task['id'], 'blocked', {'reason': 'SKIPPED_ENVIRONMENT: ' + str(run.get('reason')), 'gate': gate['command']})
                return task
            if run['code']:
                move_task(task, 'failed')
                return task
    finally:
        progress.clear_gates(task['id'])
    move_task(task, 'completed')
    return task


# A child only waits for the children whose output it consumes; everything else in a wave may run concurrently.
CHILD_DEPENDENCIES = {'backoffice': ['api', 'n8n'], 'provider-portal': ['api', 'n8n'], 'sales-portal': ['api', 'n8n'],
                      'planner-portal': ['api', 'n8n'], 'marketplace': ['api', 'n8n'], 'docs': None}


def parallel_enabled(width=None):
    """Parallel execution needs more than one worker, working Git isolation and no explicit opt-out."""
    return effective_limits(width)[0] > 1 and os.environ.get('HARNESS_PARALLEL', '1') != '0' and worktree.available()


def child_waves(children):
    """Deterministic waves of mutually independent children. Domains with overlapping paths never share a wave."""
    domains = {c['domain']: c for c in children}
    def depends(child):
        configured = CHILD_DEPENDENCIES.get(child['domain'], [])
        if configured is None:
            return [d for d in domains if d != child['domain']]  # documentation describes what everyone else produced
        return [d for d in configured if d in domains] + (['repo'] if 'repo' in domains and child['domain'] != 'repo' else [])
    remaining, done, waves = list(children), set(), []
    while remaining:
        ready = [c for c in remaining if all(d in done for d in depends(c))] or [remaining[0]]
        wave = []
        for child in ready:
            paths = [p for p in get_domain(child['domain'])['paths']]
            if all(not planner.conflicting(paths, [p for p in get_domain(o['domain'])['paths']]) for o in wave):
                wave.append(child)
        waves.append(wave)
        done.update(c['domain'] for c in wave)
        remaining = [c for c in remaining if c not in wave]
    return waves


def run_wave(children):
    """Independent child tasks concurrently: every delegated node runs in its own worktree, results integrate under one lock."""
    def work(child):
        local_hook('wave', True)
        with isolation(True):
            return execute_locked(child['id'])
    with ThreadPoolExecutor(max_workers=len(children), thread_name_prefix='harness-child') as pool:
        futures = [pool.submit(work, child) for child in children]
        return [future.result() for future in futures]


def sequential_metrics(task, started):
    """Wall-clock evidence for the historical executor so that sequential and parallel runs are comparable."""
    duration = round((time.monotonic() - started) * 1000)
    previous = task.get('metrics') or {}
    walls = {}
    for node in task['dag']:
        try:
            walls[node['id']] = max(0, round((datetime.fromisoformat(node['finishedAt'].replace('Z', '+00:00')) - datetime.fromisoformat(node['startedAt'].replace('Z', '+00:00'))).total_seconds() * 1000))
        except (KeyError, ValueError, AttributeError):
            walls[node['id']] = 0
    total = previous.get('durationMs', 0) + duration
    task['metrics'] = {'mode': 'sequential', 'workers': 1, 'peakConcurrency': 1, 'durationMs': total,
                       'sequentialMs': total, 'criticalPathMs': total, 'speedup': 1.0, 'retries': sum(max(0, n['attempts'] - 1) for n in task['dag']),
                       'conflicts': 0, 'nodes': {n['id']: {'agent': n['agent'], 'status': n['status'], 'attempts': n['attempts'], 'wallMs': walls[n['id']],
                                                           'tokens': n.get('tokens')} for n in task['dag']}}


def run_dag(task):
    started = time.monotonic()
    retries = max_retries()
    verify_interrupted(task)
    if task.get('scopeViolation'):
        move_task(task, 'failed')
        return task
    if parallel_enabled(task_width(task)) and planner.parallel_capable(task['dag']):
        from . import scheduler
        scheduler.run(task)
        return settle(task)
    for node in task['dag']:
        if node['status'] in ['running', 'blocked']:
            node['status'] = 'pending'
    checkpoint.safely(checkpoint.apply, task)
    while True:
        nodes = {n['id']: n for n in task['dag']}
        ready = [n for n in task['dag'] if n['status'] == 'pending' and all(nodes[d]['status'] == 'passed' for d in n['dependsOn'])]
        if not ready:
            break
        for node in ready:
            checkpoint.safely(checkpoint.begin, task, node)
            try:
                passed = execute_node(task, node)
            except Exception as error:
                node['status'] = 'failed'
                handoff(task, node, 'failed', {'risks': [str(error)]})
                passed = False
            checkpoint.safely(checkpoint.finish, task, node)
            persist_task(task)
            progress.announce(task)
            if task.get('scopeViolation') or task.get('scopeValidationPending'):
                break
            if not passed and node['status'] == 'failed' and node.get('failureCategory') in ('host-quota', 'host-authentication', 'host-unavailable'):
                node['status'] = 'blocked'
                log('audit', task['id'], 'retry-blocked-host',
                    {'node': node['id'], 'category': node['failureCategory']})
                persist_task(task)
                break
            if not passed and node['status'] == 'failed' and node['attempts'] <= retries:
                if node['agent'] == 'verifier':
                    from .gatetriage import triage_failed_gate
                    if triage_failed_gate(task, node) == 'preexisting':
                        node['status'] = 'blocked'
                        handoff(task, node, 'blocked',
                                {'risks': ['El gate también falla sobre HEAD limpio: fallo preexistente; resolver por su dueño sin reabrir implementadores']})
                        persist_task(task)
                        break
                if node['agent'] in ['reviewer', 'security-auditor', 'verifier']:
                    task['feedback'] = list(dict.fromkeys(task.get('feedback', []) + [node['id']]))
                    for other in task['dag']:
                        if other['agent'] not in NON_IMPLEMENTERS or other['agent'] in DOWNSTREAM:
                            other['status'] = 'pending'
                    log('audit', task['id'], 'corrective-loop', {'failedGate': node['agent'], 'attempt': node['attempts']})
                else:
                    node['status'] = 'pending'
                log('errors', task['id'], 'retry', {'agent': node['agent'], 'attempt': node['attempts']})
        if task.get('scopeViolation') or task.get('scopeValidationPending') or any(n['status'] == 'blocked' for n in ready):
            break
    sequential_metrics(task, started)
    return settle(task)


def settle(task):
    """Shared by the sequential and parallel executors: dependency-failure propagation and the terminal transition."""
    changed = True
    while changed:
        changed = False
        nodes = {n['id']: n for n in task['dag']}
        for node in task['dag']:
            if node['status'] == 'pending' and any(nodes[d]['status'] in ['failed', 'blocked'] for d in node['dependsOn']):
                node['status'] = 'blocked'
                if node['attempts']:
                    handoff(task, node, 'blocked', {'risks': ['Dependency failed'], 'nextAction': 'Resolve failed dependency'})
                changed = True
    persist_task(task)
    progress.announce(task)
    if task.get('scopeViolation'):
        move_task(task, 'failed')
        log('errors', task['id'], 'failed', {'reason': 'scope violation'})
    elif all(n['status'] == 'passed' for n in task['dag']):
        move_task(task, 'completed')
        log('completed', task['id'], 'completed', {'agents': task['agents']})
        if task.get('metrics') or any(r.get('task') == task['id'] for r in worktree.list_registry(task['id'])):
            cleanup_worktrees(task)
        record_task(task)
        retention.on_task_finished(task)  # temp artifacts out, minimal manifest kept; never raises
    elif any(n['status'] == 'failed' for n in task['dag']):
        move_task(task, 'failed')
        log('errors', task['id'], 'failed')
    return task


def record_task(task):
    try:
        from . import telemetry
        metrics = task.get('metrics') or {}
        telemetry.record('task', key=task['domain'], durationMs=metrics.get('durationMs'), workers=metrics.get('workers'),
                         retries=metrics.get('retries', 0), speedup=metrics.get('speedup'))
        if metrics.get('sequentialMs') and metrics.get('durationMs'):
            telemetry.record('saved', key=task['domain'], ms=max(0, metrics['sequentialMs'] - metrics['durationMs']))
    except Exception:
        pass


def cleanup_worktrees(task):
    """A completed task no longer needs its isolated checkouts; patches, journals and handoffs remain as evidence."""
    for entry in worktree.list_registry(task['id']):
        handle = worktree.Worktree(entry['task'], entry['node'], entry['attempt'], entry['runId'])
        handle.discard()
