"""Gate DAG and concurrent executor: ordering, resource serialisation, speedup, cancellation, dependents; no real tools."""
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture
from core import gatedag, verification


def lint(directory, script='lint', **extra):
    return {'command': ['pnpm', '--filter', './' + directory, script], 'tier': 'targeted', 'reason': 'test', 'requires': [], **extra}


def unknown(n):
    return {'command': ['custom-tool', str(n)], 'tier': 'authoritative', 'reason': 'test', 'requires': []}


def result(item, status='PASS'):
    return {'command': item['command'], 'tier': item['tier'], 'reason': item['reason'], 'requires': [], 'status': status, 'exit': 0 if status == 'PASS' else 1,
            'durationMs': 1, 'log': None, 'skipReason': None, 'stdoutTail': '', 'stderrTail': ''}


def not_run(item, reason):
    return {**result(item, 'NOT_RUN'), 'skipReason': reason}


class Probe:
    """Fake gate runner: sleeps, records overlap and the env each gate received."""
    def __init__(self, delay=0.0, fail=(), delays=None):
        self.delay, self.fail, self.delays, self.lock = delay, set(fail), delays or {}, threading.Lock()
        self.active, self.peak, self.order, self.envs = 0, 0, [], {}

    def __call__(self, item, env):
        key = ' '.join(item['command'])
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
            self.order.append(key)
            self.envs[key] = env
        time.sleep(self.delays.get(key, self.delay))
        with self.lock:
            self.active -= 1
        return result(item, 'FAIL' if key in self.fail else 'PASS')


class GraphTests(unittest.TestCase):
    def test_access_and_conflicts(self):
        a, b = gatedag.access(lint('apps/a')), gatedag.access(lint('apps/b'))
        self.assertFalse(gatedag.conflicts(a, b))  # independent workspaces share node_modules read-only
        self.assertTrue(gatedag.conflicts(gatedag.access(lint('apps/a', 'build')), gatedag.access(lint('apps/a', 'test'))))
        self.assertFalse(gatedag.conflicts(gatedag.access(lint('apps/a', 'lint')), gatedag.access(lint('apps/a', 'build'))))
        install = gatedag.access({'command': ['pnpm', 'install']})
        self.assertEqual(install['node_modules'], 'w')
        self.assertTrue(gatedag.conflicts(install, a))
        self.assertTrue(gatedag.conflicts(gatedag.access(unknown(1)), a))  # unknown command = exclusive
        self.assertTrue(gatedag.conflicts(gatedag.access(unknown(1)), gatedag.access(unknown(2))))

    def test_explicit_resources_and_isolation(self):
        db1, db2 = {'command': ['pnpm', '--filter', './apps/a', 'lint'], 'resources': ['db']}, {'command': ['pnpm', '--filter', './apps/b', 'lint'], 'resources': ['db']}
        self.assertTrue(gatedag.conflicts(gatedag.access(db1), gatedag.access(db2)))
        iso = {**db1, 'isolate': {'db': {'DB_NAME': 'e2e_g{slot}'}}}
        self.assertNotIn('db', gatedag.access(iso))
        self.assertEqual(gatedag.isolation_env(iso, 3), {'DB_NAME': 'e2e_g3'})

    def test_edges_point_backwards_and_unknown_dependency_is_rejected(self):
        items = [lint('apps/a', 'build'), lint('apps/a', 'test'), lint('apps/b')]
        ordering, hard = gatedag.build(items)
        self.assertEqual(ordering, {0: set(), 1: {0}, 2: set()})
        self.assertEqual(hard[1], set())
        with self.assertRaises(ValueError):
            gatedag.build([lint('apps/a', id='a', dependsOn=['later']), lint('apps/b', id='later')])

    def test_concurrency_setting(self):
        with fixture(), patch.dict(os.environ, {'HARNESS_GATE_CONCURRENCY': '3'}):
            self.assertEqual(gatedag.concurrency(), 3)
            self.assertEqual(gatedag.concurrency(1), 1)
        with fixture(), patch.dict(os.environ, {'HARNESS_GATE_CONCURRENCY': '0'}):
            with self.assertRaises(ValueError):
                gatedag.concurrency()
        with fixture():
            os.environ.pop('HARNESS_GATE_CONCURRENCY', None)
            self.assertEqual(gatedag.concurrency(), max(1, min(4, os.cpu_count() or 1)))


