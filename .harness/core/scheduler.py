"""Dependency-driven parallel scheduler over the persisted task DAG.

The main thread is the only writer of scheduling decisions. Delegated nodes run in worker threads against a private
copy of the task (their own isolated worktree, see worktree.py); whatever they persist is merged into the
authoritative task under one lock, and only while the node's `claim` still matches. A node that was cancelled,
re-queued or superseded changes its claim, so a late result can never overwrite newer state.
"""
import copy
import re
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait, wait as drain, FIRST_COMPLETED
from .config import ROOT, H, NON_IMPLEMENTERS, DOWNSTREAM, DETERMINISTIC, now, workspace, isolation, local_hook, max_retries, setting, policy
from .state import write_task, handoff, log, persist_task
from .snapshot import snapshot, record_scope_violation, regenerated, build_info_patterns, EPHEMERAL
from .security import matches_path
from .budget import BUDGET, host_name
from .planner import conflicting, reachable
from .delegation import execute_node, Cancelled
from . import checkpoint
from . import worktree as wt
from . import progress

OPERATIONAL = re.compile(r'^\.harness/(tasks|state|handoffs|logs|runtime|specs)/')


def task_timeout_ms():
    return setting('HARNESS_TASK_TIMEOUT_MS', 0, 0)


class Run:
    """One launched node: its future, cancel event and the claim that authorizes it to write state."""
    def __init__(self, node, claim, cancel, future=None):
        self.node, self.claim, self.cancel, self.future = node, claim, cancel, future
        self.started = time.monotonic()
        self.role, self.host = node['agent'], host_name()
        self.lone = False
        self.delegated = node['agent'] not in DETERMINISTIC


