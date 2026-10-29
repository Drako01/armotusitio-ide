"""harness:progress: percentages, multi, gate counters, failure/blocked exits, JSON, non-TTY output and read-only guarantee."""
import contextlib
import hashlib
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture, SOURCE
from core import config, progress, snapshot

AGENTS = ['context-manager', 'architect', 'tester', 'reviewer', 'security-auditor', 'verifier', 'logger']
CREATED = '2026-10-07T10:00:00.000Z'


def make_task(root, identity, status='active', passed=0, domain='repo', running=None, failed=None, blocked=None, **extra):
    dag = []
    for index, agent in enumerate(AGENTS):
        state = 'passed' if index < passed else 'pending'
        if agent == running:
            state = 'running'
        if agent == failed:
            state = 'failed'
        if agent == blocked:
            state = 'blocked'
        dag.append({'id': agent, 'agent': agent, 'dependsOn': [AGENTS[index - 1]] if index else [], 'status': state,
                    'attempts': 1 if state != 'pending' else 0})
    task = {'schemaVersion': 1, 'id': identity, 'status': status, 'task': 'Titulo de prueba\nsegunda linea', 'domain': domain,
            'agents': AGENTS, 'createdAt': CREATED, 'updatedAt': '2026-10-07T10:05:00.000Z', 'dag': dag, **extra}
    config.write_json(root / '.harness/tasks' / status / (identity + '.json'), task)
    return task


def make_handoff(root, identity, agent, status='passed', at='2026-10-07T10:01:00.000Z', attempt=1, **extra):
    config.write_json(root / '.harness/handoffs' / f'{identity}-{agent}-{attempt}.json',
                      {'taskId': identity, 'agent': agent, 'status': status, 'attempt': attempt, 'at': at, 'risks': [], 'nextAction': None, **extra})


def make_lock(root, identity, pid=None):
    (root / '.harness/state').mkdir(parents=True, exist_ok=True)
    (root / '.harness/state' / (identity + '.lock')).write_text(json.dumps({'pid': pid or os.getpid()}), encoding='utf-8')


def tree(root):
    return {p.relative_to(root).as_posix(): (p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest())
            for p in sorted(root.rglob('*')) if p.is_file()}


class Sink(io.StringIO):
    def __init__(self, tty=False):
        super().__init__()
        self.tty = tty

    def isatty(self):
        return self.tty


