"""Planner, admission budget, worktree integration and scheduler contracts. No host, no tokens: execute_node is simulated."""
import contextlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SOURCE))
from core import config, planner, state, tasks, worktree, scheduler, lifecycle, budget, context, delegation, snapshot, hygiene
from gitenv import GIT_ENV, git_run
from test_core import fixture

UNITS = ('unit: a | agent=documentation | owns=docs/a/** | weight=2\n'
         'unit: b | agent=documentation | owns=docs/b/** | weight=2\n'
         'unit: c | agent=documentation | owns=docs/c/** | weight=2\n')
TEXT = 'Crear la documentación de la plataforma\n\n' + UNITS


@contextlib.contextmanager
def repo(**env):
    """A fixture Harness inside a real Git repository, with every module that caches ROOT/H patched."""
    with fixture() as root, tempfile.TemporaryDirectory(prefix='redevent-wt-') as trees:
        (root / '.gitignore').write_text('.harness/runtime/*\n.harness/tasks/*/*\n.harness/handoffs/*\n.harness/state/*\n.harness/logs/*/*\n__pycache__/\n')
        git_run(root, 'init', '-q')
        git_run(root, 'add', '-A')
        git_run(root, 'commit', '-qm', 'base')
        with contextlib.ExitStack() as stack:
            for module in (worktree, scheduler):
                stack.enter_context(patch.object(module, 'ROOT', root))
                stack.enter_context(patch.object(module, 'H', root / '.harness'))
            stack.enter_context(patch.dict(os.environ, {'HARNESS_WORKTREE_DIR': trees, 'HARNESS_MAX_WORKERS': '3', 'HARNESS_HOST_LIMIT': '3',
                                                        'HARNESS_ROLE_LIMITS': 'documentation=3', 'HARNESS_MAX_RETRIES': '0', **env}))
            budget.BUDGET.configure()
            worktree.INTEGRATED.clear()
            yield root


class Sim:
    """Replacement for delegation.execute_node: honours persistence, the claim protocol and cancellation like the real one."""
    def __init__(self, ms=250, outcomes=None, ignore_cancel=False, per_node=None):
        self.ms, self.outcomes, self.ignore_cancel, self.per_node = ms, outcomes or {}, ignore_cancel, per_node or {}
        self.events, self.lock, self.live, self.peak = [], threading.Lock(), 0, 0

    def __call__(self, task, node, cancel=None):
        node['status'], node['attempts'] = 'running', node['attempts'] + 1
        node['runId'] = 'r' + str(node['attempts'])
        state.persist_task(task)
        with self.lock:
            self.events.append(('start', node['id'], time.monotonic(), node['attempts']))
            self.live += 1
            self.peak = max(self.peak, self.live)
        deadline = time.monotonic() + self.per_node.get(node['id'], self.ms) / 1000
        while time.monotonic() < deadline:
            if cancel is not None and cancel.is_set() and not self.ignore_cancel:
                with self.lock:
                    self.live -= 1
                node['status'], node['cancelled'] = 'pending', {'at': 'x'}
                raise delegation.Cancelled('cancelled')
            time.sleep(0.01)
        with self.lock:
            self.live -= 1
            self.events.append(('end', node['id'], time.monotonic(), node['attempts']))
        outcome = self.outcomes.get(node['id'], 'passed')
        outcome = outcome(node['attempts']) if callable(outcome) else outcome
        node['status'] = outcome
        if node['agent'] in ('reviewer', 'verifier') and outcome == 'failed':
            node['failureCategory'] = 'agent-result'
        state.handoff(task, node, outcome, {'verification': ['sim']})
        state.persist_task(task)
        return outcome == 'passed'

    def span(self, node):
        mine = [e for e in self.events if e[1] == node]
        return min(e[2] for e in mine if e[0] == 'start'), max(e[2] for e in mine if e[0] == 'end')


def run_scheduler(root, sim, text=TEXT, domain='docs'):
    task = tasks.make_task(domain, text)
    loaded = tasks.load_task(task['id'])
    with patch.object(scheduler, 'execute_node', sim):
        scheduler.run(loaded)
    return loaded


def overlap(a, b):
    return a[0] < b[1] and b[0] < a[1]


