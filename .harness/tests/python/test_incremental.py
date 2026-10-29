"""Incremental verification: impact-based selection, automatic full escalation, fail-closed, SKIPPED_NOT_IMPACTED semantics."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture
from test_impact import js_fixture, plan_of
from core import config, impact, verification
from core.config import UsageError

OK = [sys.executable, '-B', '-c', 'pass']


def commands(plan, key='checks'):
    return [verification.argv(c) for c in plan.get(key, [])]


def incremental(files, **kwargs):
    with patch.object(impact, 'go_list_json', side_effect=ValueError('hermetic: go list is never run')):
        return verification.verify_plan(files=files, incremental=True, **kwargs)


class SelectionTests(unittest.TestCase):
    def test_small_change_is_incremental_and_lists_what_it_did_not_run(self):
        with fixture() as root:
            js_fixture(root)
            plan = incremental(['docs/guide.md'])
            self.assertFalse(plan['full'])
            self.assertEqual(plan['domains'], ['docs'])
            self.assertEqual(plan['incremental']['mode'], 'incremental')
            self.assertIn(['pnpm', 'format:check'], commands(plan))
            skipped = commands(plan, 'notImpacted')
            self.assertTrue(skipped)
            self.assertNotIn(['pnpm', 'format:check'], skipped)  # selected gates are never also "not impacted"
            self.assertIn(['bash', './verify-enterprise.sh', '--quick'], skipped)

    def test_medium_change_selects_workspace_checks_and_dependents(self):
        with fixture() as root:
            js_fixture(root)
            plan = incremental(['packages/x/src/a.ts'])
            self.assertFalse(plan['full'])
            selected = commands(plan)
            self.assertIn(['pnpm', '--filter', './packages/x', 'lint'], selected)
            self.assertIn(['pnpm', '--filter', './apps/y', 'typecheck'], selected)  # transitive dependent
            self.assertNotIn(['pnpm', '--filter', './apps/z', 'lint'], selected)

    def test_mandatory_security_controls_are_never_listed_as_skippable(self):
        with fixture() as root:
            js_fixture(root)
            for files in (['docs/guide.md'], ['packages/x/src/a.ts']):
                skipped = commands(incremental(files), 'notImpacted')
                self.assertNotIn(['bash', './verify-enterprise.sh', '--security'], skipped)
                self.assertNotIn(['bash', './verify-enterprise.sh', '--full'], skipped)

    def test_default_path_is_incremental_only_when_detecting_changes(self):
        with fixture() as root:
            js_fixture(root)
            with patch.object(verification, 'changed_files', return_value=['.github/workflows/ci.yml']):
                self.assertTrue(verification.verify_plan()['full'])  # detection here => incremental by default
            self.assertFalse(verification.verify_plan(files=['.github/workflows/ci.yml']).get('full'))  # explicit files keep the old contract

    def test_named_domain_is_a_scoped_request_not_an_impact_claim(self):
        with fixture() as root:
            js_fixture(root)
            plan = verification.verify_plan('docs', files=['docs/guide.md'], incremental=True)
            self.assertFalse(plan['full'])
            self.assertNotIn('notImpacted', plan)


class EscalationTests(unittest.TestCase):
    def test_cross_cutting_changes_escalate_to_full(self):
        with fixture() as root:
            js_fixture(root)
            for file in ['.github/workflows/ci.yml', 'pnpm-lock.yaml', 'package.json', 'verify-enterprise.sh', '.harness/core/impact.py',
                         'infra/docker/compose.yml', 'apps/api/migrations/001.sql', 'docs/api/openapi.yaml', 'apps/api/internal/auth/token.go',
                         'apps/api/internal/rbac/policy.go', 'apps/api/internal/tenancy/scope.go', 'packages/typescript-config/base.json']:
                plan = incremental([file])
                self.assertTrue(plan['full'], file)
                self.assertTrue(plan['incremental']['escalated'], file)
                self.assertIn(['bash', './verify-enterprise.sh', '--full'], commands(plan), file)
                self.assertIn(file.split('/')[-1] if '/' not in file else file, plan['incremental']['reason'], file)

    def test_harness_operational_state_never_escalates(self):
        with fixture() as root:
            js_fixture(root)
            plan = incremental(['.harness/state/x.json', 'docs/guide.md'])
            self.assertFalse(plan['full'])

    def test_explicit_full_stays_available_and_says_so(self):
        with fixture():
            plan = verification.verify_plan(full=True, files=['docs/guide.md'])
            self.assertTrue(plan['full'])
            self.assertEqual(plan['incremental']['reason'], 'explicit --full')
            self.assertFalse(plan['incremental']['escalated'])

    def test_declared_high_risk_never_reduces_gates(self):
        with fixture() as root:
            js_fixture(root)
            self.assertFalse(incremental(['docs/guide.md'], risk='LOW')['full'])
            plan = incremental(['docs/guide.md'], risk='high')
            self.assertTrue(plan['full'])
            self.assertIn('HIGH', plan['incremental']['reason'])
            self.assertEqual(incremental(['docs/guide.md'], risk='nonsense').get('declaredRisk'), None)


class FailClosedTests(unittest.TestCase):
    def test_file_owned_by_no_domain_is_ambiguous_and_widens(self):
        with fixture() as root:
            js_fixture(root)
            plan = incremental(['mystery/dir/file.bin'])
            self.assertTrue(plan['full'])
            self.assertTrue(plan['incremental']['failClosed'])
            self.assertIn('no declared domain', plan['incremental']['reason'])

    def test_failure_in_impact_analysis_verifies_everything_with_the_reason(self):
        with fixture() as root:
            js_fixture(root)
            with patch.object(impact, 'targeted_checks', side_effect=OSError('disk on fire')):
                plan = verification.verify_plan(files=['docs/guide.md', 'packages/x/src/a.ts'], incremental=True)
            self.assertTrue(plan['full'])
            self.assertTrue(plan['incremental']['failClosed'])
            self.assertIn('disk on fire', plan['incremental']['reason'])

    def test_analyze_never_raises(self):
        with patch.object(impact, 'escalation', side_effect=RuntimeError('bug')):
            verdict = impact.analyze(['a.ts'])
        self.assertTrue(verdict['full'] and verdict['failClosed'])

    def test_change_detection_failure_is_full_but_usage_errors_still_raise(self):
        with fixture():
            with patch.object(verification, 'changed_files', side_effect=ValueError('Git query failed: diff')):
                plan = verification.verify_plan()
                self.assertTrue(plan['full'] and plan['incremental']['failClosed'])
                with self.assertRaises(ValueError):
                    verification.verify_plan(incremental=False)
            with patch.object(verification, 'changed_files', side_effect=UsageError('bad ref')):
                with self.assertRaises(UsageError):
                    verification.verify_plan()


class NotImpactedStatusTests(unittest.TestCase):
    def plan(self):
        skipped = [verification.authoritative(['bash', './verify-enterprise.sh', '--quick'], 'declared gate of domain api; no changed file reaches it')]
        return {**plan_of(OK), 'notImpacted': skipped, 'incremental': {'mode': 'incremental', 'escalated': False, 'failClosed': False, 'reason': None}}

    def test_not_impacted_is_neither_pass_nor_partial_nor_failure(self):
        with fixture() as root:
            with patch.object(verification, 'spawn_run', create=True):
                summary = verification.run_plan(self.plan(), 20000)
            self.assertEqual(summary['status'], 'PASS')
            self.assertEqual(verification.EXIT[summary['status']], 0)
            self.assertEqual(len(summary['checks']), 1)  # not impacted gates are not results of checks that ran
            self.assertEqual(summary['notImpacted'][0]['status'], 'SKIPPED_NOT_IMPACTED')
            self.assertEqual(sum(1 for c in summary['checks'] if c['status'] == 'PASS'), 1)  # never counted as pass
            json.dumps(summary)
            self.assertIn('INCREMENTAL', summary['notice'])
            saved = json.loads((root / '.harness/runtime/verify-last.json').read_text())
            self.assertEqual(saved['notImpacted'][0]['status'], verification.NOT_IMPACTED)

    def test_report_lists_them_apart_from_passed(self):
        with fixture():
            summary = verification.run_plan(self.plan(), 20000)
            report = verification.render_report(summary)
            self.assertIn('Not impacted (1', report)
            self.assertIn('SKIPPED_NOT_IMPACTED', report)
            self.assertLess(report.index('Not impacted'), report.index('Passed'))
            passed_block = report[report.index('Passed'):]
            self.assertNotIn('verify-enterprise.sh --quick', passed_block)

    def test_failure_with_not_impacted_still_fails(self):
        with fixture():
            plan = self.plan()
            plan['checks'] = plan_of([sys.executable, '-B', '-c', 'raise SystemExit(1)'])['checks']
            self.assertEqual(verification.run_plan(plan, 20000)['status'], 'FAIL')

    def test_render_plan_shows_escalation_and_skipped(self):
        with fixture() as root:
            js_fixture(root)
            text = verification.render_plan(incremental(['docs/guide.md']))
            self.assertIn('[SKIPPED_NOT_IMPACTED]', text)
            self.assertIn('ESCALATED', verification.render_plan(incremental(['pnpm-lock.yaml'])))


if __name__ == '__main__':
    unittest.main()
