"""Telemetry: append-only log, rotation, corruption tolerance, redaction, thread-safety and reports (temp dirs only)."""
import contextlib
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from core import config, telemetry


class TelemetryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.object(config, 'H', Path(self.tmp.name) / '.harness')
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_record_and_history_filter_by_key(self):
        telemetry.record('gate', key='lint', durationMs=100, status='PASS')
        telemetry.record('gate', key='build', durationMs=900)
        telemetry.record('task', durationMs=5)
        self.assertEqual([e['key'] for e in telemetry.history('gate')], ['lint', 'build'])
        self.assertEqual(len(telemetry.history('gate', 'lint')), 1)
        self.assertEqual(len(telemetry.history('gate', limit=1)), 1)
        self.assertIn('ts', telemetry.history('task')[0])

    def test_record_never_raises(self):
        with patch.object(telemetry, 'log_file', side_effect=OSError('disk')):
            telemetry.record('gate', key='x')
        telemetry.record('gate', weird=object(), nested={'a': [1, 2]})
        self.assertEqual(len(telemetry.history('gate')), 1)

    def test_redaction_and_no_free_text(self):
        telemetry.record('failure', category='x', prompt='secret prompt', output='raw', note='token=abc12345 ' + 'y' * 500,
                         api_key='hunter2hunter2')
        event = telemetry.history('failure')[0]
        self.assertNotIn('prompt', event)
        self.assertNotIn('output', event)
        self.assertNotIn('abc12345', json.dumps(event))
        self.assertNotIn('hunter2', json.dumps(event))
        self.assertLessEqual(len(event['note']), 215)

    def test_corrupt_lines_are_skipped(self):
        telemetry.record('gate', key='a', durationMs=1)
        with telemetry.log_file().open('a', encoding='utf-8') as stream:
            stream.write('{broken\n[1,2]\n{"noKind":1}\n\n')
        telemetry.record('gate', key='b', durationMs=2)
        self.assertEqual([e['key'] for e in telemetry.history('gate')], ['a', 'b'])
        self.assertEqual(telemetry.report()['gates'], 2)

    def test_rotation_keeps_one_old_file(self):
        with patch.object(telemetry, 'ROTATE_BYTES', 300):
            for index in range(40):
                telemetry.record('gate', key=f'g{index}', durationMs=index)
        file = telemetry.log_file()
        self.assertTrue(file.with_name(file.name + '.1').exists())
        self.assertFalse(file.with_name(file.name + '.2').exists())
        self.assertEqual(telemetry.history('gate', limit=0)[-1]['key'], 'g39')

    def test_thread_safety(self):
        def work(n):
            for i in range(25):
                telemetry.record('worker', key=f't{n}', durationMs=i)
        threads = [threading.Thread(target=work, args=(n,)) for n in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(len(telemetry.history('worker', limit=0)), 200)

    def test_summarize_percentiles(self):
        self.assertEqual(telemetry.summarize('gate', 'none'), {'count': 0, 'medianMs': None, 'p90Ms': None, 'lastMs': None})
        for value in range(1, 11):
            telemetry.record('gate', key='g', durationMs=value * 100)
        self.assertEqual(telemetry.summarize('gate', 'g'), {'count': 10, 'medianMs': 500, 'p90Ms': 900, 'lastMs': 1000})
        self.assertIsNone(telemetry.percentile_or_none([], 90))

    def test_report_totals_trend_and_render(self):
        telemetry.record('task', status='completed')
        telemetry.record('gate', key='slow', durationMs=9000)
        telemetry.record('gate', key='fast', durationMs=10)
        telemetry.record('phase', key='verify', durationMs=500)
        telemetry.record('cache', key='k', result='hit')
        telemetry.record('cache', key='k', hit=False)
        telemetry.record('retry', key='k')
        telemetry.record('resume')
        telemetry.record('failure', category='infrastructure')
        telemetry.record('concurrency', value=2)
        telemetry.record('concurrency', value=4)
        telemetry.record('saved', ms=2500)
        data = telemetry.report(trend=True)
        self.assertEqual((data['tasks'], data['gates'], data['retries'], data['resumes']), (1, 2, 1, 1))
        self.assertEqual(data['cache']['hitRate'], 0.5)
        self.assertEqual(data['failures'], {'infrastructure': 1})
        self.assertEqual(data['effectiveConcurrency'], 3.0)
        self.assertEqual(data['estimatedSavedMs'], 2500)
        self.assertEqual(data['bottlenecks']['gates'][0]['key'], 'slow')
        self.assertEqual(len(data['trend']), 1)
        self.assertIn('slowest gates', telemetry.render(data))

    def test_main_modes(self):
        telemetry.record('gate', key='g', durationMs=10)
        for args in ([], ['--json'], ['--trend'], ['--bottlenecks'], ['--bottlenecks', '--json']):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(telemetry.main(args), 0)
            self.assertTrue(out.getvalue())
        with self.assertRaises(config.UsageError):
            telemetry.main(['--nope'])


if __name__ == '__main__':
    unittest.main()
