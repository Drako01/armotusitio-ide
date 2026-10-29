from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SOURCE))
from core import bench


def report(speedup):
    run = {'workers': 4, 'wallMs': 100, 'writerPhaseMs': 100, 'speedup': speedup, 'writerPhaseSpeedup': 4.0, 'peakConcurrency': 4,
           'status': 'completed'}
    return {'results': [{'scenario': 'independent', 'units': 4, 'sequential': {**run, 'workers': 1}, 'parallel': [run]}]}


class BenchTests(unittest.TestCase):
    def test_synthetic_task_skips_the_operator_preflight(self):
        completed = subprocess.CompletedProcess([], 0, '{}', '')
        with patch.object(bench.subprocess, 'run', return_value=completed) as run, patch.dict('os.environ', {'HARNESS_PREFLIGHT': ''}):
            bench.harness(Path('repo'), ['run', 'docs', 'x'], {'HARNESS_MAX_WORKERS': '4'})
        env = run.call_args.kwargs['env']
        self.assertEqual(env['HARNESS_PREFLIGHT'], 'off')
        self.assertEqual(env['HARNESS_HOST'], '')
        self.assertEqual(env['HARNESS_MAX_WORKERS'], '4')

    def test_assert_measures_once_more_before_failing(self):
        with patch.object(bench, 'benchmark', side_effect=[report(1.0), report(1.8)]) as measured, patch.object(bench, 'render', return_value=''):
            self.assertEqual(bench.main(['--assert']), 0)
        self.assertEqual(measured.call_count, 2)

    def test_assert_fails_when_both_measurements_fail(self):
        with patch.object(bench, 'benchmark', side_effect=[report(1.0), report(1.1)]) as measured, patch.object(bench, 'render', return_value=''):
            self.assertEqual(bench.main(['--assert']), 1)
        self.assertEqual(measured.call_count, 2)

    def test_without_assert_measures_once(self):
        with patch.object(bench, 'benchmark', return_value=report(1.0)) as measured, patch.object(bench, 'render', return_value=''):
            self.assertEqual(bench.main([]), 0)
        self.assertEqual(measured.call_count, 1)


if __name__ == '__main__':
    unittest.main()