class ExecutorTests(unittest.TestCase):
    def test_independent_gates_run_concurrently_faster_than_sequential(self):
        items = [lint(f'apps/w{i}') for i in range(4)]
        started = time.monotonic()
        probe = Probe(delay=0.4)
        results = gatedag.run_dag(items, probe, not_run, workers=4)
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(probe.peak, 2)
        self.assertLess(elapsed, 1.4)  # sequential would take >= 1.6s
        self.assertEqual([r['status'] for r in results], ['PASS'] * 4)

    def test_results_follow_plan_order_whatever_the_finish_order(self):
        items = [lint('apps/a'), lint('apps/b'), lint('apps/c')]
        probe = Probe(delays={' '.join(items[0]['command']): 0.4, ' '.join(items[1]['command']): 0.2})
        results = gatedag.run_dag(items, probe, not_run, workers=3)
        self.assertEqual([r['command'] for r in results], [i['command'] for i in items])

    def test_one_worker_is_the_sequential_loop(self):
        items = [lint('apps/a'), lint('apps/b'), lint('apps/c')]
        probe, seen = Probe(delay=0.01), []
        gatedag.run_dag(items, probe, not_run, workers=1, emit=seen.append)
        self.assertEqual(probe.peak, 1)
        self.assertEqual(probe.order, [' '.join(i['command']) for i in items])
        self.assertEqual([r['command'] for r in seen], [i['command'] for i in items])
        self.assertTrue(all(env == {} for env in probe.envs.values()))

    def test_sequential_fail_fast_and_keep_going(self):
        items = [lint('apps/a'), lint('apps/b'), lint('apps/c')]
        probe = Probe(fail={' '.join(items[0]['command'])})
        stopped = gatedag.run_dag(items, probe, not_run, workers=1)
        self.assertEqual([r['status'] for r in stopped], ['FAIL', 'NOT_RUN', 'NOT_RUN'])
        kept = gatedag.run_dag(items, Probe(fail={' '.join(items[0]['command'])}), not_run, workers=1, keep_going=True)
        self.assertEqual([r['status'] for r in kept], ['FAIL', 'PASS', 'PASS'])

    def test_shared_resource_is_serialised_but_isolated_one_is_not(self):
        shared = [lint(f'apps/e{i}', resources=['db']) for i in range(3)]
        probe = Probe(delay=0.1)
        gatedag.run_dag(shared, probe, not_run, workers=3)
        self.assertEqual(probe.peak, 1)
        isolated = [lint(f'apps/e{i}', resources=['db'], isolate={'db': {'DB_NAME': 'e2e_g{slot}'}}) for i in range(3)]
        probe = Probe(delay=0.3)
        gatedag.run_dag(isolated, probe, not_run, workers=3)
        self.assertGreaterEqual(probe.peak, 2)
        self.assertEqual(sorted(e['DB_NAME'] for e in probe.envs.values()), ['e2e_g0', 'e2e_g1', 'e2e_g2'])

    def test_unknown_commands_never_overlap(self):
        probe = Probe(delay=0.05)
        gatedag.run_dag([unknown(1), unknown(2), unknown(3)], probe, not_run, workers=3)
        self.assertEqual(probe.peak, 1)
        self.assertEqual(probe.order, ['custom-tool 1', 'custom-tool 2', 'custom-tool 3'])

    def test_failed_dependency_marks_dependents_not_run_even_with_keep_going(self):
        install = {'command': ['pnpm', 'install'], 'tier': 'authoritative', 'reason': 't', 'requires': []}
        items = [install, lint('apps/a'), lint('apps/b')]
        results = gatedag.run_dag(items, Probe(fail={'pnpm install'}), not_run, workers=3, keep_going=True)
        self.assertEqual([r['status'] for r in results], ['FAIL', 'NOT_RUN', 'NOT_RUN'])
        self.assertIn('dependency did not pass', results[1]['skipReason'])

    def test_explicit_depends_on(self):
        items = [lint('apps/a', id='build'), lint('apps/b', id='b', dependsOn=['build'])]
        results = gatedag.run_dag(items, Probe(fail={' '.join(items[0]['command'])}), not_run, workers=2, keep_going=True)
        self.assertEqual([r['status'] for r in results], ['FAIL', 'NOT_RUN'])

    def test_parallel_fail_fast_stops_unstarted_checks(self):
        items = [lint('apps/a'), unknown(1), lint('apps/c')]
        results = gatedag.run_dag(items, Probe(fail={'pnpm --filter ./apps/a lint'}), not_run, workers=2)
        self.assertEqual(results[0]['status'], 'FAIL')
        self.assertEqual(results[1]['status'], 'NOT_RUN')

    def test_cancel_event_stops_new_checks(self):
        cancel = threading.Event()
        items = [lint(f'apps/w{i}') for i in range(6)]

        def execute(item, env):
            cancel.set()
            time.sleep(0.05)
            return result(item)
        results = gatedag.run_dag(items, execute, not_run, workers=2, cancel=cancel)
        self.assertIn('NOT_RUN', [r['status'] for r in results])
        self.assertTrue(all(r['skipReason'] == 'cancelled' for r in results if r['status'] == 'NOT_RUN'))

    def test_internal_error_is_raised_after_in_flight_gates_finish(self):
        def execute(item, env):
            if item['command'][-2] == './apps/a':
                raise RuntimeError('boom')
            time.sleep(0.05)
            return result(item)
        with self.assertRaises(RuntimeError):
            gatedag.run_dag([lint('apps/a'), lint('apps/b')], execute, not_run, workers=2)


