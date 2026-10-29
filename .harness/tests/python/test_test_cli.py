"""Harness suite scheduling regression: subprocess-heavy Node fixtures must not compete."""
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SOURCE))
import cli
from core import runner


class TestCliTests(unittest.TestCase):
    def test_python_failure_stops_before_node_suite(self):
        with patch('subprocess.call', return_value=7), patch.object(runner, 'spawn_run') as node:
            self.assertEqual(cli.main('test', []), 7)
        node.assert_not_called()

    def test_node_files_execute_without_overlapping_fixtures(self):
        with tempfile.TemporaryDirectory(prefix='harness-suite-') as directory:
            root = Path(directory)
            tests = root / '.harness/tests'
            tests.mkdir(parents=True)
            # A shared exclusive resource makes file-level scheduling observable. Both
            # files must execute; concurrency causes EEXIST rather than a timing assertion.
            source = '''import test from "node:test";
import { mkdirSync, rmSync, appendFileSync } from "node:fs";
test("exclusive fixture", async () => {
  mkdirSync("fixture-lock");
  try {
    appendFileSync("executed", "x");
    await new Promise(resolve => setTimeout(resolve, 5000));
  } finally { rmSync("fixture-lock", { recursive: true }); }
});
'''
            # Named to land in the timing-sensitive (serial) bucket cli.py now schedules at
            # concurrency=1; this fixture's whole point is verifying no overlap, which only
            # that bucket still guarantees after the harness:test parallel/serial split.
            for name in ['lifecycle', 'parallel']:
                (tests / (name + '.test.mjs')).write_text(source, encoding='utf-8')
            out = io.StringIO()
            with patch.object(cli, 'H', root / '.harness'), \
                    patch.object(runner, 'ROOT', root), patch.object(runner, 'H', root / '.harness'), \
                    patch('subprocess.call', return_value=0), contextlib.redirect_stdout(out):
                code = cli.main('test', [])
            self.assertEqual(code, 0, out.getvalue())
            self.assertEqual((root / 'executed').read_text(), 'xx')


if __name__ == '__main__':
    unittest.main()