class ProgressTests(unittest.TestCase):
    def view(self, identity):
        return progress.build(identity, now=progress.parse_time('2026-10-07T10:10:00Z'))

    def test_percent_weights_each_node_and_caps_before_completion(self):
        with fixture() as root:
            make_task(root, 'tp1', passed=3, running='security-auditor')
            view = self.view('tp1')
            self.assertEqual((view['done'], view['total'], view['percent']), (3, 7, 42))
            make_task(root, 'tp1', passed=7)
            self.assertEqual(self.view('tp1')['percent'], 99)
            make_task(root, 'tp2', status='completed', passed=7)
            self.assertEqual(self.view('tp2')['percent'], 100)

    def test_running_node_counts_measurable_gate_substeps_only_while_live(self):
        with fixture() as root:
            make_task(root, 'tp1', passed=5, running='verifier')
            self.assertEqual(self.view('tp1')['percent'], int(100 * 5 / 7))
            make_lock(root, 'tp1')
            progress.record_gates('tp1', 'verifier', 2, 4, ['pnpm', 'lint'])
            view = self.view('tp1')
            self.assertEqual(view['percent'], int(100 * 5.5 / 7))
            node = next(n for n in view['nodes'] if n['id'] == 'verifier')
            self.assertEqual(node['gates'], {'done': 2, 'total': 4, 'current': 'pnpm lint'})
            self.assertIn('gates 2/4', progress.render(view))
            self.assertEqual(view['lastEvent']['kind'], 'gate')
            (root / '.harness/state/tp1.lock').unlink()  # interrupted run: stale counters are not trusted
            stale = self.view('tp1')
            self.assertEqual(stale['percent'], int(100 * 5 / 7))
            self.assertTrue(next(n for n in stale['nodes'] if n['id'] == 'verifier')['interrupted'])

    def test_node_lines_show_status_duration_and_attempts(self):
        with fixture() as root, patch.dict(os.environ):
            os.environ.pop('HARNESS_MAX_RETRIES', None)  # exercise the default, restored after this test
            make_task(root, 'tp1', passed=2, running='tester')
            make_handoff(root, 'tp1', 'context-manager', at='2026-10-07T10:00:05.000Z')
            make_handoff(root, 'tp1', 'architect', at='2026-10-07T10:02:05.000Z')
            make_lock(root, 'tp1')
            text = progress.render(self.view('tp1'))
            self.assertIn('Titulo de prueba', text)
            self.assertIn('✔ architect', text)
            self.assertIn('2m 00s', text)
            self.assertIn('⟳ tester', text)
            self.assertIn('corriendo', text)
            self.assertIn('· reviewer', text)
            self.assertIn('intento 1/3', text)
            self.assertIn('Último evento: architect passed', text)

    def test_multi_aggregates_children_and_final_gates(self):
        with fixture() as root:
            make_task(root, 'child1', passed=7, status='completed')
            make_task(root, 'child2', passed=1, running='architect', domain='docs')
            config.write_json(root / '.harness/tasks/active/multi1.json', {
                'schemaVersion': 1, 'id': 'multi1', 'status': 'active', 'domain': 'multi', 'task': 'x', 'createdAt': CREATED,
                'children': ['child1', 'child2']})
            view = self.view('multi1')
            self.assertEqual((view['done'], view['total'], view['percent']), (8, 15, 53))
            self.assertEqual([c['id'] for c in view['children']], ['child1', 'child2'])
            make_task(root, 'child2', passed=7, status='completed', domain='docs')
            make_lock(root, 'multi1')
            progress.record_gates('multi1', 'final-gates', 1, 4, ['pnpm', 'test'])
            view = self.view('multi1')
            self.assertEqual(view['finalGates']['done'], 1)
            self.assertEqual(view['percent'], int(100 * (14.25) / 15))
            self.assertIn('gates finales del multi: gates 1/4', progress.render(view))

    def test_failed_and_blocked_report_cause_and_exit_codes(self):
        with fixture() as root:
            make_task(root, 'tf1', status='failed', passed=3, failed='reviewer')
            make_handoff(root, 'tf1', 'reviewer', status='failed', risks=['Falta validar tenant en export'])
            view = self.view('tf1')
            self.assertIn('Falta validar tenant', view['cause'])
            self.assertEqual(progress.main(['tf1', '--watch', '--interval', '0.05'], Sink()), 1)
            make_task(root, 'tb1', passed=5, blocked='verifier')
            make_handoff(root, 'tb1', 'verifier', status='blocked', risks=['SKIPPED_ENVIRONMENT: docker'])
            view = self.view('tb1')
            self.assertEqual(view['state'], 'stalled')
            self.assertIn('docker', view['cause'])
            out = Sink()
            self.assertEqual(progress.main(['tb1', '--watch', '--interval', '0.05'], out), 3)
            make_task(root, 'tc1', status='completed', passed=7)
            self.assertEqual(progress.main(['tc1', '--watch', '--interval', '0.05'], Sink()), 0)

    def test_json_output_is_structured(self):
        with fixture() as root:
            make_task(root, 'tj1', passed=2, running='tester')
            out = Sink()
            self.assertEqual(progress.main(['tj1', '--json'], out), 0)
            data = json.loads(out.getvalue())
            self.assertEqual((data['id'], data['percent'], data['state'], len(data['nodes'])), ('tj1', 28, 'stalled', 7))
            self.assertEqual(data['nodes'][2]['status'], 'running')

    def test_watch_without_tty_prints_only_changes(self):
        with fixture() as root:
            make_task(root, 'tw1', passed=1, running='architect')
            make_lock(root, 'tw1')
            steps = iter([lambda: None, lambda: None,
                          lambda: (make_task(root, 'tw1', passed=2, running='tester'), None),
                          lambda: (make_task(root, 'tw1', status='completed', passed=7), (root / '.harness/state/tw1.lock').unlink())])
            with patch.object(progress.time, 'sleep', lambda _s: next(steps)()):
                out = Sink()
                self.assertEqual(progress.main(['tw1', '--watch'], out), 0)
            frames = [f for f in out.getvalue().split('\n\n') if f.strip()]
            self.assertEqual(len(frames), 3)
            self.assertNotIn('\x1b', out.getvalue())
            tty = Sink(tty=True)
            steps = iter([lambda: None])
            make_task(root, 'tw2', passed=1, running='architect')
            make_lock(root, 'tw2')
            def finish():
                make_task(root, 'tw2', status='failed', passed=1, failed='architect')
            steps = iter([finish])
            with patch.object(progress.time, 'sleep', lambda _s: next(steps)()):
                self.assertEqual(progress.main(['tw2', '--watch'], tty), 1)
            self.assertIn('\x1b[2J', tty.getvalue())

    def test_partial_files_are_tolerated(self):
        with fixture() as root:
            make_task(root, 'tx1', passed=2, running='tester')
            make_lock(root, 'tx1')
            (root / '.harness/handoffs/tx1-architect-1.json').write_text('{"taskId": "tx1", "agent": "arch', encoding='utf-8')
            make_handoff(root, 'tx1', 'context-manager')
            (root / '.harness/runtime/progress').mkdir(parents=True)
            (root / '.harness/runtime/progress/tx1.json').write_text('{"done": 1,', encoding='utf-8')
            view = self.view('tx1')  # no exception; unreadable counters and handoffs are ignored
            self.assertEqual(view['lastEvent']['agent'], 'context-manager')
            self.assertIsNone(next(n for n in view['nodes'] if n['id'] == 'tester')['gates'])
            good = (root / '.harness/tasks/active/tx1.json').read_text(encoding='utf-8')
            (root / '.harness/tasks/active/tx1.json').write_text(good[:40], encoding='utf-8')
            with self.assertRaises(progress.Transient):
                progress.build('tx1')
            def repair():
                (root / '.harness/tasks/active/tx1.json').write_text(good, encoding='utf-8')
                make_task(root, 'tx1', status='completed', passed=7)
                (root / '.harness/tasks/active/tx1.json').unlink()
            with patch.object(progress.time, 'sleep', lambda _s: repair()):
                self.assertEqual(progress.main(['tx1', '--watch'], Sink()), 0)

    def test_reader_writes_nothing_and_writer_stays_in_runtime_progress(self):
        with fixture() as root:
            make_task(root, 'tr1', passed=2, running='tester')
            make_lock(root, 'tr1')
            make_handoff(root, 'tr1', 'architect')
            before = tree(root)
            progress.main(['tr1'], Sink())
            progress.main(['tr1', '--json'], Sink())
            self.assertEqual(before, tree(root))
            progress.record_gates('tr1', 'verifier', 1, 3, ['pnpm', 'lint'])
            created = set(tree(root)) - set(before)
            self.assertEqual(created, {'.harness/runtime/progress/tr1.json'})
            self.assertTrue(snapshot.EPHEMERAL.search('.harness/runtime/progress/tr1.json'))
            progress.clear_gates('tr1')
            self.assertEqual(before.keys(), tree(root).keys())

    def test_default_task_prefers_live_lock_and_ignores_multi_children(self):
        with fixture() as root:
            make_task(root, 'a-old', passed=1, running='architect')
            make_task(root, 'b-new', passed=1, running='architect')
            self.assertEqual(progress.pick_task(), 'b-new')
            make_lock(root, 'a-old')
            self.assertEqual(progress.pick_task(), 'a-old')
            (root / '.harness/state/a-old.lock').unlink()
            make_task(root, 'z-child', passed=1)
            config.write_json(root / '.harness/tasks/active/c-multi.json', {'id': 'c-multi', 'status': 'active', 'domain': 'multi', 'children': ['z-child']})
            self.assertEqual(progress.pick_task(), 'c-multi')
            for name in ['a-old', 'b-new', 'z-child', 'c-multi']:
                (root / '.harness/tasks/active' / (name + '.json')).unlink()
            with self.assertRaises(ValueError):
                progress.pick_task()

    def test_announce_prints_compact_line_to_stderr_only_on_change(self):
        with fixture() as root:
            task = make_task(root, 'ta1', passed=3, running='security-auditor')
            progress._seen.pop('ta1', None)
            err = io.StringIO()
            progress.announce(task, err)
            progress.announce(task, err)
            self.assertEqual(err.getvalue(), '[harness] 3/7 42% security-auditor ⟳\n')
            task['dag'][4]['status'] = 'passed'
            progress.announce(task, err)
            self.assertTrue(err.getvalue().endswith('[harness] 4/7 57% security-auditor ✔\n'))

    def test_watch_stall_needs_two_consecutive_samples(self):
        with fixture() as root:
            make_task(root, 'ts1', passed=1, running='architect')
            sleeps = []
            def start():
                sleeps.append(1)
                make_lock(root, 'ts1')
            def stop():
                sleeps.append(2)
                (root / '.harness/state/ts1.lock').unlink()
            steps = iter([start, lambda: None, stop, lambda: None])
            with patch.object(progress.time, 'sleep', lambda _s: next(steps)()):
                self.assertEqual(progress.main(['ts1', '--watch'], Sink()), 3)
            self.assertEqual(sleeps, [1, 2])  # a single lockless sample never ends the watch

    def test_watch_json_emits_one_compact_object_per_change(self):
        with fixture() as root:
            make_task(root, 'tq1', passed=1, running='architect')
            make_lock(root, 'tq1')
            steps = iter([lambda: None, lambda: make_task(root, 'tq1', status='completed', passed=7)])
            with patch.object(progress.time, 'sleep', lambda _s: next(steps)()):
                out = Sink()
                self.assertEqual(progress.main(['tq1', '--watch', '--json'], out), 0)
            lines = out.getvalue().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual([json.loads(line)['percent'] for line in lines], [14, 100])

    def test_announce_marks_retries_and_never_raises(self):
        with fixture() as root:
            task = make_task(root, 'tn1', passed=2, running='tester')
            progress._seen.pop('tn1', None)
            task['dag'][2]['attempts'] = 2
            err = io.StringIO()
            progress.announce(task, err)
            self.assertIn('tester ⟳ (intento 2/', err.getvalue())
            progress.announce({'id': 'broken'}, err)  # malformed task: swallowed, stdout untouched
            out = Sink()
            with contextlib.redirect_stdout(out):
                progress.announce(task, err)
            self.assertEqual(out.getvalue(), '')

    def test_record_gates_is_atomic_redacted_and_rejects_bad_ids(self):
        with fixture() as root:
            progress.record_gates('tg1', 'verifier', 1, 2, ['cmd', '--token=abc123secretvalue'])
            directory = root / '.harness/runtime/progress'
            self.assertEqual([p.name for p in directory.iterdir()], ['tg1.json'])  # no tmp leftovers
            self.assertNotIn('abc123secretvalue', (directory / 'tg1.json').read_text(encoding='utf-8'))
            progress.record_gates('../evil', 'verifier', 1, 2)
            self.assertEqual([p.name for p in directory.iterdir()], ['tg1.json'])
            progress.clear_gates('tg1')
            progress.clear_gates('tg1')  # idempotent
            self.assertEqual(list(directory.iterdir()), [])

    def test_usage_errors(self):
        for args in (['--bogus'], ['a', 'b'], ['--interval', 'x'], ['--interval', '0'], ['bad/id']):
            with self.subTest(args=args), self.assertRaises(config.UsageError):
                progress.parse_args(args)
        self.assertEqual(progress.parse_args(['--interval=5', 'x1', '--watch'])['interval'], 5.0)

    def test_phases_group_nodes_and_json_gains_only_additive_keys(self):
        with fixture() as root:
            make_task(root, 'ti1', passed=2, running='tester')
            view = self.view('ti1')
            self.assertEqual([(p['id'], p['done'], p['total'], p['state']) for p in view['phases']],
                             [('código', 2, 2, 'passed'), ('pruebas', 0, 1, 'running'), ('revisión', 0, 2, 'pending'), ('verificación', 0, 2, 'pending')])
            for key in ('eta', 'phases', 'workers', 'alerts', 'failure'):
                self.assertIn(key, view)
            text = progress.render(view)
            self.assertLess(text.index('Código'), text.index('Pruebas'))
            self.assertLess(text.index('Pruebas'), text.index('⟳ tester'))

    def test_eta_from_finished_durations_and_omitted_when_unknown(self):
        with fixture() as root:
            task = make_task(root, 'te1', passed=3, running='security-auditor')
            self.assertIsNone(self.view('te1')['eta'])  # no live lock
            make_lock(root, 'te1')
            self.assertIsNone(self.view('te1')['eta'])  # live but no observed durations
            for node in task['dag'][:3]:
                node['activeMs'] = 60000
            config.write_json(root / '.harness/tasks/active/te1.json', task)
            eta = self.view('te1')['eta']
            self.assertEqual(eta['minutes'], 4)  # four remaining chained nodes at 1 min each
            self.assertIn('faltan ~4 min', progress.render(self.view('te1')))
            self.assertEqual(progress.signature(self.view('te1')), progress.signature({**self.view('te1'), 'eta': {'minutes': 9, 'remainingMs': 1}}))

    def test_critical_path_queue_and_workers(self):
        with fixture() as root:
            task = make_task(root, 'tc2', passed=1, running='architect')
            task['dag'][2]['dependsOn'] = ['context-manager']  # tester becomes ready in parallel with the running architect
            task['plan'] = {'workers': 8}
            config.write_json(root / '.harness/tasks/active/tc2.json', task)
            make_lock(root, 'tc2')
            view = self.view('tc2')
            tester = next(n for n in view['nodes'] if n['id'] == 'tester')
            self.assertTrue(tester['queued'])
            self.assertTrue(tester['critical'])
            self.assertFalse(next(n for n in view['nodes'] if n['id'] == 'architect')['critical'])
            self.assertEqual(view['workers'], {'active': 1, 'recommended': 8, 'queued': 1})
            self.assertIn('workers 1/8', progress.render(view))
            task.pop('plan')
            config.write_json(root / '.harness/tasks/active/tc2.json', task)
            self.assertIsNone(self.view('tc2')['workers']['recommended'])  # absent plan data is tolerated

    def test_slow_gate_alert_uses_typical_duration_from_audit_log(self):
        with fixture() as root:
            make_task(root, 'tg2', passed=5, running='verifier')
            make_lock(root, 'tg2')
            progress.record_gates('tg2', 'verifier', 1, 3, ['pnpm', 'lint'])
            gate = root / '.harness/runtime/progress/tg2.json'
            record = json.loads(gate.read_text(encoding='utf-8'))
            record['updatedAt'] = '2026-10-07T10:00:00.000Z'  # 10 minutes before the sampled "now"
            gate.write_text(json.dumps(record), encoding='utf-8')
            self.assertFalse(next(n for n in self.view('tg2')['nodes'] if n['id'] == 'verifier')['gateDetail']['slow'])  # no history: skipped
            for index, ms in enumerate([120000, 180000, 240000]):
                config.write_json(root / '.harness/logs/audit' / f'tg2-{index}-a.json',
                                  {'taskId': 'tg2', 'event': 'gate', 'command': 'pnpm lint', 'durationMs': ms})
            gates = next(n for n in self.view('tg2')['nodes'] if n['id'] == 'verifier')['gateDetail']
            self.assertEqual((gates['typicalMs'], gates['slow']), (180000, True))
            self.assertIn('gate lento', progress.render(self.view('tg2')))

    def test_failure_category_action_and_previous_attempt_reason(self):
        with fixture() as root:
            task = make_task(root, 'tf2', status='active', passed=3, failed='reviewer')
            task['dag'][3].update({'failureCategory': 'timeout', 'attempts': 2})
            config.write_json(root / '.harness/tasks/active/tf2.json', task)
            make_handoff(root, 'tf2', 'reviewer', status='failed', attempt=1, risks=['Falta validar tenant'])
            view = self.view('tf2')
            self.assertEqual(view['failure']['category'], 'timeout')
            node = next(n for n in view['nodes'] if n['id'] == 'reviewer')
            self.assertEqual(node['previousAttempt'], 'Falta validar tenant')
            text = progress.render(view)
            self.assertIn('intento anterior: Falta validar tenant', text)
            self.assertIn('Acción sugerida (timeout)', text)
            task['dag'][3]['failureCategory'] = 'nueva-categoria'
            config.write_json(root / '.harness/tasks/active/tf2.json', task)
            self.assertIsNone(self.view('tf2')['failure'])  # unknown categories are skipped, never raised

    def test_passive_alerts_for_dead_lock_and_orphan_worktrees(self):
        with fixture() as root:
            make_task(root, 'tl1', passed=1, running='architect')
            self.assertEqual(self.view('tl1')['alerts'], [])
            make_lock(root, 'tl1', pid=2 ** 22 + 12345)  # not a live process
            config.write_json(root / '.harness/runtime/worktrees/old.json', {'task': 'gone', 'name': 'wt-1', 'state': 'abandoned'})
            alerts = {a['kind']: a['message'] for a in self.view('tl1')['alerts']}
            self.assertEqual(set(alerts), {'dead-lock', 'orphan-worktrees'})
            self.assertIn('gone/wt-1', alerts['orphan-worktrees'])
            before = tree(root)
            progress.main(['tl1'], Sink())
            self.assertEqual(before, tree(root))

    def test_colors_only_on_tty_without_no_color_and_compact_line(self):
        with fixture() as root, patch.dict(os.environ):
            make_task(root, 'tk1', passed=2, running='tester')
            make_lock(root, 'tk1')
            os.environ.pop('NO_COLOR', None)
            tty = Sink(tty=True)
            progress.main(['tk1'], tty)
            self.assertIn('\x1b[', tty.getvalue())
            os.environ['NO_COLOR'] = '1'
            plain = Sink(tty=True)
            progress.main(['tk1'], plain)
            self.assertNotIn('\x1b', plain.getvalue())
            os.environ.pop('NO_COLOR')
            piped = Sink()
            progress.main(['tk1'], piped)
            self.assertNotIn('\x1b', piped.getvalue())
            compact = Sink()
            progress.main(['tk1', '--compact'], compact)
            self.assertEqual(len(compact.getvalue().strip().splitlines()), 1)
            self.assertIn('28%', compact.getvalue())
            self.assertIn('tester', compact.getvalue())
            self.assertTrue(progress.parse_args(['--compact'])['compact'])

    def test_missing_optional_sources_are_tolerated(self):
        with fixture() as root:
            make_task(root, 'tm1', passed=1, running='architect', metrics='garbage', plan=[1])
            view = self.view('tm1')  # no logs/audit, no worktrees registry, malformed metrics/plan
            self.assertEqual(view['alerts'], [])
            self.assertIsNone(view['eta'])


if __name__ == '__main__':
    unittest.main()
