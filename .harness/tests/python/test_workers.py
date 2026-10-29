"""Automatic worker sizing and env-file isolation (pure unit tests, no real tasks)."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from core import config  # noqa: E402
from core.budget import Budget  # noqa: E402

PINNED = ('HARNESS_MAX_WORKERS', 'HARNESS_HOST_LIMIT', 'HARNESS_ROLE_LIMITS')


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if k not in PINNED}
    env.update(extra)
    return patch.dict(os.environ, env, clear=True)


class WorkerSizingTests(unittest.TestCase):
    def test_recommended_is_width_capped_by_policy(self):
        cap = config.policy()['parallel']['autoMaxWorkers']
        self.assertEqual(config.recommended_workers(1), 1)
        self.assertEqual(config.recommended_workers(5), 5)
        self.assertEqual(config.recommended_workers(99), cap)
        self.assertEqual(config.recommended_workers(None), 1)

    def test_auto_sizing_raises_unset_limits(self):
        with clean_env():
            workers, source, role_default, _, host = config.effective_limits(5)
        self.assertEqual((workers, source, role_default, host), (5, 'auto', 5, 5))

    def test_explicit_env_always_wins(self):
        with clean_env(HARNESS_MAX_WORKERS='3', HARNESS_HOST_LIMIT='2', HARNESS_ROLE_LIMITS='backend=1'):
            workers, source, role_default, roles, host = config.effective_limits(8)
        self.assertEqual((workers, source, host, roles), (3, 'env', 2, {'backend': 1}))

    def test_no_width_keeps_historical_default(self):
        with clean_env():
            self.assertEqual(config.effective_limits()[0], config.max_workers())
            self.assertEqual(config.effective_limits()[1], 'default')

    def test_budget_configure_uses_width_and_reports_source(self):
        budget = Budget()
        with clean_env():
            budget.configure(width=4)
            snap = budget.snapshot()
        self.assertEqual((snap['configured'], snap['source']), (4, 'auto'))
        self.assertTrue(budget.try_acquire('backend', 'none'))
        with clean_env(HARNESS_MAX_WORKERS='1'):
            budget.configure(width=4)
            self.assertEqual(budget.snapshot()['configured'], 1)

    def test_rationale_for_legacy_and_parallel_plans(self):
        self.assertIn('1 worker', config.worker_rationale(None, 1))
        text = config.worker_rationale({'parallel': True, 'width': 4, 'estimate': {'speedup': 2.0}}, 4)
        self.assertIn('4 workers', text)


class EnvIsolationTests(unittest.TestCase):
    def test_flag_detection(self):
        with patch.dict(os.environ, {'HARNESS_IGNORE_ENV_FILE': '1'}):
            self.assertTrue(config.env_file_ignored())
        with patch.dict(os.environ, {'HARNESS_IGNORE_ENV_FILE': '0'}):
            self.assertFalse(config.env_file_ignored())

    def test_cli_load_env_skips_file_when_ignored(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('harness_cli', Path(__file__).resolve().parents[2] / 'cli.py')
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / '.env').write_text('HARNESS_ZZ_PROBE=leaked\n', encoding='utf-8')
            with patch.object(cli, 'H', Path(tmp)), patch.dict(os.environ, {'HARNESS_IGNORE_ENV_FILE': '1'}):
                os.environ.pop('HARNESS_ZZ_PROBE', None)
                cli.load_env()
                self.assertNotIn('HARNESS_ZZ_PROBE', os.environ)
            with patch.object(cli, 'H', Path(tmp)), patch.dict(os.environ, {}, clear=False):
                os.environ.pop('HARNESS_IGNORE_ENV_FILE', None)
                os.environ.pop('HARNESS_ZZ_PROBE', None)
                cli.load_env()
                self.assertEqual(os.environ.get('HARNESS_ZZ_PROBE'), 'leaked')
                os.environ.pop('HARNESS_ZZ_PROBE', None)


if __name__ == '__main__':
    unittest.main()