class PlannerTests(unittest.TestCase):
    def plan(self, text, domain='docs', risk='MEDIUM', selection=None):
        manifests = context.manifests()
        d = context.get_domain(domain)
        selection = selection or {'agents': ['context-manager', d['agent'], 'reviewer', 'verifier', 'logger'], 'temporary': None}
        return planner.plan(d, text, selection, manifests['agents'], risk)

    def test_directive_units_become_independent_nodes_with_ownership(self):
        with fixture():
            layout = self.plan(TEXT)
            nodes = {n['id']: n for n in layout['dag']}
            self.assertEqual([n for n in nodes if n.startswith('documentation-')], ['documentation-a', 'documentation-b', 'documentation-c'])
            for unit in 'abc':
                node = nodes['documentation-' + unit]
                self.assertEqual(node['dependsOn'], ['context-manager'])
                self.assertEqual(node['owns'], [f'docs/{unit}/**'])
                self.assertEqual(node['agent'], 'documentation')
            self.assertEqual(sorted(nodes['reviewer']['dependsOn']), ['documentation-a', 'documentation-b', 'documentation-c'])
            self.assertTrue(planner.parallel_capable(layout['dag']))
            self.assertEqual(layout['agents'], ['context-manager', 'documentation', 'reviewer', 'verifier', 'logger'])
            self.assertEqual(layout['plan']['source'], 'directive')
            self.assertGreater(layout['plan']['estimate']['speedup'], 1)

    def test_plain_tasks_keep_the_historical_chain_byte_for_byte(self):
        with fixture():
            from core.routing import build_dag
            selection = {'agents': ['context-manager', 'documentation', 'reviewer', 'verifier', 'logger'], 'temporary': None}
            layout = self.plan('Crear la documentación del proceso', selection=selection)
            self.assertIsNone(layout['plan'])
            self.assertEqual(layout['dag'], build_dag(selection['agents']))
            self.assertFalse(planner.parallel_capable(layout['dag']))

    def test_low_risk_and_off_mode_never_split(self):
        with fixture():
            self.assertIsNone(self.plan(TEXT, risk='LOW')['plan'])
            with patch.dict(os.environ, {'HARNESS_PLANNER': 'off'}):
                self.assertIsNone(self.plan(TEXT)['plan'])
            with patch.dict(os.environ, {'HARNESS_PLANNER': 'bogus'}):
                with self.assertRaises(ValueError):
                    self.plan(TEXT)

    def test_invalid_units_fail_closed(self):
        with fixture():
            cases = {
                'unit: a | agent=documentation': 'owns= is required',
                'unit: a | owns=docs/a/** | colour=red': 'invalid or unknown attribute',
                'unit: a | agent=ghost | owns=docs/a/**': 'unknown agent',
                'unit: a | agent=reviewer | owns=docs/a/**': 'cannot own writes',
                'unit: a | owns=apps/api/**': 'outside domain paths',
                'unit: a | owns=../etc/**': 'unsafe path',
                'unit: a | owns=docs/a/** | after=zzz': 'unknown unit',
                'unit: a | owns=docs/a/** | weight=0': 'weight',
                'unit: a | owns=docs/a/** | effects=maybe': 'effects',
                'unit: a | owns=docs/a/** | after=b\nunit: b | owns=docs/b/** | after=a': 'cycle',
                'unit: a | owns=docs/a/**\nunit: a | owns=docs/b/**': 'duplicate unit',
            }
            for text, expected in cases.items():
                with self.subTest(text=text), self.assertRaisesRegex(ValueError, expected):
                    self.plan('Crear documentación\n' + text)

    def test_overlapping_ownership_is_serialized_and_disjoint_is_not(self):
        with fixture():
            layout = self.plan('Crear documentación\nunit: wide | owns=docs/** | weight=2\nunit: deep | owns=docs/deep/** | weight=2\nunit: far | owns=docs/far/** | weight=2\n')
            nodes = {n['id']: n for n in layout['dag']}
            self.assertIn('documentation-wide', nodes['documentation-deep']['dependsOn'])
            self.assertIn('documentation-wide', nodes['documentation-far']['dependsOn'])
            self.assertNotIn('documentation-deep', nodes['documentation-far']['dependsOn'])
            self.assertEqual(len([n for n in layout['plan']['notes'] if 'serialized' in n]), 2)

    def test_external_effects_never_overlap_each_other(self):
        with fixture():
            layout = self.plan('Crear documentación\nunit: x | owns=docs/x/** | effects=external | weight=2\nunit: y | owns=docs/y/** | effects=external | weight=2\n')
            nodes = {n['id']: n for n in layout['dag']}
            self.assertIn('documentation-x', nodes['documentation-y']['dependsOn'])
            self.assertEqual(nodes['documentation-x']['kind'], 'external')

    def test_cost_benefit_declines_tiny_units(self):
        with fixture():
            layout = self.plan('Crear documentación\nunit: a | owns=docs/a/** | weight=0.05\nunit: b | owns=docs/b/** | weight=0.05\n')
            self.assertFalse(layout['plan']['parallel'])
            self.assertFalse(planner.parallel_capable(layout['dag']))
            self.assertTrue(any('ordered chain' in n for n in layout['plan']['notes']))

    def test_auto_split_needs_two_disjoint_owners(self):
        with fixture():
            long = ' con ejemplos y contexto abundante para que la unidad justifique un agente propio ' * 3
            two = f'Crear documentación:\n- Crear `docs/guide/intro.md`{long}\n- Agregar `docs/index/readme.md`{long}\n'
            self.assertEqual(self.plan(two)['plan']['source'], 'auto')
            same = f'Crear documentación:\n- Crear `docs/guide/intro.md`{long}\n- Agregar `docs/guide/more.md`{long}\n'
            self.assertIsNone(self.plan(same)['plan'])
            consuming = f'Crear documentación:\n- Crear `docs/guide/intro.md`{long}\n- Leer el existente `docs/index/readme.md`{long}\n'
            self.assertIsNone(self.plan(consuming)['plan'])

    def test_unit_count_is_bounded(self):
        with fixture():
            many = 'Crear documentación\n' + '\n'.join(f'unit: u{i} | owns=docs/u{i}/**' for i in range(20))
            with self.assertRaisesRegex(ValueError, 'limit'):
                self.plan(many)


