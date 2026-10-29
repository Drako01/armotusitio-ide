"""`verify`/`report` CLI contract: flags, exit codes and no execution under --plan; no network, no provider."""
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture, SOURCE
from test_impact import js_fixture, plan_of, write
from core import runner, verification

sys.path.insert(0, str(SOURCE))
import cli


def run_cli(command, *args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli.main(command, list(args))
        except ValueError as error:
            code = 1
            err.write(str(error))
    return code, out.getvalue(), err.getvalue()


def failing(n):
    return [sys.executable, '-B', '-c', f'import sys; print("boom{n}"); sys.exit({n})']


class VerifyCliTests(unittest.TestCase):
    def test_plan_json_and_explain_do_not_execute(self):
        with fixture() as root:
            js_fixture(root)
            with patch.object(verification, 'changed_files', return_value=['packages/x/src/a.ts']), patch.object(runner, 'spawn_run') as spawn:
                code, out, _ = run_cli('verify', '--plan', '--json')
                self.assertEqual(code, 0)
                plan = json.loads(out)
                self.assertFalse(plan['validated'])
                self.assertEqual(plan['checks'][0]['tier'], 'targeted')
                code, text, _ = run_cli('verify', '--plan', '--explain')
                self.assertEqual(code, 0)
                self.assertIn('[targeted] pnpm --filter ./packages/x lint', text)
                self.assertIn('reason:', text)
            spawn.assert_not_called()
            self.assertFalse((root / '.harness/runtime/verify-last.json').exists())

    def test_invalid_flag_combinations_are_rejected(self):
        with fixture():
            for flags in [('--explain',), ('--json',), ('--full', '--fast'), ('--plan', '--fast'), ('--plan', '--keep-going'), ('--bogus',)]:
                code, _, err = run_cli('verify', *flags)
                self.assertEqual(code, 1, flags)
                self.assertTrue(err, flags)

    def test_exit_codes_and_report_ordering(self):
        with fixture() as root:
            ok = [sys.executable, '-B', '-c', 'pass']
            cases = [('PASS', 0, plan_of(ok)), ('FAIL', 1, plan_of(failing(2), failing(3))),
                     ('PARTIAL', 3, plan_of(ok, ok + ['#2']))]
            cases[2][2]['checks'][1]['requires'] = ['docker']
            for status, exit_code, plan in cases:
                with patch.object(verification, 'verify_plan', return_value=plan), \
                        patch.object(verification.shutil, 'which', side_effect=lambda n: None if n == 'docker' else '/bin/' + n):
                    code, out, _ = run_cli('verify', '--keep-going')
                self.assertEqual(code, exit_code, status)
                self.assertIn(f'Verification {status}', out)
                saved = json.loads((root / '.harness/runtime/verify-last.json').read_text())
                self.assertEqual(saved['status'], status)
                code, report, _ = run_cli('report')
                self.assertEqual(code, exit_code, status)
                self.assertIn(f'Verification {status}', report)

    def test_keep_going_through_cli_records_both_failures(self):
        with fixture() as root:
            plan = plan_of(failing(2), failing(3))
            with patch.object(verification, 'verify_plan', return_value=plan):
                code, out, _ = run_cli('verify', '--keep-going')
            self.assertEqual(code, 1)
            saved = json.loads((root / '.harness/runtime/verify-last.json').read_text())
            self.assertEqual([c['status'] for c in saved['checks']], ['FAIL', 'FAIL'])
            self.assertTrue(all({'command', 'tier', 'reason', 'status', 'exit', 'durationMs', 'log', 'stdoutTail', 'stderrTail'} <= set(c) for c in saved['checks']))

    def test_report_without_summary_fails(self):
        with fixture():
            code, _, err = run_cli('report')
            self.assertEqual(code, 1)
            self.assertIn('No verification summary', err)

    def test_full_fast_is_rejected_before_planning(self):
        with fixture():
            with patch.object(verification, 'verify_plan') as plan:
                code, _, err = run_cli('verify', '--full', '--fast')
            self.assertEqual(code, 1)
            self.assertIn('--full', err)
            plan.assert_not_called()

    def test_fast_without_targeted_checks_is_empty_and_exits_non_zero(self):
        with fixture() as root:
            plan = plan_of([sys.executable, '-B', '-c', 'pass'])
            plan['checks'][0]['tier'] = 'authoritative'
            with patch.object(verification, 'verify_plan', return_value=plan):
                code, out, _ = run_cli('verify', '--fast')
            self.assertEqual(code, verification.EXIT['EMPTY'])
            self.assertNotEqual(code, 0)
            self.assertIn('Verification EMPTY', out)
            self.assertIn('none was executed', out)
            self.assertEqual(json.loads((root / '.harness/runtime/verify-last.json').read_text())['status'], 'EMPTY')

    def test_report_is_non_zero_for_stale_or_non_authoritative_results(self):
        with fixture() as root:
            ok = plan_of([sys.executable, '-B', '-c', 'pass'])
            with patch.object(verification, 'verify_plan', return_value=ok):
                self.assertEqual(run_cli('verify')[0], 0)
            self.assertEqual(run_cli('report')[0], 0)
            (root / 'changed.txt').write_text('x')
            with patch.object(verification, 'fingerprint', return_value={'head': 'other', 'changeSet': None}):
                code, out, _ = run_cli('report')
            self.assertEqual(code, verification.EXIT['STALE'])
            self.assertIn('STALE: HEAD changed', out)
            with patch.object(verification, 'verify_plan', return_value=ok):
                self.assertEqual(run_cli('verify', '--fast')[0], 0)  # fast PASS stays exit 0 for `verify` (documented)
            code, out, _ = run_cli('report')
            self.assertEqual(code, verification.EXIT['FAST'])
            self.assertIn('authoritative=False', out)

    def test_context_and_tokens_without_domain_never_run_go_list(self):
        with fixture() as root:
            js_fixture(root)
            write(root, 'apps/api/internal/a/a.go')
            from core import impact
            with patch.object(verification, 'changed_files', return_value=['apps/api/internal/a/a.go']), \
                    patch.object(impact, 'go_list_json', side_effect=AssertionError('go list must not run')) as go_list:
                for command in ['context', 'tokens']:
                    code, out, _ = run_cli(command)
                    self.assertEqual(code, 0, command)
                    self.assertEqual(json.loads(out)['domain'], 'api')
            go_list.assert_not_called()

    def test_tail_is_redacted_in_summary(self):
        with fixture():
            secret = [sys.executable, '-B', '-c', 'import sys; print("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"); sys.exit(1)']
            summary = verification.run_plan(plan_of(secret), 20000)
            self.assertNotIn('ghp_', summary['checks'][0]['stdoutTail'])
            self.assertIn('[REDACTED]', summary['checks'][0]['stdoutTail'])


if __name__ == '__main__':
    unittest.main()