class Scheduler:
    def __init__(self, task):
        self.task, self.retries = task, max_retries()
        self.lock = threading.RLock()
        self.active = {}            # node id -> Run
        self.ready_since = {}       # node id -> monotonic time it became ready (queue time)
        self.metrics = {'queueMs': 0, 'wallMs': {}, 'conflicts': 0, 'retries': 0, 'integrationMs': 0, 'throttled': 0}
        self.integrated = set()     # files legitimately written to main during the current guard window
        self.window = None          # (snapshot before, ) while delegated nodes run
        self.stop = False           # no further launches (scope violation / cancellation)
        self.started = time.monotonic()
        self.weights = {n['id']: float(n.get('weight', 1.0)) for n in task['dag']}
        self.order = {n['id']: i for i, n in enumerate(task['dag'])}
        self.memo = {}
        # A node that is the only ready node while nothing else runs cannot overlap anything (readiness only changes on
        # completions), so it needs no worktree. Siblings of a parallel wave may integrate into main at any moment: no shortcut there.
        self.allow_lone = not local_hook('wave')

    # -- state merge (called from worker threads through persist_task) ---------------------------------------------
    def sink(self, local_task, node_id):
        """Merges only the worker's own node, and only while its claim is current; anything else is a stale write."""
        with self.lock, workspace(ROOT):
            run = self.active.get(node_id)
            local = next(n for n in local_task['dag'] if n['id'] == node_id)
            real = self.node(node_id)
            if run is None or not local.get('claim') or local.get('claim') != run.claim or real.get('claim') != run.claim:
                return  # superseded or cancelled execution: its writes are discarded
            real.update(copy.deepcopy(local))
            for key in ('scopeViolation', 'scopeValidationPending'):
                if local_task.get(key) and not self.task.get(key):
                    self.task[key] = copy.deepcopy(local_task[key])
            write_task(self.task)

    def node(self, node_id):
        return next(n for n in self.task['dag'] if n['id'] == node_id)

    # -- readiness and admission ------------------------------------------------------------------------------------
    def ready(self):
        nodes = {n['id']: n for n in self.task['dag']}
        out = [n for n in self.task['dag'] if n['status'] == 'pending' and n['id'] not in self.active
               and all(nodes[d]['status'] == 'passed' for d in n['dependsOn'])]
        for n in out:
            self.ready_since.setdefault(n['id'], time.monotonic())
        return sorted(out, key=lambda n: (-self.rank(n['id']), self.order[n['id']]))

    def rank(self, node_id):
        """Upward rank: weight of the longest chain still depending on this node (list scheduling on the critical path)."""
        if node_id not in self.memo:
            self.memo[node_id] = self.weights[node_id] + max([self.rank(n['id']) for n in self.task['dag'] if node_id in n['dependsOn']] or [0])
        return self.memo[node_id]

    def admissible(self, node):
        delegated = node['agent'] not in DETERMINISTIC
        if not delegated:
            # Context/logger/verifier read or write the integrated main checkout: they never overlap delegated nodes.
            return not self.active
        if any(not r.delegated for r in self.active.values()):
            return False
        owns = node.get('owns') or []
        for run in self.active.values():
            other = run.node
            if owns and other.get('owns') and conflicting(owns, other['owns']):
                return False  # exclusive ownership: never two writers on overlapping paths
            if node.get('kind') == 'external' and other.get('kind') == 'external':
                return False  # one external-effect operation at a time
        return True

    def launch(self, node, lone=False):
        delegated = node['agent'] not in DETERMINISTIC
        run = Run(node, secrets_token(), threading.Event())
        run.lone = lone
        if delegated and not BUDGET.try_acquire(run.role, run.host):
            return False
        if delegated and not self.window and not lone:
            wt.INTEGRATED.clear()
            self.window = snapshot()  # guard window: anything written to main outside integration is a violation
            self.integrated = set()
        node['claim'] = run.claim
        node['status'] = 'running'
        checkpoint.safely(checkpoint.begin, self.task, node)
        node['queueMs'] = round((time.monotonic() - self.ready_since.get(node['id'], time.monotonic())) * 1000)
        self.metrics['queueMs'] += node['queueMs']
        local_task = copy.deepcopy(self.task)
        local = next(n for n in local_task['dag'] if n['id'] == node['id'])
        self.active[node['id']] = run
        write_task(self.task)
        run.future = self.pool.submit(self.work, local_task, local, run)
        return True

    def work(self, local_task, local, run):
        started = time.monotonic()
        error = None
        local_hook('persist', lambda t: self.sink(t, run.node['id']))
        local_hook('announce', lambda _task: progress.announce(self.task))
        local_hook('slot', run.delegated)
        local_hook('lone', run.lone)
        try:
            with isolation(True):
                try:
                    execute_node(local_task, local, run.cancel)
                except Cancelled:
                    pass
                except Exception as exc:  # the node failed outside the structured-result path
                    error = exc
        finally:
            if run.delegated:
                BUDGET.release(run.role, run.host)
            for name in ('persist', 'announce', 'slot', 'lone'):
                local_hook(name, clear=True)
        local['wallMs'] = round((time.monotonic() - started) * 1000)
        return local_task, local, error

    # -- completion ---------------------------------------------------------------------------------------------------
    def reap(self, finished):
        for future in finished:
            node_id = next(i for i, r in self.active.items() if r.future is future)
            run = self.active[node_id]
            local_task, local, error = future.result()
            with self.lock:
                real = self.node(node_id)
                stale = real.get('claim') != run.claim
                if stale:
                    log('audit', self.task['id'], 'late-result-discarded', {'node': node_id, 'claim': run.claim})
                    if real['status'] == 'running':
                        real['status'] = 'pending'
                        real['interrupted'] = {'at': now(), 'reason': 'execution cancelled; result discarded'}
                else:
                    cancelled = local['status'] == 'pending' and local.get('cancelled')
                    keep = {k: v for k, v in local.items() if k not in ('claim',)}
                    real.update(copy.deepcopy(keep))
                    for key in ('scopeViolation', 'scopeValidationPending'):
                        if local_task.get(key) and not self.task.get(key):
                            self.task[key] = copy.deepcopy(local_task[key])
                    if error is not None:
                        real['status'] = 'failed'
                        handoff(self.task, real, 'failed', {'risks': [str(error)]})
                    real.pop('claim', None)
                    self.metrics['wallMs'][node_id] = self.metrics['wallMs'].get(node_id, 0) + local.get('wallMs', 0)
                    if real.get('integration'):
                        self.metrics['integrationMs'] += real['integration'].get('durationMs', 0)
                        self.integrated.update(real['integration'].get('applied', []))
                    if real.get('conflicts'):
                        self.metrics['conflicts'] = sum(n.get('conflicts', 0) for n in self.task['dag'])
                    if not cancelled:
                        checkpoint.safely(checkpoint.finish, self.task, real)
                    del self.active[node_id]  # before the retry policy: a finished node may reopen itself and its dependents
                    if not cancelled:
                        self.after(real)
                self.active.pop(node_id, None)
                write_task(self.task)
                progress.announce(self.task)
        if self.window and not any(r.delegated for r in self.active.values()):
            self.close_window()

    def after(self, node):
        """Retry / corrective-loop policy, identical in meaning to the sequential lifecycle but selective."""
        if node['status'] != 'failed' or node['attempts'] > self.retries:
            return
        # A provider quota, missing host binary, or login failure cannot be repaired by replaying workers.
        # In particular, never reopen implementers on these infrastructure failures.
        if node.get('failureCategory') in ('host-quota', 'host-authentication', 'host-unavailable'):
            # Retain host backpressure telemetry without replaying an unrecoverable
            # operation. A missing host or depleted quota is not an implementation bug.
            if node['failureCategory'] == 'host-unavailable' and BUDGET.throttle():
                self.metrics['throttled'] += 1
                log('audit', self.task['id'], 'backpressure',
                    {'node': node['id'], 'category': node['failureCategory'], 'workers': BUDGET.snapshot()['workers']})
            node['status'] = 'blocked'
            log('audit', self.task['id'], 'retry-blocked-host',
                {'node': node['id'], 'category': node['failureCategory']})
            return
        if node.get('failureCategory') in ('host-unavailable', 'timeout') and BUDGET.throttle():
            self.metrics['throttled'] += 1
            log('audit', self.task['id'], 'backpressure', {'node': node['id'], 'category': node['failureCategory'], 'workers': BUDGET.snapshot()['workers']})
        self.metrics['retries'] += 1
        if node['agent'] == 'verifier':
            from .gatetriage import triage_failed_gate
            if triage_failed_gate(self.task, node) == 'preexisting':
                node['status'] = 'blocked'
                log('audit', self.task['id'], 'corrective-blocked-preexisting',
                    {'failedGate': node['id'], 'attempt': node['attempts']})
                return
        if node['agent'] in ['reviewer', 'security-auditor', 'verifier']:
            self.task['feedback'] = list(dict.fromkeys(self.task.get('feedback', []) + [node['id']]))
            self.reopen(self.owners_of_findings(node))
            log('audit', self.task['id'], 'corrective-loop', {'failedGate': node['agent'], 'attempt': node['attempts']})
        else:
            node['status'] = 'pending'
        log('errors', self.task['id'], 'retry', {'agent': node['agent'], 'node': node['id'], 'attempt': node['attempts']})

    def owners_of_findings(self, gate):
        """Writers whose ownership covers a path named in the gate's findings; all writers when nothing can be attributed."""
        writers = [n for n in self.task['dag'] if n['agent'] not in NON_IMPLEMENTERS or n['agent'] in DOWNSTREAM]
        implementers = [n for n in writers if n['agent'] not in DOWNSTREAM]
        file = H / 'handoffs' / f'{self.task["id"]}-{gate["id"]}-{gate["attempts"]}.json'
        try:
            from .config import read_json
            text = ' '.join(read_json(file).get('risks', []))
        except (OSError, ValueError):
            text = ''
        paths = set(re.findall(r'[A-Za-z0-9_.@-]+(?:/[A-Za-z0-9_.@-]+)+', text))
        named = [n for n in implementers if n.get('owns') and any(matches_path(p, o) for p in paths for o in n['owns'])]
        return [n['id'] for n in (named or implementers)]

    def reopen(self, implementer_ids):
        deps = {n['id']: n['dependsOn'] for n in self.task['dag']}
        reset = set(implementer_ids)
        for n in self.task['dag']:
            if n['agent'] in DOWNSTREAM or (reachable(deps, n['id']) & set(implementer_ids)):
                reset.add(n['id'])
        for n in self.task['dag']:
            if n['id'] in reset and n['id'] not in self.active:
                n['status'] = 'pending'

    def close_window(self):
        before, self.window = self.window, None
        after = snapshot()
        patterns, ignored = build_info_patterns(), before.ignored | after.ignored
        foreign = sorted(f for f in before.keys() | after.keys() if before.get(f) != after.get(f) and f not in self.integrated and f not in wt.INTEGRATED
                         and not OPERATIONAL.search(f) and not EPHEMERAL.search(f) and not regenerated(f, ignored, patterns))
        if foreign and not self.task.get('scopeViolation'):  # never replace the first, more specific violation
            reason = 'Parallel phase wrote to the main checkout outside integration: ' + ', '.join(foreign)
            record_scope_violation(self.task, {'id': 'scheduler', 'agent': 'parallel-scheduler', 'attempts': 0, 'status': 'running'}, before, foreign, reason)
        if foreign:
            self.stop = True

    # -- cancellation -------------------------------------------------------------------------------------------------
    def cancel_all(self, reason):
        with self.lock:
            for run in self.active.values():
                run.cancel.set()
                run.node['claim'] = None  # anything they still write is stale
            log('audit', self.task['id'], 'cancel-all', {'reason': reason, 'nodes': sorted(self.active)})

    # -- main loop ----------------------------------------------------------------------------------------------------
    def run(self):
        deadline = time.monotonic() + task_timeout_ms() / 1000 if task_timeout_ms() else None
        previous = None
        if threading.current_thread() is threading.main_thread() and hasattr(signal, 'SIGTERM'):
            previous = signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
        with ThreadPoolExecutor(max_workers=max(BUDGET.snapshot()['configured'], 1) + 1, thread_name_prefix='harness-node') as pool:
            self.pool = pool
            try:
                while True:
                    with self.lock:
                        if self.task.get('scopeViolation') or self.task.get('scopeValidationPending'):
                            self.stop = True
                        if deadline and time.monotonic() > deadline and not self.stop:
                            self.stop = True
                            log('errors', self.task['id'], 'task-timeout', {'ms': task_timeout_ms()})
                        if self.stop and self.active:
                            self.cancel_all('scope violation or task timeout')
                        waiting = [] if self.stop else self.ready()
                        for node in waiting:
                            if self.admissible(node):
                                self.launch(node, lone=self.allow_lone and len(waiting) == 1 and not self.active and not self.window)
                        futures = {r.future for r in self.active.values()}
                    if not futures:
                        if self.stop or not waiting:
                            break
                        time.sleep(0.05)  # capacity is held by sibling tasks (multi); retry admission
                        continue
                    done, _ = wait(futures, timeout=0.05, return_when=FIRST_COMPLETED)
                    if done:
                        self.reap(done)
            except BaseException:
                # Ctrl+C / SIGTERM / internal error: cancel the whole process tree of every worker, keep evidence, stay resumable.
                self.cancel_all('interrupted')
                drain({r.future for r in self.active.values()}, timeout=policy()['parallel']['cancelGraceMs'] / 1000 + 5)  # cleanup must not be interruptible by the loop's own wait
                with self.lock:
                    for node_id, run in list(self.active.items()):
                        real = self.node(node_id)
                        real['status'] = 'pending'
                        real['interrupted'] = {'at': now(), 'reason': 'scheduler interrupted'}
                        real.pop('claim', None)
                    self.active.clear()
                    write_task(self.task)
                raise
            finally:
                if previous is not None:
                    signal.signal(signal.SIGTERM, previous)
        if self.window:
            self.close_window()
        return self.finish()

    def finish(self):
        duration = round((time.monotonic() - self.started) * 1000)
        walls = {}
        for n in self.task['dag']:
            walls[n['id']] = self.metrics['wallMs'].get(n['id'], 0)
        sequential = sum(walls.values())
        chain = {}
        def longest(node_id):
            if node_id not in chain:
                node = self.node(node_id)
                chain[node_id] = walls[node_id] + max([longest(d) for d in node['dependsOn']] or [0])
            return chain[node_id]
        critical = max([longest(n['id']) for n in self.task['dag']] or [0])
        previous = self.task.get('metrics') or {}
        self.task['metrics'] = {
            'mode': 'parallel', 'workers': BUDGET.snapshot()['configured'], 'peakConcurrency': BUDGET.snapshot()['peak'],
            'durationMs': previous.get('durationMs', 0) + duration, 'sequentialMs': previous.get('sequentialMs', 0) + sequential,
            'criticalPathMs': critical, 'speedup': round((previous.get('sequentialMs', 0) + sequential) / max(previous.get('durationMs', 0) + duration, 1), 2),
            'queueMs': previous.get('queueMs', 0) + self.metrics['queueMs'], 'integrationMs': previous.get('integrationMs', 0) + self.metrics['integrationMs'],
            'retries': previous.get('retries', 0) + self.metrics['retries'], 'conflicts': max(previous.get('conflicts', 0), self.metrics['conflicts']),
            'throttled': previous.get('throttled', 0) + self.metrics['throttled'],
            'planMs': (self.task.get('plan') or {}).get('planMs'),
            'nodes': {n['id']: {'agent': n['agent'], 'status': n['status'], 'attempts': n['attempts'], 'queueMs': n.get('queueMs'),
                                'activeMs': n.get('activeMs'), 'wallMs': walls[n['id']], 'integrationMs': (n.get('integration') or {}).get('durationMs'),
                                'tokens': n.get('tokens'), 'conflicts': n.get('conflicts', 0)} for n in self.task['dag']}}
        tokens = [n.get('tokens') for n in self.task['dag'] if n.get('tokens')]
        self.task['metrics']['tokens'] = ({k: sum(t.get(k, 0) for t in tokens) for k in {k for t in tokens for k in t}} if tokens else 'not reported by host')
        write_task(self.task)
        log('execution', self.task['id'], 'metrics', {k: v for k, v in self.task['metrics'].items() if k != 'nodes'})
        return self.task


def secrets_token():
    return __import__('secrets').token_hex(8)


def run(task):
    """Entry point from the lifecycle for DAGs whose delegated nodes are not a single chain."""
    # Crash/interruption recovery: finish any half-applied integration, reap orphans, keep every worktree as evidence.
    problems = wt.resume_journals(task['id'])
    abandoned = wt.recover(task['id'])
    if problems and any(p['problems'] for p in problems):
        raise ValueError('Interrupted integration is inconsistent with the main checkout; inspect runtime/integration before retrying')
    for node in task['dag']:
        if node['status'] in ('running', 'blocked'):
            if node['status'] == 'running':
                node['interrupted'] = {'at': now(), 'abandonedWorktrees': [a['name'] for a in abandoned if a['node'] == node['id']]}
            node['status'] = 'pending'
            node.pop('claim', None)
    if abandoned:
        log('audit', task['id'], 'recovered-abandoned-runs', {'runs': abandoned})
    checkpoint.safely(checkpoint.apply, task)  # valid unit checkpoints are restored instead of rerunning their agents
    persist_task(task)
    return Scheduler(task).run()