class StateIdentityTests(unittest.TestCase):
    def task(self, root):
        return tasks.load_task(tasks.make_task('docs', TEXT)['id'])

    def test_planned_nodes_separate_node_id_from_agent(self):
        with repo() as root:
            task = self.task(root)
            ids = {n['id']: n['agent'] for n in task['dag']}
            self.assertEqual(ids['documentation-a'], 'documentation')
            state.validate_task(task)

    def test_malformed_identities_are_rejected(self):
        with repo() as root:
            task = self.task(root)
            for mutate, expected in [(lambda t: t['dag'][1].pop('unit'), 'malformed DAG node'),
                                     (lambda t: t['dag'][1].update(id='bad id'), 'malformed DAG node'),
                                     (lambda t: t['dag'][2].update(id=t['dag'][1]['id']), 'malformed DAG node'),
                                     (lambda t: t['dag'][1].update(owns='docs/a/**'), r'dag\[1\]\.owns'),
                                     (lambda t: t.update(agents=['documentation']), 'agents/DAG mismatch')]:
                broken = json.loads(json.dumps(task))
                mutate(broken)
                with self.subTest(expected=expected), self.assertRaisesRegex(ValueError, expected):
                    state.validate_task(broken)

    def test_handoff_files_are_unique_per_instance_and_legacy_names_are_kept(self):
        with repo() as root:
            task = self.task(root)
            a, b = (next(n for n in task['dag'] if n['id'] == i) for i in ('documentation-a', 'documentation-b'))
            a['attempts'] = b['attempts'] = 1
            state.handoff(task, a, 'passed', {'verification': ['x']})
            state.handoff(task, b, 'passed', {'verification': ['x']})
            reviewer = next(n for n in task['dag'] if n['id'] == 'reviewer')
            reviewer['attempts'] = 1
            state.handoff(task, reviewer, 'passed', {'verification': ['x']})
            names = sorted(p.name for p in (root / '.harness/handoffs').glob(task['id'] + '-*'))
            self.assertEqual(names, [f'{task["id"]}-documentation-a-1.json', f'{task["id"]}-documentation-b-1.json', f'{task["id"]}-reviewer-1.json'])
            record = json.loads((root / '.harness/handoffs' / names[0]).read_text())
            self.assertEqual((record['agent'], record['node']), ('documentation', 'documentation-a'))
            self.assertNotIn('node', json.loads((root / '.harness/handoffs' / names[2]).read_text()))


class ConfigAndBudgetTests(unittest.TestCase):
    def test_conservative_defaults_and_bounds(self):
        with patch.dict(os.environ, {}, clear=False):
            for name in ('HARNESS_MAX_WORKERS', 'HARNESS_HOST_LIMIT', 'HARNESS_ROLE_LIMITS'):
                os.environ.pop(name, None)
            self.assertEqual(config.max_workers(), 2)
            self.assertEqual(config.host_limit(), 2)
            self.assertEqual(config.role_limits(), (2, {}))
        for name, value in [('HARNESS_MAX_WORKERS', '0'), ('HARNESS_MAX_WORKERS', '17'), ('HARNESS_MAX_WORKERS', 'x'), ('HARNESS_HOST_LIMIT', '0')]:
            with patch.dict(os.environ, {name: value}), self.assertRaises(ValueError):
                config.max_workers() if 'WORKERS' in name else config.host_limit()
        for bad in ('backend', 'backend=0', 'Backend=2', 'backend=2,tester'):
            with patch.dict(os.environ, {'HARNESS_ROLE_LIMITS': bad}), self.assertRaises(ValueError):
                config.role_limits()
        with patch.dict(os.environ, {'HARNESS_ROLE_LIMITS': 'backend=1, tester=3'}):
            self.assertEqual(config.role_limits(), (2, {'backend': 1, 'tester': 3}))

    def test_total_role_and_host_limits_are_independent(self):
        with patch.dict(os.environ, {'HARNESS_MAX_WORKERS': '4', 'HARNESS_HOST_LIMIT': '3', 'HARNESS_ROLE_LIMITS': 'backend=2'}):
            b = budget.Budget()
            b.configure()
            self.assertTrue(b.try_acquire('backend', 'codex'))
            self.assertTrue(b.try_acquire('backend', 'codex'))
            self.assertFalse(b.try_acquire('backend', 'codex'), 'role limit')
            self.assertTrue(b.try_acquire('tester', 'codex'))
            self.assertFalse(b.try_acquire('infra', 'codex'), 'host limit')
            self.assertTrue(b.try_acquire('infra', 'claude'))
            self.assertFalse(b.try_acquire('tester', 'claude'), 'total limit')
            self.assertEqual(b.snapshot()['peak'], 4)
            b.release('backend', 'codex')
            self.assertTrue(b.try_acquire('tester', 'claude'))

    def test_throttle_never_goes_below_one_worker(self):
        with patch.dict(os.environ, {'HARNESS_MAX_WORKERS': '2'}):
            b = budget.Budget()
            b.configure()
            self.assertTrue(b.throttle())
            self.assertFalse(b.throttle())
            self.assertEqual(b.snapshot()['workers'], 1)

    def test_blocking_slot_waits_for_capacity(self):
        with patch.dict(os.environ, {'HARNESS_MAX_WORKERS': '1'}):
            b = budget.Budget()
            b.configure()
            order = []
            def second():
                with b.slot('x', 'h'):
                    order.append('second')
            with b.slot('x', 'h'):
                thread = threading.Thread(target=second)
                thread.start()
                time.sleep(0.15)
                order.append('first-done')
            thread.join(5)
            self.assertEqual(order, ['first-done', 'second'])