class RunGatesTests(unittest.TestCase):
    def fake_spawn(self, calls):
        def spawn(cmd, args, options):
            calls.append((cmd, args, options))
            return {'code': 0, 'out': '', 'err': '', 'durationMs': 1, 'log': None}
        return spawn

    def test_cancel_env_and_timeout_reach_the_spawn_options(self):
        with fixture():
            calls, cancel = [], threading.Event()
            gates = [lint('apps/a', isolate={'db': {'DB_NAME': 'g{slot}'}}), lint('apps/b')]
            results = verification.run_gates(None, gates, 4321, concurrency=2, cancel=cancel, spawn=self.fake_spawn(calls), gate_cache=None)
            self.assertEqual([r['status'] for r in results], ['PASS', 'PASS'])
            self.assertTrue(all(o['cancel'] is cancel and o['timeoutMs'] == 4321 for _, _, o in calls))
            self.assertEqual(sorted(o.get('env', {}).get('DB_NAME', '-') for _, _, o in calls), ['-', 'g0'])

    def test_sequential_run_passes_options_untouched(self):
        with fixture():
            calls = []
            verification.run_gates(None, [lint('apps/a')], 999, concurrency=1, spawn=self.fake_spawn(calls), gate_cache=None)
            self.assertEqual(calls[0][2], {'trusted': True, 'timeoutMs': 999})

    def test_run_plan_uses_run_gates_and_keeps_report_shape(self):
        with fixture():
            ok = [sys.executable, '-B', '-c', 'pass']
            plan = {'checks': [{'command': ok, 'tier': 'targeted', 'reason': 't', 'requires': []},
                               {'command': ok + ['#2'], 'tier': 'authoritative', 'reason': 't', 'requires': []}], 'risk': 'LOW', 'domains': []}
            summary = verification.run_plan(plan, 20000, concurrency=4)
            self.assertEqual([c['status'] for c in summary['checks']], ['PASS', 'PASS'])
            self.assertEqual(summary['status'], 'PASS')


if __name__ == '__main__':
    unittest.main()
