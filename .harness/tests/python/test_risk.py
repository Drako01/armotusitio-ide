"""Risk-proportional pipeline: classification table, fail-closed, mandatory controls, budgets, legacy compatibility."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture
from core import risk, routing, config, context


def level(files, task='', domain=None, **kw):
    return risk.classify(files, task, domain, **kw)


class ClassificationTests(unittest.TestCase):
    def test_table(self):
        with fixture():
            table = [
                (['docs/guide.md'], 'actualizar guia', 'docs', 'LOW'),
                (['apps/backoffice/src/app.css'], 'ajustar color', 'backoffice', 'LOW'),
                (['apps/backoffice/src/cart.ts'], 'calcular el total', 'backoffice', 'MEDIUM'),
                (['packages/ui/src/button.tsx'], 'nuevo boton', 'repo', 'MEDIUM'),
                (['apps/api/internal/auth/login.go'], 'cambio', 'backoffice', 'HIGH'),
                (['apps/api/db/migrations/001.sql'], 'cambio', None, 'HIGH'),
                (['docs/openapi.yaml'], 'cambio', None, 'HIGH'),
                (['infra/main.tf'], 'cambio', None, 'HIGH'),
                (['.github/workflows/ci.yml'], 'cambio', None, 'HIGH'),
                (['.harness/core/risk.py'], 'cambio', None, 'HIGH'),
                (['apps/backoffice/src/a.ts'], 'agregar rbac al menu', 'backoffice', 'HIGH'),
            ]
            for files, task, domain, expected in table:
                self.assertEqual(level(files, task, domain)['level'], expected, files)

    def test_visual_across_two_portals_or_with_shared_dependency_is_not_low(self):
        with fixture():
            self.assertEqual(level(['apps/a/x.css', 'apps/b/y.css'], 'color')['level'], 'MEDIUM')
            self.assertEqual(level(['apps/a/x.css'], 'color', dependencies=['packages/ui/index.ts'])['level'], 'MEDIUM')

    def test_fail_closed_on_errors(self):
        with fixture():
            with patch('core.changes.changed_files', side_effect=ValueError('git down')):
                result = risk.classify(None, 'doc', 'docs')
            self.assertEqual(result['level'], 'HIGH')
            self.assertTrue(result['failedClosed'])
            self.assertIn('security-auditor', result['mandatory'])
            with patch.object(risk, 'assess', side_effect=RuntimeError('boom')):
                self.assertEqual(risk.classify(['a.md'])['level'], 'HIGH')

    def test_security_auditor_is_mandatory_on_sensitive_paths_for_any_level(self):
        for lvl in risk.LEVELS:
            self.assertIn('security-auditor', risk.mandatory_for(lvl, sensitive=True))
        self.assertNotIn('security-auditor', risk.mandatory_for('MEDIUM'))
        with fixture():
            for files in (['apps/api/auth/token.go'], ['apps/x/rbac.ts'], ['db/migrations/1.sql'], ['apps/t/tenancy.ts'], ['infra/a.tf'], ['.env.example']):
                self.assertIn('security-auditor', level(files, 'x')['mandatory'], files)

    def test_selection_follows_level_and_never_drops_the_auditor(self):
        with fixture():
            manifests = context.manifests()
            domain = context.get_domain('backoffice')
            def agents(assessed):
                return routing.select_agents(domain, 'ajustar', manifests['agents'], ['apps/backoffice/a.css'], assessed)['agents']
            low = {'level': 'LOW', 'sensitive': False}
            self.assertNotIn('reviewer', agents(low))
            self.assertNotIn('security-auditor', agents(low))
            self.assertIn('reviewer', agents({'level': 'MEDIUM', 'sensitive': False}))
            self.assertNotIn('security-auditor', agents({'level': 'MEDIUM', 'sensitive': False}))
            high = agents({'level': 'HIGH', 'sensitive': True})
            self.assertEqual(high[-4:], ['reviewer', 'security-auditor', 'verifier', 'logger'])
            self.assertIn('security-auditor', agents({'level': 'LOW', 'sensitive': True}))

    def test_legacy_callers_are_unchanged(self):
        with fixture():
            manifests = context.manifests()
            domain = context.get_domain('docs')
            files = ['docs/a.md']
            before = routing.select_agents(domain, 'typo en docs', manifests['agents'], files)
            self.assertEqual(before, routing.select_agents(domain, 'typo en docs', manifests['agents'], files, None))
            self.assertEqual(routing.risk(['docs/a.md'], 'typo en docs', 'docs'), 'LOW')
            self.assertEqual(routing.risk(['apps/x/a.ts'], 'algo', 'backoffice'), 'MEDIUM')
            self.assertEqual(routing.risk([], 'algo de rbac', 'backoffice'), 'HIGH')

    def test_explain_lists_reasons_and_mandatory(self):
        with fixture():
            text = risk.explain(level(['apps/api/auth/x.go'], 'x'))
            self.assertIn('risk HIGH', text)
            self.assertIn('authentication', text)
            self.assertIn('security-auditor', text)

    def test_budgets_table(self):
        with fixture():
            self.assertEqual(risk.budget_for('LOW')['initialWorkers'], 1)
            medium = risk.budget_for('MEDIUM', {'parallel': True, 'width': 3})
            self.assertEqual((medium['class'], medium['workers']['min'], medium['workers']['max'], medium['initialWorkers']), ('medium', 2, 3, 3))
            self.assertEqual(risk.budget_for('MEDIUM')['initialWorkers'], 1)  # a chain cannot use more workers than its width
            high = risk.budget_for('HIGH', {'parallel': True, 'width': 4})
            self.assertEqual((high['class'], high['initialWorkers']), ('critical', 4))
            wide = risk.budget_for('HIGH', {'parallel': True, 'width': 7})
            self.assertEqual((wide['class'], wide['initialWorkers']), ('transversal', 7))
            self.assertLess(risk.budget_for('LOW')['agentTimeoutMs'], risk.budget_for('HIGH')['agentTimeoutMs'])

    def test_preview_exposes_risk_budget_and_estimate_without_changing_selection(self):
        from core import tasks
        with fixture():
            with patch('core.tasks.context', return_value={'changeSet': {'files': ['docs/a.md']}}):
                out = tasks.preview('docs', 'Corregir un typo en docs')[0]
            self.assertEqual(out['risk']['level'], 'LOW')
            self.assertIn('budget', out)
            self.assertIn('estimate', out)
            self.assertNotIn('security-auditor', out['agents'])


if __name__ == '__main__':
    unittest.main()