class WorktreeTests(unittest.TestCase):
    def make(self, root, node='documentation-a', attempt=1):
        return worktree.Worktree('20261010000000-abcdef', node, attempt, 'abcdef123456').create()

    def test_worktree_starts_from_head_plus_uncommitted_state(self):
        with repo() as root:
            (root / 'docs').mkdir()
            (root / 'docs/base.md').write_text('base')
            git_run(root, 'add', '-A')
            git_run(root, 'commit', '-qm', 'docs')
            (root / 'docs/base.md').write_text('dirty')
            (root / 'docs/new.md').write_text('untracked')
            (root / 'README.md').unlink(missing_ok=True)
            wt = self.make(root)
            try:
                self.assertEqual((wt.path / 'docs/base.md').read_text(), 'dirty')
                self.assertEqual((wt.path / 'docs/new.md').read_text(), 'untracked')
                self.assertNotEqual(wt.path, root)
                self.assertFalse(str(wt.path).startswith(str(root)), 'worktrees live outside the repository')
                self.assertEqual(set(wt.overlay), {'docs/base.md', 'docs/new.md'})
                self.assertEqual(snapshot.snapshot().get('docs/base.md'), snapshot.snapshot().get('docs/base.md'))
            finally:
                wt.discard()
            self.assertFalse(wt.path.exists())
            self.assertEqual(git_run(root, 'worktree', 'list', '--porcelain').stdout.count('worktree '), 1)

    def test_fixture_git_ignores_global_autocrlf(self):
        # The core inherits os.environ: a developer's global core.autocrlf=true must not reach it (racy CRLF entries).
        with repo() as root:
            effective = subprocess.run(['git', 'config', '--get', 'core.autocrlf'], cwd=root, capture_output=True, text=True)
            self.assertEqual(effective.stdout.strip(), 'false')
            self.assertEqual(git_run(root, 'diff', '--name-only', 'HEAD').stdout, '')

    def test_integration_applies_and_is_idempotent(self):
        with repo() as root:
            wt = self.make(root)
            (wt.path / 'docs/a').mkdir(parents=True)
            (wt.path / 'docs/a/out.txt').write_text('one')
            first = wt.integrate(['docs/a/out.txt'])
            self.assertEqual(first['applied'], ['docs/a/out.txt'])
            self.assertEqual((root / 'docs/a/out.txt').read_text(), 'one')
            second = wt.integrate(['docs/a/out.txt'])
            self.assertEqual((second['applied'], second['unchanged']), ([], ['docs/a/out.txt']))
            journal = json.loads(next((root / '.harness/runtime/integration').glob('*.json')).read_text())
            self.assertEqual(journal['state'], 'applied')
            wt.discard()

    def test_conflict_is_explicit_all_or_nothing_and_never_overwrites(self):
        with repo() as root:
            (root / 'docs').mkdir()
            (root / 'docs/shared.md').write_text('base')
            git_run(root, 'add', '-A')
            git_run(root, 'commit', '-qm', 'shared')
            wt = self.make(root)
            (wt.path / 'docs/shared.md').write_text('worker edit')
            (wt.path / 'docs/fresh.md').write_text('fresh')
            (root / 'docs/shared.md').write_text('someone else edit')
            with self.assertRaises(worktree.IntegrationConflict) as caught:
                wt.integrate(['docs/shared.md', 'docs/fresh.md'])
            self.assertEqual([c['file'] for c in caught.exception.conflicts], ['docs/shared.md'])
            self.assertEqual((root / 'docs/shared.md').read_text(), 'someone else edit')
            self.assertFalse((root / 'docs/fresh.md').exists(), 'all or nothing: the clean file is not applied either')
            journal = json.loads(next((root / '.harness/runtime/integration').glob('*.json')).read_text())
            self.assertEqual(journal['state'], 'conflict')
            self.assertTrue((wt.path / 'docs/shared.md').exists(), 'the worktree is evidence and is kept')
            wt.discard()

    def test_deletions_and_dirty_base_are_integrated_and_conflict_checked(self):
        with repo() as root:
            (root / 'docs').mkdir()
            (root / 'docs/old.md').write_text('old')
            git_run(root, 'add', '-A')
            git_run(root, 'commit', '-qm', 'old')
            (root / 'docs/old.md').write_text('dirty before the run')
            wt = self.make(root)
            (wt.path / 'docs/old.md').unlink()
            wt.integrate(['docs/old.md'])
            self.assertFalse((root / 'docs/old.md').exists())
            wt.discard()
            wt2 = self.make(root, attempt=2)
            (root / 'docs/old.md').write_text('recreated')
            (wt2.path / 'docs/old.md').write_text('mine')
            with self.assertRaises(worktree.IntegrationConflict):
                wt2.integrate(['docs/old.md'])
            wt2.discard()

    def test_half_applied_integration_is_finished_or_reported(self):
        with repo() as root:
            wt = self.make(root)
            (wt.path / 'docs/a').mkdir(parents=True)
            (wt.path / 'docs/a/one.txt').write_text('1')
            (wt.path / 'docs/a/two.txt').write_text('2')
            real_apply, count = worktree.apply_file, {'n': 0}
            def dies_on_second(*args):
                count['n'] += 1
                if count['n'] == 2:
                    raise KeyboardInterrupt()
                return real_apply(*args)
            with patch.object(worktree, 'apply_file', dies_on_second):
                with self.assertRaises(KeyboardInterrupt):
                    wt.integrate(['docs/a/one.txt', 'docs/a/two.txt'])
            self.assertTrue((root / 'docs/a/one.txt').exists() and not (root / 'docs/a/two.txt').exists())
            result = worktree.resume_journals('20261010000000-abcdef')
            self.assertEqual(result[0]['problems'], [])
            self.assertEqual((root / 'docs/a/two.txt').read_text(), '2')
            # A third party touching a pending file turns resume into a report, not an overwrite.
            wt.discard()
            wt2 = self.make(root, attempt=2)
            (wt2.path / 'docs/b').mkdir(parents=True)
            (wt2.path / 'docs/b/x.txt').write_text('x')
            with patch.object(worktree, 'apply_file', side_effect=KeyboardInterrupt()):
                with self.assertRaises(KeyboardInterrupt):
                    wt2.integrate(['docs/b/x.txt'])
            (root / 'docs/b').mkdir()
            (root / 'docs/b/x.txt').write_text('foreign')
            result = worktree.resume_journals('20261010000000-abcdef')
            self.assertEqual(result[0]['problems'], ['docs/b/x.txt'])
            self.assertEqual((root / 'docs/b/x.txt').read_text(), 'foreign')
            wt2.discard()

    def test_recover_keeps_abandoned_worktrees_and_only_kills_provable_orphans(self):
        with repo() as root:
            wt = self.make(root)
            process = subprocess.Popen([sys.executable, '-B', '-c', 'import time; time.sleep(60)'], start_new_session=True)
            try:
                wt.record_process(process.pid)
                entry = worktree.list_registry()[0]
                if worktree.process_identity(process.pid) is None:
                    self.skipTest('this platform cannot identify processes')
                wrong = {**entry, 'agentIdentity': 'not-the-same-process'}
                self.assertFalse(worktree.kill_orphan(wrong), 'a reused pid must never be killed')
                self.assertIsNone(process.poll())
                other_host = {**entry, 'host': 'another-machine'}
                self.assertFalse(worktree.kill_orphan(other_host))
                found = worktree.recover('20261010000000-abcdef')
                self.assertEqual([f['node'] for f in found], ['documentation-a'])
                self.assertTrue(found[0]['orphanKilled'])
                process.wait(5)
                self.assertTrue(wt.path.exists(), 'recovery never deletes evidence')
                self.assertEqual(worktree.list_registry()[0]['state'], 'abandoned')
                self.assertEqual(worktree.recover('20261010000000-abcdef'), [], 'recovery is idempotent')
            finally:
                if process.poll() is None:
                    process.kill()
                wt.discard()

    def test_secrets_are_never_replicated_into_a_worktree(self):
        with repo() as root:
            (root / 'secrets').mkdir()
            (root / 'secrets/prod.key').write_text('private')
            (root / 'notes.txt').write_text('fine')
            wt = self.make(root)
            try:
                self.assertTrue((wt.path / 'notes.txt').exists())
                self.assertFalse((wt.path / 'secrets').exists())
                self.assertNotIn('secrets/prod.key', wt.overlay)
            finally:
                wt.discard()

    def test_a_moved_head_is_detected(self):
        with repo() as root:
            wt = self.make(root)
            try:
                self.assertFalse(wt.head_moved())
                git_run(wt.path, 'commit', '--allow-empty', '-qm', 'delegated commit')
                self.assertTrue(wt.head_moved())
            finally:
                wt.discard()

    def test_relative_worktree_dir_is_rejected(self):
        with repo():
            with patch.dict(os.environ, {'HARNESS_WORKTREE_DIR': 'relative/dir'}), self.assertRaises(ValueError):
                worktree.base_dir()

    def test_not_available_without_git(self):
        with fixture() as root, patch.object(worktree, 'ROOT', root):
            self.assertFalse(worktree.available())


