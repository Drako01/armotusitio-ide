"""Flaky registry: classification, parsing per runner, guarded quarantine, expiry and rehabilitation (temp dirs only)."""
import contextlib
import io
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from core import config, flaky


class FlakyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.object(config, 'H', Path(self.tmp.name) / '.harness')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.settings = {}
        patch.object(flaky, 'settings', lambda: self.settings).start()
        self.addCleanup(patch.stopall)

    def test_test_id_is_stable(self):
        self.assertEqual(flaky.test_id('tests\\a.py', ' test_x '), 'tests/a.py::test_x')
        self.assertEqual(flaky.test_id('  A  b '), 'A b')

    def test_critical_never_quarantined(self):
        for name in ('tests/tenant_isolation_test.go::TestX', 'test_rbac_denies', 'migration_roundtrip', 'auth_login'):
            self.assertTrue(flaky.is_critical(name))
            with self.assertRaises(ValueError):
                flaky.quarantine(name, 'ana')
            self.assertFalse(flaky.is_quarantined(name))
        self.assertFalse(flaky.is_critical('test_render_button'))

    def test_critical_always_blocks_even_if_registry_says_quarantined(self):
        flaky.quarantine('test_button', 'ana')
        tests = flaky.load()
        tests['test_auth_login'] = {**flaky.fresh('test_auth_login'), 'quarantine': dict(tests['test_button']['quarantine'])}
        flaky.save(tests)
        self.assertEqual(flaky.blocking_failures(['test_button', 'test_auth_login']), ['test_auth_login'])

    def test_owner_required_and_days_bounds(self):
        with self.assertRaises(ValueError):
            flaky.quarantine('test_x', ' ')
        with self.assertRaises(ValueError):
            flaky.quarantine('test_x', 'ana', days=0)
        self.assertEqual(flaky.quarantine('test_x', 'ana', 7, 'flaky')['quarantine']['state'], 'quarantined')
        self.assertTrue(flaky.is_quarantined('test_x'))

    def test_expiry_and_release(self):
        flaky.quarantine('test_x', 'ana', 3)
        tests = flaky.load()
        tests['test_x']['quarantine']['expiresAt'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        flaky.save(tests)
        self.assertFalse(flaky.is_quarantined('test_x'))
        self.assertEqual(flaky.blocking_failures(['test_x']), ['test_x'])
        flaky.quarantine('test_y', 'ana')
        self.assertTrue(flaky.release('test_y'))
        self.assertFalse(flaky.is_quarantined('test_y'))
        self.assertFalse(flaky.release('unknown'))

    def test_auto_rehabilitation_after_consecutive_passes(self):
        self.settings = {'rehabilitationPasses': 3}
        flaky.quarantine('test_x', 'ana')
        flaky.record_result('test_x', 'pass')
        flaky.record_result('test_x', 'pass')
        flaky.record_result('test_x', 'fail', output='boom')  # resets the streak
        for _ in range(2):
            flaky.record_result('test_x', 'pass')
        self.assertTrue(flaky.is_quarantined('test_x'))
        record = flaky.record_result('test_x', 'pass')
        self.assertEqual(record['quarantine']['state'], 'released')
        self.assertFalse(flaky.is_quarantined('test_x'))

    def test_candidate_proposal_and_optional_auto_quarantine(self):
        for _ in range(3):
            flaky.record_result('test_x', 'pass', retries=1)
        flaky.record_result('test_x', 'pass')
        record = flaky.load()['test_x']
        self.assertEqual(record['quarantine']['state'], 'candidate')
        self.assertGreaterEqual(record['failureRate'], 0.2)
        self.assertFalse(flaky.is_quarantined('test_x'))  # a proposal never hides anything
        self.settings = {'autoQuarantine': True, 'owner': 'ci-team'}
        for _ in range(2):
            flaky.record_result('test_z', 'pass', retries=1)
        self.assertTrue(flaky.is_quarantined('test_z'))
        for _ in range(2):
            flaky.record_result('test_auth_z', 'pass', retries=1)
        self.assertFalse(flaky.is_quarantined('test_auth_z'))
        self.assertIsNone(flaky.load()['test_auth_z']['quarantine'])

    def test_infrastructure_failures_do_not_count_against_test(self):
        for _ in range(5):
            flaky.record_result('test_x', 'fail', output='connect ECONNRESET', retries=1)
        record = flaky.load()['test_x']
        self.assertEqual(record['failureRate'], 0.0)
        self.assertIsNone(record['quarantine'])

    def test_classification(self):
        self.assertEqual(flaky.classify_failure('Error: connect ECONNRESET 127.0.0.1'), 'infrastructure')
        self.assertEqual(flaky.classify_failure('listen EADDRINUSE :3000'), 'infrastructure')
        self.assertEqual(flaky.classify_failure('Cannot connect to the Docker daemon at unix:///x'), 'infrastructure')
        self.assertEqual(flaky.classify_failure('ENOSPC: no space left'), 'infrastructure')
        self.assertEqual(flaky.classify_failure('AssertionError'), 'reproducible')
        self.assertEqual(flaky.classify_failure('AssertionError', ['pass', 'fail']), 'intermittent')
        self.assertEqual(flaky.classify_failure('AssertionError', [{'status': 'fail'}, {'status': 'fail'}]), 'reproducible')

    def test_history_is_capped_and_redacted(self):
        for _ in range(60):
            flaky.record_result('test_x', 'fail', output='password=hunter2hunter2 failed')
        record = flaky.load()['test_x']
        self.assertEqual(len(record['history']), 50)
        self.assertNotIn('hunter2', record['lastFailure']['tail'])

    def test_parse_failures_per_runner(self):
        unittest_out = 'FAIL: test_a (tests.test_mod.Case.test_a)\nERROR: test_b (tests.test_mod.Case.test_b)\nOK'
        self.assertEqual(flaky.parse_failures(unittest_out), ['tests.test_mod.Case.test_a', 'tests.test_mod.Case.test_b'])
        node_out = '✔ ok one (1ms)\n✖ breaks badly (2.5ms)\n✖ failing tests:\n✖ breaks badly (2.5ms)'
        self.assertEqual(flaky.parse_failures(node_out), ['breaks badly'])
        self.assertEqual(flaky.parse_failures('--- FAIL: TestX (0.00s)\n    --- FAIL: TestX/sub (0.00s)\nFAIL\nFAIL\tpkg\t0.1s'),
                         ['TestX', 'TestX/sub'])
        jest_out = 'PASS src/ok.test.ts\nFAIL src/a.test.ts\n FAIL  src\\b.test.ts > suite > case\n'
        self.assertEqual(flaky.parse_failures(jest_out), ['src/a.test.ts', 'src/b.test.ts > suite > case'])
        self.assertEqual(flaky.parse_failures('all good'), [])

    def test_analyze_gate_output(self):
        flaky.quarantine('tests.m.C.test_flaky', 'ana')
        output = 'FAIL: test_flaky (tests.m.C.test_flaky)'
        result = flaky.analyze_gate_output(output)
        self.assertTrue(result['all_quarantined'])
        self.assertEqual((result['quarantined'], result['blocking']), (['tests.m.C.test_flaky'], []))
        mixed = flaky.analyze_gate_output(output + '\nFAIL: test_other (tests.m.C.test_other)', retried_passed=True)
        self.assertFalse(mixed['all_quarantined'])
        self.assertEqual(mixed['blocking'], ['tests.m.C.test_other'])
        self.assertEqual(mixed['category'], 'intermittent')
        self.assertFalse(flaky.analyze_gate_output('no failures here')['all_quarantined'])
        critical = flaky.analyze_gate_output('FAIL: test_auth_x (tests.m.C.test_auth_x)')
        self.assertEqual(critical['blocking'], ['tests.m.C.test_auth_x'])

    def test_thread_safe_registry(self):
        def work(n):
            for _ in range(5):
                flaky.record_result(f'test_{n}', 'pass')
        threads = [threading.Thread(target=work, args=(n,)) for n in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        tests = flaky.load()
        self.assertEqual(len(tests), 6)
        self.assertTrue(all(len(r['history']) == 5 for r in tests.values()))

    def test_corrupt_registry_is_empty(self):
        flaky.registry_file().parent.mkdir(parents=True, exist_ok=True)
        flaky.registry_file().write_text('{not json', encoding='utf-8')
        self.assertEqual(flaky.load(), {})
        flaky.record_result('test_x', 'pass')
        self.assertIn('test_x', flaky.load())

    def test_cli(self):
        def run(*args):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = flaky.main(list(args))
            return code, out.getvalue()
        self.assertEqual(run()[0], 0)
        self.assertIn('quarantined', run('quarantine', 'test_x', '--owner', 'ana', '--days', '5', '--reason', 'r')[1])
        self.assertIn('1 quarantined', run('list')[1])
        self.assertIn('"tests"', run('list', '--json')[1])
        self.assertIn('test_x', run('show', 'test_x')[1])
        self.assertEqual(run('release', 'test_x')[1].strip(), 'released')
        with self.assertRaises(config.UsageError):
            run('quarantine', 'test_auth_x', '--owner', 'ana')
        with self.assertRaises(config.UsageError):
            run('quarantine', 'test_y')
        with self.assertRaises(config.UsageError):
            run('show', 'missing')


if __name__ == '__main__':
    unittest.main()
