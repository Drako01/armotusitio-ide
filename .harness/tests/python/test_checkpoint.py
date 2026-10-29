"""Unit checkpoints: reuse when inputs are unchanged, invalidate on change, never repeat side effects silently."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from core import checkpoint, config  # noqa: E402


def node(unit='backend-a', status='passed', **extra):
    return {'id': unit, 'agent': 'backend', 'owns': ['src/a.txt'], 'dependsOn': [], 'status': status, 'attempts': 1, **extra}


class ProcessProbeTests(unittest.TestCase):
    def test_windows_probe_never_sends_a_console_signal(self):
        from core import state
        with patch.object(checkpoint.os, 'kill') as signal_process:
            with patch.object(state, 'alive', return_value=True) as probe:
                self.assertTrue(checkpoint.alive(123))
                probe.assert_called_once_with(123)
            signal_process.assert_not_called()

    def test_invalid_pids_never_probe_or_signal(self):
        from core import state
        with patch.object(state, 'alive') as probe:
            for value in (None, '', 'invalid', 0, -1):
                self.assertFalse(checkpoint.alive(value))
            probe.assert_not_called()


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / '.harness' / 'manifests').mkdir(parents=True)
        (root / 'src').mkdir()
        (root / 'src' / 'a.txt').write_text('one', encoding='utf-8')
        self.root = root
        # config.H too: resume telemetry (core.telemetry.log_file) otherwise appended to the real .harness/state.
        self.patches = [patch.object(checkpoint, 'H', root / '.harness'), patch.object(checkpoint, 'ROOT', root),
                        patch.object(config, 'H', root / '.harness'), patch.object(checkpoint, 'git', lambda *a: 'deadbeef\n')]
        for p in self.patches:
            p.start()
        self.task = {'id': '20260101000000-abcdef', 'task': 'do it', 'dag': []}

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_passed_unit_is_reused_while_inputs_are_unchanged(self):
        done = node()
        checkpoint.finish(self.task, done)
        self.task['dag'] = [node(status='pending')]
        result = checkpoint.apply(self.task)
        self.assertEqual(result['reused'], ['backend-a'])
        self.assertEqual(self.task['dag'][0]['status'], 'passed')

    def test_changed_code_invalidates_the_checkpoint(self):
        checkpoint.finish(self.task, node())
        (self.root / 'src' / 'a.txt').write_text('two', encoding='utf-8')
        self.task['dag'] = [node(status='pending')]
        self.assertEqual(checkpoint.apply(self.task)['reused'], [])
        self.assertEqual(self.task['dag'][0]['status'], 'pending')

    def test_changed_env_and_task_text_invalidate(self):
        checkpoint.finish(self.task, node())
        self.task['dag'] = [node(status='pending')]
        with patch.dict(os.environ, {'GOFLAGS': '-race'}):
            self.assertEqual(checkpoint.classify(self.task, self.task['dag'][0])[0], 'rerun')
        self.task['task'] = 'different'
        self.assertEqual(checkpoint.classify(self.task, self.task['dag'][0])[0], 'rerun')

    def test_failed_unit_reruns_and_only_it(self):
        checkpoint.finish(self.task, node('ok'))
        checkpoint.finish(self.task, node('bad', status='failed'))
        self.task['dag'] = [node('ok', 'pending'), node('bad', 'pending')]
        self.assertEqual(checkpoint.apply(self.task)['reused'], ['ok'])
        self.assertEqual([n['status'] for n in self.task['dag']], ['passed', 'pending'])

    def test_side_effect_unit_needs_reconciliation(self):
        unit = node('ext', 'running', effects='external')
        checkpoint.begin(self.task, unit)
        stale = checkpoint.read(self.task['id'], 'ext')
        stale['pid'] = 99999999
        checkpoint.write_json(checkpoint.storage(self.task['id'], 'ext'), stale)
        self.task['dag'] = [node('ext', 'pending', effects='external')]
        self.assertEqual(checkpoint.apply(self.task)['blocked'], ['ext'])
        checkpoint.reconcile(self.task['id'], 'ext')
        self.assertEqual(checkpoint.classify(self.task, self.task['dag'][0])[0], 'rerun')

    def test_host_unavailable_clears_side_effects(self):
        unit = node('ext', 'failed', effects='external', failureCategory='host-unavailable')
        checkpoint.begin(self.task, unit)
        checkpoint.finish(self.task, unit)
        self.assertFalse(checkpoint.read(self.task['id'], 'ext')['sideEffects']['done'])

    def test_reviewers_and_unowned_nodes_are_never_checkpointed(self):
        checkpoint.finish(self.task, {'id': 'reviewer', 'agent': 'reviewer', 'owns': ['x'], 'status': 'passed', 'attempts': 1})
        checkpoint.finish(self.task, {'id': 'backend', 'agent': 'backend', 'status': 'passed', 'attempts': 1})
        self.assertIsNone(checkpoint.read(self.task['id'], 'reviewer'))
        self.assertIsNone(checkpoint.read(self.task['id'], 'backend'))

    def test_path_traversal_ids_are_rejected(self):
        for bad in ('../x', 'a/b', '..', 'a\b', ''):
            with self.assertRaises(ValueError):
                checkpoint.storage('20260101000000-abcdef', bad or '/')
        with self.assertRaises(ValueError):
            checkpoint.storage('../escape', 'unit')

    def test_safely_swallows_errors(self):
        self.assertIsNone(checkpoint.safely(lambda: 1 / 0))

    def test_plan_explains_each_unit(self):
        checkpoint.finish(self.task, node('ok'))
        self.task['dag'] = [node('ok', 'pending'), {'id': 'reviewer', 'agent': 'reviewer', 'dependsOn': [], 'status': 'pending', 'attempts': 0}]
        actions = {p['unit']: p['action'] for p in checkpoint.plan(self.task)}
        self.assertEqual(actions, {'ok': 'reuse', 'reviewer': 'rerun'})


if __name__ == '__main__':
    unittest.main()