class SchedulerTests(unittest.TestCase):
    def test_independent_nodes_overlap_and_dependents_wait(self):
        with repo() as root:
            # Measure useful parallel writer work, rather than tiny jobs whose
            # worktree/process overhead dominates on Windows. Keep the short
            # sequential review tail and all overlap/speedup assertions intact.
            sim = Sim(ms=100, per_node={f'documentation-{unit}': 5000 for unit in 'abc'})
            task = run_scheduler(root, sim)
            self.assertEqual(sim.peak, 3)
            a, b, c = (sim.span('documentation-' + u) for u in 'abc')
            self.assertTrue(overlap(a, b) and overlap(b, c))
            review = sim.span('reviewer')
            self.assertGreaterEqual(review[0], max(a[1], b[1], c[1]))
            self.assertGreaterEqual(sim.span('verifier')[0], review[1])
            lifecycle.settle(task)
            self.assertEqual(task['status'], 'completed')
            self.assertEqual(task['metrics']['mode'], 'parallel')
            self.assertEqual(task['metrics']['peakConcurrency'], 3)
            self.assertGreater(task['metrics']['speedup'], 1.1, 'three overlapped writers amid a sequential review/verify tail')
            self.assertLess(task['metrics']['criticalPathMs'], task['metrics']['sequentialMs'])

    def test_worker_role_and_host_limits_cap_real_concurrency(self):
        for env, peak in [({'HARNESS_MAX_WORKERS': '2'}, 2), ({'HARNESS_ROLE_LIMITS': 'documentation=1'}, 1), ({'HARNESS_HOST_LIMIT': '2', 'HARNESS_HOST': 'codex'}, 2)]:
            with self.subTest(env=env), repo(**env) as root:
                sim = Sim(ms=200)
                run_scheduler(root, sim)
                self.assertEqual(sim.peak, peak)

    def test_ready_nodes_start_on_the_critical_path_first(self):
        with repo(HARNESS_MAX_WORKERS='1') as root:
            text = 'Crear documentación\nunit: light | owns=docs/l/** | weight=1\nunit: heavy | owns=docs/h/** | weight=9\nunit: tail | owns=docs/t/** | weight=5 | after=heavy\nunit: side | owns=docs/s/** | weight=8\n'
            sim = Sim(ms=60)
            run_scheduler(root, sim, text)
            order = [e[1] for e in sim.events if e[0] == 'start' and e[1].startswith('documentation-')]
            self.assertEqual(order[:3], ['documentation-heavy', 'documentation-side', 'documentation-tail'][:1] + order[1:3])
            self.assertEqual(order[0], 'documentation-heavy')
            self.assertLess(order.index('documentation-side'), order.index('documentation-light'), 'longer remaining chain first')
            self.assertEqual(order.index('documentation-tail') > order.index('documentation-heavy'), True)

    def test_overlapping_ownership_never_runs_together_even_without_planner_edges(self):
        with repo() as root:
            task = tasks.make_task('docs', TEXT)
            loaded = tasks.load_task(task['id'])
            loaded['dag'][1]['owns'] = ['docs/**']
            sim = Sim(ms=200)
            with patch.object(scheduler, 'execute_node', sim):
                scheduler.run(loaded)
            wide = sim.span('documentation-a')
            self.assertFalse(overlap(wide, sim.span('documentation-b')))
            self.assertFalse(overlap(wide, sim.span('documentation-c')))

    def test_failure_propagates_without_a_false_success(self):
        with repo() as root:
            sim = Sim(ms=100, outcomes={'documentation-b': 'failed'})
            task = run_scheduler(root, sim)
            lifecycle.settle(task)
            status = {n['id']: n['status'] for n in task['dag']}
            self.assertEqual(status['documentation-a'], 'passed')
            self.assertEqual(status['documentation-b'], 'failed')
            self.assertEqual(status['reviewer'], 'blocked')
            self.assertEqual(status['verifier'], 'blocked')
            self.assertEqual(task['status'], 'failed')
            self.assertFalse(any(e[1] == 'reviewer' for e in sim.events))

    def test_only_the_failed_node_is_retried_within_the_bound(self):
        with repo(HARNESS_MAX_RETRIES='2') as root:
            sim = Sim(ms=60, outcomes={'documentation-b': lambda attempt: 'failed' if attempt < 3 else 'passed'})
            task = run_scheduler(root, sim)
            lifecycle.settle(task)
            self.assertEqual({n['id']: n['attempts'] for n in task['dag'] if n['id'].startswith('documentation-')},
                             {'documentation-a': 1, 'documentation-b': 3, 'documentation-c': 1})
            self.assertEqual(task['status'], 'completed')
        with repo(HARNESS_MAX_RETRIES='1') as root:
            sim = Sim(ms=60, outcomes={'documentation-b': 'failed'})
            task = run_scheduler(root, sim)
            lifecycle.settle(task)
            self.assertEqual(next(n for n in task['dag'] if n['id'] == 'documentation-b')['attempts'], 2)
            self.assertEqual(task['status'], 'failed')

    def test_reviewer_findings_reopen_only_the_owner_of_the_cited_path(self):
        with repo(HARNESS_MAX_RETRIES='2') as root:
            sim = Sim(ms=40, outcomes={'reviewer': lambda attempt: 'failed' if attempt == 1 else 'passed'})
            original = state.handoff
            def handoff(task, node, status, extra=None):
                if node['id'] == 'reviewer' and status == 'failed':
                    extra = {**(extra or {}), 'risks': ['docs/b/out.txt is wrong']}
                return original(task, node, status, extra)
            with patch.object(state, 'handoff', handoff), patch.object(delegation, 'handoff', handoff):
                task = run_scheduler(root, sim)
            attempts = {n['id']: n['attempts'] for n in task['dag']}
            self.assertEqual((attempts['documentation-a'], attempts['documentation-b'], attempts['documentation-c']), (1, 2, 1))
            self.assertEqual(attempts['reviewer'], 2)
            lifecycle.settle(task)
            self.assertEqual(task['status'], 'completed')

    def test_unattributable_findings_reopen_every_writer_like_the_sequential_loop(self):
        with repo(HARNESS_MAX_RETRIES='2') as root:
            sim = Sim(ms=40, outcomes={'reviewer': lambda attempt: 'failed' if attempt == 1 else 'passed'})
            task = run_scheduler(root, sim)
            self.assertEqual([n['attempts'] for n in task['dag'] if n['id'].startswith('documentation-')], [2, 2, 2])

    def test_cancelled_executions_cannot_write_late_results(self):
        with repo() as root:
            task = tasks.load_task(tasks.make_task('docs', TEXT)['id'])
            sched = scheduler.Scheduler(task)
            node = sched.node('documentation-a')
            run = scheduler.Run(node, 'claim-1', threading.Event())
            run.future = None
            sched.active['documentation-a'] = run
            sched.node('context-manager')['status'] = 'passed'
            node['claim'], node['status'] = 'claim-1', 'running'
            local = json.loads(json.dumps(task))
            local_node = next(n for n in local['dag'] if n['id'] == 'documentation-a')
            local_node['status'] = 'passed'
            sched.sink(local, 'documentation-a')
            self.assertEqual(node['status'], 'passed', 'the current claim is merged')
            node['status'], node['claim'] = 'running', 'claim-2'  # re-queued: the old execution is now stale
            local_node['status'], local_node['claim'] = 'failed', 'claim-1'
            sched.sink(local, 'documentation-a')
            self.assertEqual(node['status'], 'running', 'a late write from the superseded execution is dropped')
            sched.active.clear()
            sched.sink(local, 'documentation-a')
            self.assertEqual(node['status'], 'running', 'and so is any write after the node left the active set')

    def test_stop_cancels_running_workers_and_discards_what_they_report_later(self):
        with repo() as root:
            sim = Sim(ms=1500, ignore_cancel=True, per_node={'context-manager': 10})
            task = tasks.load_task(tasks.make_task('docs', TEXT)['id'])
            sched = scheduler.Scheduler(task)
            threading.Timer(0.5, lambda: setattr(sched, 'stop', True)).start()
            with patch.object(scheduler, 'execute_node', sim):
                sched.run()
            for n in task['dag']:
                if n['agent'] == 'documentation':
                    self.assertNotEqual(n['status'], 'passed', n['id'] + ' must not be marked passed after cancellation')
            audit = [json.loads(p.read_text()) for p in (root / '.harness/logs/audit').glob('*.json')]
            self.assertTrue(any(e['event'] == 'cancel-all' for e in audit))
            self.assertTrue(any(e['event'] == 'late-result-discarded' for e in audit))

    def test_keyboard_interrupt_cancels_every_worker_and_leaves_the_task_resumable(self):
        with repo() as root:
            sim = Sim(ms=5000, per_node={'context-manager': 10})
            task = tasks.load_task(tasks.make_task('docs', TEXT)['id'])
            sched = scheduler.Scheduler(task)
            real_wait = scheduler.wait
            def interrupting(futures, **kw):
                if sim.live >= 3:
                    raise KeyboardInterrupt()
                return real_wait(futures, **kw)
            started = time.monotonic()
            with patch.object(scheduler, 'execute_node', sim), patch.object(scheduler, 'wait', interrupting):
                with self.assertRaises(KeyboardInterrupt):
                    sched.run()
            self.assertLess(time.monotonic() - started, 4, 'workers were cancelled, not waited for')
            self.assertEqual(sim.live, 0)
            persisted = tasks.load_task(task['id'])
            self.assertEqual(persisted['status'], 'active')
            self.assertTrue(all(n['status'] == 'pending' for n in persisted['dag'] if n['id'].startswith('documentation-')))
            self.assertTrue(all(n.get('interrupted') for n in persisted['dag'] if n['id'].startswith('documentation-')))
            self.assertTrue(all(n['attempts'] == 1 for n in persisted['dag'] if n['id'].startswith('documentation-')), 'attempt history is preserved')
            resumed = tasks.load_task(task['id'])
            with patch.object(scheduler, 'execute_node', Sim(ms=30)):
                scheduler.run(resumed)
            lifecycle.settle(resumed)
            self.assertEqual(resumed['status'], 'completed')

    def test_host_unavailability_throttles_workers(self):
        with repo(HARNESS_MAX_RETRIES='1') as root:
            def host_down(attempt):
                return 'failed' if attempt == 1 else 'passed'
            sim = Sim(ms=40, outcomes={'documentation-a': host_down})
            original = sim.__call__
            def with_category(task, node, cancel=None):
                result = original(task, node, cancel)
                if node['id'] == 'documentation-a' and node['status'] == 'failed':
                    node['failureCategory'] = 'host-unavailable'
                return result
            task = tasks.load_task(tasks.make_task('docs', TEXT)['id'])
            with patch.object(scheduler, 'execute_node', with_category):
                scheduler.run(task)
            self.assertEqual(task['metrics']['throttled'], 1)
            self.assertEqual(budget.BUDGET.snapshot()['workers'], 2)

    def test_integrated_files_are_allowed_but_foreign_writes_in_main_are_a_violation(self):
        with repo() as root:
            task = tasks.load_task(tasks.make_task('docs', TEXT)['id'])
            sched = scheduler.Scheduler(task)
            sched.window = snapshot.snapshot()
            (root / 'docs/a').mkdir(parents=True)
            (root / 'docs/a/out.txt').write_text('integrated')
            sched.integrated = {'docs/a/out.txt'}
            sched.close_window()
            self.assertFalse(task.get('scopeViolation'))
            sched.window = snapshot.snapshot()
            (root / 'docs/a/sneaky.txt').write_text('sneaky')
            sched.close_window()
            self.assertIn('docs/a/sneaky.txt', task['scopeViolation']['reason'])
            self.assertTrue(sched.stop)

    def test_task_timeout_stops_launching_and_cancels(self):
        with repo(HARNESS_TASK_TIMEOUT_MS='200') as root:
            sim = Sim(ms=3000)
            task = tasks.load_task(tasks.make_task('docs', TEXT)['id'])
            with patch.object(scheduler, 'execute_node', sim):
                scheduler.run(task)
            self.assertFalse(any(n['status'] == 'passed' for n in task['dag'] if n['agent'] == 'documentation'))
            errors = [json.loads(p.read_text()) for p in (root / '.harness/logs/errors').glob('*.json')]
            self.assertTrue(any(e['event'] == 'task-timeout' for e in errors))


