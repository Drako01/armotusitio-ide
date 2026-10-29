"""Duration estimate: fallbacks, history, confidence levels and the disproportion warning."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture
from core import estimate

DAG = [{'id': 'context-manager', 'agent': 'context-manager', 'dependsOn': []},
       {'id': 'backend', 'agent': 'backend', 'dependsOn': ['context-manager']},
       {'id': 'reviewer', 'agent': 'reviewer', 'dependsOn': ['backend']},
       {'id': 'verifier', 'agent': 'verifier', 'dependsOn': ['reviewer']},
       {'id': 'logger', 'agent': 'logger', 'dependsOn': ['verifier']}]


def history(count, median=60000, p90=120000):
    """Patch the estimate's telemetry reader (works whether or not core.telemetry exists yet)."""
    def summarize(kind, key):
        return {'count': count, 'medianMs': median, 'p90Ms': p90, 'lastMs': median} if count else {'count': 0}
    fake = type(sys)('telemetry')
    fake.summarize = summarize
    return patch.dict(sys.modules, {'core.telemetry': fake}), patch('core.telemetry', fake, create=True)


class Hist:
    def __init__(self, *args, **kw):
        self.patches = history(*args, **kw)

    def __enter__(self):
        for p in self.patches:
            p.__enter__()

    def __exit__(self, *exc):
        for p in reversed(self.patches):
            p.__exit__(*exc)


class EstimateTests(unittest.TestCase):
    def test_without_history_uses_conservative_fallbacks(self):
        with fixture(), Hist(0):
            out = estimate.estimate(None, DAG, [['pnpm', 'lint']], {'level': 'MEDIUM', 'files': ['a.ts']}, 1)
            self.assertEqual(out['confidence'], 'low')
            self.assertEqual(out['perPhase']['code'], 900000)
            self.assertEqual(out['perPhase']['review'], 300000)
            self.assertEqual(out['perPhase']['verify'], 120000)
            self.assertEqual(out['plannedGates'], ['pnpm lint'])
            self.assertEqual(out['totalMs'], sum(out['perPhase'].values()))
            self.assertEqual(out['effectiveParallelism'], 1)

    def test_missing_telemetry_module_is_no_history(self):
        with fixture(), patch.dict(sys.modules, {'core.telemetry': None}):
            out = estimate.estimate(None, DAG, [], 'HIGH', 2)
            self.assertEqual(out['confidence'], 'low')
            self.assertEqual(out['risk'], 'HIGH')

    def test_history_p90_then_median_and_confidence_levels(self):
        with fixture():
            for count, confidence, code in ((3, 'low', 120000), (5, 'medium', 120000), (12, 'medium', 60000), (25, 'high', 60000)):
                with Hist(count):
                    out = estimate.estimate(None, DAG, [], {'level': 'MEDIUM'}, 1)
                    self.assertEqual(out['confidence'], confidence, count)
                    self.assertEqual(out['perPhase']['code'], code, count)

    def test_parallelism_never_beats_the_longest_node(self):
        dag = [{'id': 'context-manager', 'agent': 'context-manager', 'dependsOn': []}] + \
              [{'id': f'u{i}', 'agent': 'backend', 'dependsOn': ['context-manager']} for i in range(3)]
        with fixture(), Hist(25, 60000):
            serial = estimate.estimate(None, dag, [], {'level': 'MEDIUM'}, 1)
            wide = estimate.estimate(None, dag, [], {'level': 'MEDIUM'}, 8)
            self.assertEqual(serial['perPhase']['code'], 180000)
            self.assertEqual(wide['effectiveParallelism'], 3)
            self.assertEqual(wide['perPhase']['code'], 60000)

    def test_disproportion_warning_keeps_mandatory_verifications(self):
        with fixture(), Hist(25, 900000):
            out = estimate.estimate(None, DAG, [['pnpm', 'test']], {'level': 'LOW', 'files': ['a.css']}, 1)
            self.assertEqual(out['warnings'][0]['code'], 'disproportion')
            self.assertIn('Mandatory verifications are kept', out['warnings'][0]['message'])
            self.assertEqual(out['plannedGates'], ['pnpm test'])
            big = estimate.estimate(None, DAG, [], {'level': 'LOW', 'files': [f'f{i}.css' for i in range(9)]}, 1)
            self.assertNotIn('warnings', big)
            mid = estimate.estimate(None, DAG, [], {'level': 'HIGH', 'files': ['a.css']}, 1)
            self.assertNotIn('warnings', mid)


if __name__ == '__main__':
    unittest.main()