class LifecycleSelectionTests(unittest.TestCase):
    def test_existing_portals_share_one_wave_after_shared_and_api_dependencies(self):
        with fixture():
            children = [{'id': 'x-' + domain, 'domain': domain} for domain in
                        ['repo', 'api', 'backoffice', 'provider-portal', 'sales-portal']]
            waves = lifecycle.child_waves(children)
            self.assertEqual([[child['domain'] for child in wave] for wave in waves],
                             [['repo'], ['api'], ['backoffice', 'provider-portal', 'sales-portal']])

    def test_child_waves_keep_dependencies_and_never_mix_overlapping_domains(self):
        with fixture():
            def child(domain):
                return {'id': 'x-' + domain, 'domain': domain}
            waves = lifecycle.child_waves([child(d) for d in ['repo', 'api', 'infra', 'backoffice', 'docs']])
            self.assertEqual([[c['domain'] for c in w] for w in waves], [['repo'], ['api', 'infra'], ['backoffice'], ['docs']])
            self.assertEqual([[c['domain'] for c in w] for w in lifecycle.child_waves([child('api'), child('infra')])], [['api', 'infra']])
            self.assertEqual([[c['domain'] for c in w] for w in lifecycle.child_waves([child('docs'), child('api')])], [['api'], ['docs']])

    def test_parallel_requires_workers_git_and_no_opt_out(self):
        with repo() as root:
            self.assertTrue(lifecycle.parallel_enabled())
            with patch.dict(os.environ, {'HARNESS_MAX_WORKERS': '1'}):
                self.assertFalse(lifecycle.parallel_enabled())
            with patch.dict(os.environ, {'HARNESS_PARALLEL': '0'}):
                self.assertFalse(lifecycle.parallel_enabled())
        with fixture() as root, patch.object(worktree, 'ROOT', root):
            self.assertFalse(lifecycle.parallel_enabled(), 'a checkout without Git falls back to sequential execution')

    def test_hygiene_reports_and_prunes_worktrees_of_finished_tasks_only(self):
        with repo() as root:
            task = tasks.make_task('docs', 'Crear documentación del proceso')
            wt = worktree.Worktree(task['id'], 'documentation', 1, 'abcdef123456').create()
            found = hygiene.report()['findings']
            leftovers = [f for f in found if f['kind'] == 'leftover-worktree']
            self.assertEqual(len(leftovers), 1)
            self.assertIn('evidencia', leftovers[0]['action'])
            self.assertEqual(hygiene.prune_worktrees(True), [], 'an active task keeps its evidence')
            loaded = tasks.load_task(task['id'])
            for n in loaded['dag']:
                n['status'] = 'passed'
            state.move_task(loaded, 'completed')
            self.assertEqual(len(hygiene.prune_worktrees(False)), 1, 'dry run reports')
            self.assertTrue(wt.path.exists())
            self.assertEqual(len(hygiene.prune_worktrees(True)), 1)
            self.assertFalse(wt.path.exists())


if __name__ == '__main__':
    unittest.main()
