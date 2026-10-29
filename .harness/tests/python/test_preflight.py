"""harness:preflight: question rules, warnings, receipts, trivial/off exemptions and guarded orphan cleanup. Isolated state."""
import contextlib
import io
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture
from test_progress import make_task, make_lock
from core import config, envcheck, preflight, worktree

CLEAR = ('Agregar el endpoint de listado de prospectos en `apps/api/internal/prospects/handler.go`.\n'
         'Criterio de aceptación: responde 200 con paginación y los tests del handler pasan.\n' + 'Detalle de contexto. ' * 20)
BIG_UNITS = ('Implementar la gestión de prospectos.\nCriterio de aceptación: tests verdes.\n'
             'unit: api-a | owns=apps/api/internal/a/**\nunit: api-b | owns=apps/api/internal/b/**\n' + 'x' * 400)


@contextlib.contextmanager
def preflight_fixture(**env):
    with fixture() as root:
        with contextlib.ExitStack() as stack:
            for module in (preflight, worktree):
                stack.enter_context(patch.object(module, 'ROOT', root))
                stack.enter_context(patch.object(module, 'H', root / '.harness'))
            stack.enter_context(patch.object(preflight, 'dirty_files', return_value=[]))
            stack.enter_context(patch.dict(os.environ, {'REDEVENT_E2E_DSN': '', 'HARNESS_MAX_WORKERS': '', 'HARNESS_ALLOW_HOST_WRITES': '',
                                                         'HARNESS_PREFLIGHT': '', 'HARNESS_PREFLIGHT_CHECKS': 'off', **env}))
            yield root


def ids(items):
    return [i['id'] for i in items]


def registry(root, identity, name=None):
    name = name or identity + '-n-1-abcdef'
    config.write_json(root / '.harness/runtime/worktrees' / (name + '.json'),
                      {'name': name, 'task': identity, 'node': 'n', 'attempt': 1, 'runId': 'abcdef000000', 'state': 'created', 'path': str(root / 'wt' / name)})
    return name


class QuestionRuleTests(unittest.TestCase):
    def questions(self, text, domain='api'):
        with preflight_fixture():
            return preflight.run(domain, text)['questions']

    def test_clear_spec_has_no_questions_and_is_ready(self):
        with preflight_fixture():
            result = preflight.run('api', CLEAR)
            self.assertEqual(result['questions'], [])
            self.assertTrue(result['ready'])
            self.assertEqual(result['recommendedWorkers'], 1)
            self.assertTrue((Path(config.ROOT) / result['receipt']).exists() or (preflight.ROOT / result['receipt']).exists())

    def test_large_without_units(self):
        self.assertIn('large-without-units', ids(self.questions(CLEAR + 'a' * 3100)))
        bullets = '\n'.join(f'- Crear `apps/api/internal/m{i}/x.go` con criterio de aceptación' for i in range(3))
        self.assertIn('large-without-units', ids(self.questions(bullets)))
        self.assertNotIn('large-without-units', ids(self.questions(BIG_UNITS)))

    def test_unit_without_owns(self):
        text = 'Criterio de aceptación: ok\nunit: solo\n' + 'x' * 400
        self.assertIn('unit-without-owns-solo', ids(self.questions(text)))

    def test_owns_outside_domain(self):
        text = 'Criterio de aceptación: ok\nunit: fuera | owns=apps/marketplace/**\n' + 'x' * 400
        self.assertIn('owns-outside-domain-fuera', ids(self.questions(text)))
        self.assertNotIn('owns-outside-domain-api-a', ids(self.questions(BIG_UNITS)))

    def test_e2e_requires_dedicated_database(self):
        self.assertIn('e2e-database', ids(self.questions(CLEAR + '\nCorrer pruebas e2e contra PostgreSQL.')))
        self.assertNotIn('e2e-database', ids(self.questions(CLEAR + '\nCorrer pruebas e2e contra la base redevent_e2e.')))

    def test_migration_requires_reserved_number(self):
        self.assertIn('migration-number', ids(self.questions(CLEAR + '\nIncluye una migración para la tabla.')))
        self.assertNotIn('migration-number', ids(self.questions(CLEAR + '\nIncluye la migración número 0042 para la tabla.')))

    def test_acceptance_is_conservative(self):
        silent = 'Hacer algo con los prospectos. ' * 20
        self.assertIn('acceptance-criteria', ids(self.questions(silent)))
        self.assertNotIn('acceptance-criteria', ids(self.questions('Hacer algo breve.')))
        self.assertNotIn('acceptance-criteria', ids(self.questions(silent + 'Debe responder 200.')))

    def test_contract_proposal(self):
        self.assertIn('contract-ratification', ids(self.questions(CLEAR + '\nContrato: PROPUESTA de endpoints.')))

    def test_dependency_on_unclosed_card(self):
        self.assertIn('dependency-red-001-84', ids(self.questions(CLEAR + '\nDepende de RED-001-84 para el modelo.')))
        self.assertNotIn('dependency-red-001-84', ids(self.questions(CLEAR + '\nDepende de RED-001-84, ya cerrada y mergeada.')))

    def test_answers_resolve_but_stay_in_receipt(self):
        text = CLEAR + '\nContrato: PROPUESTA de endpoints.'
        with preflight_fixture():
            pending = preflight.run('api', text)
            self.assertFalse(pending['ready'])
            resolved = preflight.run('api', text, {'contract-ratification': 'Ratificado el 2026-10-10'})
            self.assertEqual(resolved['questions'], [])
            self.assertTrue(resolved['ready'])
            self.assertEqual(resolved['answered'], ['contract-ratification'])
            receipt = json.loads((preflight.ROOT / resolved['receipt']).read_text(encoding='utf-8'))
            self.assertEqual(receipt['answers'], {'contract-ratification': 'Ratificado el 2026-10-10'})
            self.assertTrue(receipt['ready'])


class WarningTests(unittest.TestCase):
    def warnings(self, **env):
        with preflight_fixture(**env) as root:
            return root, preflight.run('api', CLEAR)

    def test_non_dedicated_e2e_dsn_blocks(self):
        _, result = self.warnings(REDEVENT_E2E_DSN='postgres://u:p@localhost:5432/redevent?sslmode=disable')
        self.assertFalse(result['ready'])
        blocking = [w for w in result['warnings'] if w['severity'] == 'blocking']
        self.assertEqual(ids(blocking), ['e2e-dsn-not-dedicated'])
        _, ok = self.warnings(REDEVENT_E2E_DSN='postgres://u:p@localhost:5432/redevent_e2e')
        self.assertTrue(ok['ready'])

    def test_env_infos_do_not_block(self):
        _, result = self.warnings(HARNESS_ALLOW_HOST_WRITES='1')
        self.assertIn('host-writes-enabled', ids(result['warnings']))
        self.assertTrue(result['ready'])

    def test_orphan_worktree_dead_lock_and_running_nodes(self):
        with preflight_fixture() as root:
            make_task(root, '20260101000000-aaaaaa', status='completed', passed=7)
            registry(root, '20260101000000-aaaaaa')
            make_task(root, '20260101000001-bbbbbb', status='failed', running='tester')
            make_lock(root, '20260101000001-bbbbbb', pid=2 ** 22 + 12345)
            result = preflight.run('api', CLEAR)
            found = ids(result['warnings'])
            self.assertIn('orphan-worktrees', found)
            self.assertIn('dead-locks', found)
            self.assertIn('failed-with-running-nodes-20260101000001-bbbbbb', found)
            self.assertTrue(result['ready'])

    def test_dirty_tree_is_info_only(self):
        with preflight_fixture():
            with patch.object(preflight, 'dirty_files', return_value=['README.md']):
                result = preflight.run('api', CLEAR)
            self.assertIn('dirty-tree', ids(result['warnings']))
            self.assertTrue(result['ready'])

    def test_invalid_units_block_instead_of_raising(self):
        with preflight_fixture():
            result = preflight.run('api', 'Criterio de aceptación: ok\nunit: a | bogus=1\n' + 'x' * 400)
            self.assertIn('plan-invalid', ids(result['warnings']))
            self.assertFalse(result['ready'])


class ReceiptTests(unittest.TestCase):
    def test_absent_fresh_and_expired(self):
        with preflight_fixture():
            with self.assertRaises(config.UsageError) as caught:
                preflight.require_receipt('api', BIG_UNITS)
            self.assertIn('harness:preflight', str(caught.exception))
            preflight.run('api', BIG_UNITS)
            preflight.require_receipt('api', BIG_UNITS)
            preflight.require_receipt('api', BIG_UNITS, now=time.time() + 59 * 60)
            with self.assertRaises(config.UsageError):
                preflight.require_receipt('api', BIG_UNITS, now=time.time() + 61 * 60)

    def test_not_ready_receipt_is_rejected(self):
        text = BIG_UNITS + '\nContrato: PROPUESTA.'
        with preflight_fixture():
            self.assertFalse(preflight.run('api', text)['ready'])
            with self.assertRaises(config.UsageError):
                preflight.require_receipt('api', text)

    def test_trivial_task_is_exempt_and_off_skips(self):
        with preflight_fixture():
            preflight.require_receipt('api', 'Corregir el typo en el README del API.')
            with self.assertRaises(config.UsageError):
                preflight.require_receipt('api', BIG_UNITS)
            preflight.require_receipt('api', BIG_UNITS, environ={'HARNESS_PREFLIGHT': 'off'})
            with patch.dict(os.environ, {'HARNESS_PREFLIGHT': 'off'}):
                preflight.require_receipt('api', BIG_UNITS)
            with self.assertRaises(config.UsageError):  # long text is never trivial, even without unit lines
                preflight.require_receipt('api', CLEAR + 'a' * 400)


class CleanupTests(unittest.TestCase):
    def test_removes_only_orphans_and_never_live_tasks(self):
        with preflight_fixture() as root:
            done, live, active = '20260101000000-aaaaaa', '20260101000001-bbbbbb', '20260101000002-cccccc'
            make_task(root, done, status='completed', passed=7)
            make_task(root, live, status='completed', passed=7)  # would be removable by status; protected by live lock
            make_lock(root, live)
            make_task(root, active, status='active')
            make_lock(root, active)
            gone, kept_live, kept_active = registry(root, done), registry(root, live), registry(root, active)
            with patch.object(worktree.Worktree, 'discard', autospec=True,
                              side_effect=lambda self: worktree.registry_file(self.name).unlink(missing_ok=True)):
                cleaned = preflight.cleanup_orphan_worktrees()
            self.assertEqual(len(cleaned), 1)
            self.assertIn(gone, cleaned[0])
            names = {e['name'] for e in worktree.list_registry()}
            self.assertEqual(names, {kept_live, kept_active})
            self.assertEqual(preflight.live_task_ids(), sorted([live, active]))

    def test_explicit_live_ids_are_protected(self):
        with preflight_fixture() as root:
            make_task(root, '20260101000000-aaaaaa', status='completed', passed=7)
            registry(root, '20260101000000-aaaaaa')
            with patch.object(worktree.Worktree, 'discard', autospec=True) as discard:
                self.assertEqual(preflight.cleanup_orphan_worktrees(['20260101000000-aaaaaa']), [])
            discard.assert_not_called()

    def test_busy_workspace_lock_and_errors_never_raise(self):
        with preflight_fixture() as root:
            make_task(root, '20260101000000-aaaaaa', status='completed', passed=7)
            registry(root, '20260101000000-aaaaaa')
            (root / '.harness/state/workspace.lock').write_text(json.dumps({'pid': os.getpid()}), encoding='utf-8')
            with patch.object(worktree.Worktree, 'discard', autospec=True) as discard:
                self.assertEqual(preflight.cleanup_orphan_worktrees(), [])
            discard.assert_not_called()
            (root / '.harness/state/workspace.lock').unlink()
            with patch.object(worktree.Worktree, 'discard', side_effect=OSError('boom')):
                self.assertEqual(preflight.cleanup_orphan_worktrees(), [])
            with patch.object(worktree, 'list_registry', side_effect=RuntimeError('boom')):
                self.assertEqual(preflight.cleanup_orphan_worktrees(), [])


class CliTests(unittest.TestCase):
    def call(self, args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = preflight.main(args)
        return code, json.loads(out.getvalue())

    def test_exit_codes_answers_and_file(self):
        with preflight_fixture() as root:
            spec = root / 'spec.md'
            spec.write_text(CLEAR + '\nContrato: PROPUESTA de endpoints.', encoding='utf-8')
            code, data = self.call(['api', '--file', str(spec)])
            self.assertEqual((code, data['ready']), (1, False))
            code, data = self.call(['api', '--file', str(spec), '--answers', 'contract-ratification=Ratificado, vigente'])
            self.assertEqual((code, data['ready']), (0, True))
            code, data = self.call(['api', '--file', str(spec), '--answer', 'contract-ratification=si', '--fix'])
            self.assertEqual(data['fixed'], [])

    def test_usage_errors(self):
        for args in ([], ['api'], ['api', '--nope', 'x'], ['api', '--file'], ['api', 'x', '--answers', 'sinigual']):
            with preflight_fixture():
                with self.assertRaises(config.UsageError):
                    preflight.main(args)



def tool_probe(**versions):
    """Fake `tool_version`: name -> (major, minor) | None (missing); unknown tools are present at 99.0."""
    return lambda name: ((None, None) if name in versions and versions[name] is None else ('/bin/' + name, versions.get(name, (99, 0))))


def by_id(checks):
    return {c['id']: c for c in checks}


def run_checks(root, needs, **probes):
    env = {'HARNESS_HOST': 'claude'}
    return envcheck.run_checks(needs, root, root / '.harness', env.get, probes={'tool': tool_probe(), 'which': lambda n: '/bin/' + n,
                                                                                 'port': lambda p: True, 'tcp': lambda h, p: True,
                                                                                 'remote': lambda r: None, **probes})


class NeedsTests(unittest.TestCase):
    def test_docs_only_needs_nothing_but_the_provider(self):
        self.assertEqual(envcheck.derive_needs(['docs']), {'provider'})
        self.assertEqual(envcheck.derive_needs(['docs'], trivial=True), set())
        self.assertEqual(envcheck.derive_needs(['api'], trivial=True), {'go', 'db', 'ports'})
        self.assertEqual(envcheck.derive_needs(['sales-portal', 'docs']), {'node', 'ports', 'provider'})
        self.assertEqual(envcheck.derive_needs(['infra'], trivial=True), {'docker'})

    def test_parse_needs_rejects_unknown(self):
        self.assertEqual(envcheck.parse_needs('db, go'), {'db', 'go'})
        with self.assertRaises(ValueError):
            envcheck.parse_needs('db,redis')

    def test_docs_run_never_demands_postgres_go_or_docker(self):
        with preflight_fixture(HARNESS_PREFLIGHT_CHECKS='', HARNESS_HOST='claude'):
            with patch.object(envcheck, 'tool_version', tool_probe()), patch('shutil.which', return_value='/bin/claude'):
                result = preflight.run('docs', CLEAR)
        checks = by_id(result['checks'])
        for identity in ('db', 'tool-go', 'tool-node', 'tool-docker', 'ports'):
            self.assertEqual(checks[identity]['status'], 'skipped', identity)
        self.assertNotIn('db-dsn', checks)
        self.assertEqual(checks['provider']['status'], 'ok')

    def test_api_run_derives_go_and_db(self):
        with preflight_fixture(HARNESS_PREFLIGHT_CHECKS='', HARNESS_HOST='claude'):
            with patch.object(envcheck, 'tool_version', tool_probe(go=None)), patch('shutil.which', return_value='/bin/x'):
                result = preflight.run('api', CLEAR)
        checks = by_id(result['checks'])
        self.assertIn('db-dsn', checks)
        self.assertEqual((checks['tool-go']['status'], checks['tool-go']['severity']), ('fail', 'blocking'))
        self.assertFalse(result['ready'])
        self.assertEqual(result['questions'], [])


class ToolCheckTests(unittest.TestCase):
    def test_missing_and_too_old_block_only_when_needed(self):
        with preflight_fixture() as root:
            (root / 'package.json').write_text('{"engines": {"node": ">=24"}}', encoding='utf-8')
            checks = by_id(run_checks(root, {'go', 'node'}, tool=tool_probe(go=None, node=(20, 1), pnpm=(11, 23))))
            self.assertEqual(checks['tool-go']['status'], 'fail')
            self.assertEqual(checks['tool-node']['status'], 'fail')
            self.assertIn('menor', checks['tool-node']['message'])
            self.assertEqual(checks['tool-pnpm']['status'], 'ok')
            self.assertEqual(checks['tool-docker']['status'], 'skipped')
            self.assertEqual(checks['tool-git']['status'], 'ok')

    def test_unreadable_version_is_a_warning(self):
        with preflight_fixture() as root:
            checks = by_id(run_checks(root, {'go'}, tool=lambda n: ('/bin/' + n, None)))
            self.assertEqual((checks['tool-go']['status'], checks['tool-go']['severity']), ('fail', 'warning'))

    def test_minimums_come_from_repo_files_and_policy(self):
        with preflight_fixture() as root:
            (root / 'package.json').write_text(json.dumps({'engines': {'node': '>=24'}, 'packageManager': 'pnpm@11.23.0'}), encoding='utf-8')
            (root / 'apps/api').mkdir(parents=True)
            (root / 'apps/api/go.mod').write_text('module x\n\ngo 1.26.0\n', encoding='utf-8')
            found = envcheck.min_versions(root)
            self.assertEqual((found['node'], found['pnpm'], found['go']), ((24,), (11,), (1, 26)))
            self.assertEqual(envcheck.min_versions(root, {'go': '1.30'})['go'], (1, 30))
            (root / '.nvmrc').write_text('v22.1.0\n', encoding='utf-8')
            (root / 'package.json').write_text('{}', encoding='utf-8')
            self.assertEqual(envcheck.min_versions(root)['node'], (22,))

    def test_parse_version(self):
        self.assertEqual(envcheck.parse_version('go version go1.26.9 windows/amd64'), (1, 26, 9))
        self.assertEqual(envcheck.parse_version('git version 2.45.1.windows.1'), (2, 45, 1))
        self.assertIsNone(envcheck.parse_version('sin version'))


class DatabaseCheckTests(unittest.TestCase):
    def checks(self, root, dsn, reachable=True, dev='postgres://u:p@localhost:5432/redevent?sslmode=disable'):
        (root / 'apps/api').mkdir(parents=True, exist_ok=True)
        (root / 'apps/api/.env.example').write_text('DB_DSN=' + dev + '\n', encoding='utf-8')
        return by_id(envcheck.db_checks(root, {'REDEVENT_E2E_DSN': dsn}.get, lambda h, p: reachable))

    def test_isolated_reachable_database_and_no_credentials(self):
        with preflight_fixture() as root:
            checks = self.checks(root, 'postgres://admin:hunter2secret@db.local:5433/redevent_e2e?sslmode=disable')
            self.assertEqual([checks[i]['status'] for i in ('db-dsn', 'db-isolation', 'db-reachable', 'db-exists')], ['ok', 'ok', 'ok', 'skipped'])
            self.assertIn('db.local:5433', checks['db-dsn']['message'])
            self.assertNotIn('hunter2secret', json.dumps(checks))
            self.assertNotIn('admin', json.dumps(checks))

    def test_not_dedicated_or_same_as_dev_blocks(self):
        with preflight_fixture() as root:
            plain = self.checks(root, 'postgres://u:p@localhost/redevent')['db-isolation']
            self.assertEqual((plain['severity'], plain['status']), ('blocking', 'fail'))
            same = self.checks(root, 'postgres://u:p@localhost/redevent_e2e', dev='postgres://u:p@localhost/redevent_e2e')
            self.assertIn('desarrollo', same['db-isolation']['message'])
            self.assertEqual(same['db-isolation']['status'], 'fail')

    def test_unreachable_is_a_warning_and_missing_dsn_skips_the_rest(self):
        with preflight_fixture() as root:
            down = self.checks(root, 'host=pg port=6543 dbname=x_e2e user=u password=zzz', reachable=False)
            self.assertEqual((down['db-reachable']['status'], down['db-reachable']['severity']), ('fail', 'warning'))
            self.assertIn('pg:6543', down['db-reachable']['message'])
            self.assertNotIn('zzz', json.dumps(down))
            none = by_id(envcheck.db_checks(root, lambda n: None))
            self.assertEqual((none['db-dsn']['severity'], none['db-reachable']['status']), ('warning', 'skipped'))

    def test_parse_dsn(self):
        self.assertEqual(envcheck.parse_dsn('postgres://u:p@h:1234/d?x=1'), ('h', 1234, 'd'))
        self.assertEqual(envcheck.parse_dsn('postgresql://u@h/d'), ('h', 5432, 'd'))
        self.assertEqual(envcheck.parse_dsn('host=h dbname=d'), ('h', 5432, 'd'))


class MigrationCheckTests(unittest.TestCase):
    def tree(self, root, names):
        directory = root / envcheck.MIGRATIONS
        directory.mkdir(parents=True, exist_ok=True)
        for name in names:
            (directory / name).write_text('-- sql\n', encoding='utf-8')

    def test_contiguous_numbering_and_next_free(self):
        with preflight_fixture() as root:
            self.tree(root, ['000001_a.up.sql', '000002_b.up.sql', '000002_b.down.sql'])
            checks = by_id(envcheck.migration_checks(root, lambda r: ['000001_a.up.sql', '000002_b.up.sql']))
            self.assertEqual(checks['migrations-numbering']['status'], 'ok')
            self.assertIn('000003', checks['migrations-numbering']['message'])
            self.assertIn('000003', checks['migrations-origin-qa']['message'])
            self.assertEqual(checks['migrations-origin-qa']['status'], 'ok')

    def test_duplicate_gap_and_collision(self):
        with preflight_fixture() as root:
            self.tree(root, ['000001_a.up.sql', '000002_b.up.sql', '000002_otra.up.sql', '000005_e.up.sql'])
            checks = by_id(envcheck.migration_checks(root, lambda r: ['000005_distinta.up.sql']))
            self.assertEqual((checks['migrations-numbering']['status'], checks['migrations-numbering']['severity']), ('fail', 'blocking'))
            self.assertIn('000002', checks['migrations-numbering']['message'])
            self.assertEqual(checks['migrations-origin-qa']['status'], 'fail')
            self.assertIn('000005', checks['migrations-origin-qa']['message'])
        with preflight_fixture() as root:
            self.tree(root, ['000001_a.up.sql', '000004_d.up.sql'])
            checks = by_id(envcheck.migration_checks(root, lambda r: None))
            self.assertEqual(checks['migrations-numbering']['severity'], 'warning')
            self.assertEqual(checks['migrations-origin-qa']['status'], 'skipped')

    def test_qa_ahead_moves_next_free_number(self):
        with preflight_fixture() as root:
            self.tree(root, ['000001_a.up.sql'])
            checks = by_id(envcheck.migration_checks(root, lambda r: ['000001_a.up.sql', '000002_b.up.sql', '000003_c.up.sql']))
            self.assertEqual(checks['migrations-origin-qa']['severity'], 'warning')
            self.assertIn('000004', checks['migrations-origin-qa']['message'])

    def test_open_pr_collision_and_reserved_next(self):
        with preflight_fixture() as root:
            self.tree(root, ['000001_a.up.sql', '000002_local.up.sql'])
            prs = lambda r, exclude_branch=None: [
                {'number': 41, 'title': 'migration', 'headRefName': 'feature-other',
                 'files': ['000002_other.up.sql', '000005_future.up.sql']}]
            checks = by_id(envcheck.migration_checks(root, lambda r: ['000001_a.up.sql'], prs=prs))
            self.assertEqual(checks['migrations-open-prs']['severity'], 'blocking')
            self.assertEqual(checks['migrations-open-prs']['status'], 'fail')
            report = envcheck.migration_report(root, lambda r: ['000001_a.up.sql'], prs=prs)
            self.assertEqual(report['next'], 6)
            self.assertEqual(report['collisions'], [2])

    def test_qa_collision_is_reported_even_without_open_prs(self):
        with preflight_fixture() as root:
            self.tree(root, ['000032_login_selection.up.sql'])
            report = envcheck.migration_report(
                root, lambda r: ['000032_availability_permissions.up.sql'],
                prs=lambda r, exclude_branch=None: [])
            self.assertEqual(report['collisions'], [32])
            self.assertEqual(report['collisionSources']['32'], ['qa'])

    def test_open_pr_offline_is_skipped(self):
        with preflight_fixture() as root:
            self.tree(root, ['000001_a.up.sql'])
            checks = by_id(envcheck.migration_checks(root, lambda r: None, prs=lambda r, exclude_branch=None: None))
            self.assertEqual(checks['migrations-open-prs']['status'], 'skipped')

    def test_exclude_current_branch(self):
        with preflight_fixture() as root:
            self.tree(root, ['000001_a.up.sql'])
            with patch.object(envcheck.shutil, 'which', return_value='gh'), \
                 patch.object(envcheck.subprocess, 'run') as run:
                run.return_value.returncode = 0
                run.return_value.stdout = json.dumps([
                    {'number': 1, 'title': 'own', 'headRefName': 'current',
                     'files': [{'path': envcheck.MIGRATIONS + '/000002_a.up.sql'}]},
                    {'number': 2, 'title': 'other', 'headRefName': 'other',
                     'files': [{'path': envcheck.MIGRATIONS + '/000003_b.up.sql'}]}])
                result = envcheck.open_pr_migrations(root, exclude_branch='current')
            self.assertEqual([x['number'] for x in result], [2])

    def test_real_repo_numbering_is_readable(self):
        found = envcheck.migration_checks(Path(__file__).resolve().parents[3], lambda r: None)
        self.assertIn(by_id(found)['migrations-numbering']['status'], ('ok', 'fail', 'skipped'))


class PortProviderDiskTests(unittest.TestCase):
    def test_ports_only_when_needed_and_in_use_is_a_warning(self):
        with preflight_fixture() as root:
            (root / 'apps/api').mkdir(parents=True)
            (root / 'apps/api/.env.example').write_text('HTTP_ADDR=:8000\nCORS_ALLOWED_ORIGINS=http://localhost:5050,http://localhost:5051\n', encoding='utf-8')
            self.assertEqual(envcheck.api_ports(root), {8000: 'API (HTTP_ADDR)', 5050: 'portal (CORS_ALLOWED_ORIGINS)', 5051: 'portal (CORS_ALLOWED_ORIGINS)'})
            self.assertEqual(envcheck.port_checks(root, {'go'})[0]['status'], 'skipped')
            checks = by_id(envcheck.port_checks(root, {'ports', 'go'}, lambda p: p != 8000))
            self.assertEqual(list(checks), ['port-8000'])
            self.assertEqual((checks['port-8000']['status'], checks['port-8000']['severity']), ('fail', 'warning'))
            both = by_id(envcheck.port_checks(root, {'ports', 'node'}, lambda p: True))
            self.assertEqual(sorted(both), ['port-5050', 'port-5051'])

    def test_real_bind_detects_a_listener(self):
        import socket
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        try:
            self.assertFalse(envcheck.port_free(listener.getsockname()[1]))
        finally:
            listener.close()

    def test_provider_by_host_command_and_missing(self):
        with preflight_fixture() as root:
            h = root / '.harness'
            self.assertEqual(envcheck.provider_checks(h, {'HARNESS_HOST': 'codex'}.get, lambda n: '/bin/codex')[0]['status'], 'ok')
            missing = envcheck.provider_checks(h, {'HARNESS_HOST': 'codex'}.get, lambda n: None)[0]
            self.assertEqual((missing['status'], missing['severity']), ('fail', 'blocking'))
            self.assertEqual(envcheck.provider_checks(h, {}.get, lambda n: '/x')[0]['status'], 'fail')
            self.assertEqual(envcheck.provider_checks(h, {'HARNESS_AGENT_COMMAND': 'my-agent --flag'}.get, lambda n: '/x' if n == 'my-agent' else None)[0]['status'], 'ok')
            self.assertEqual(envcheck.provider_checks(h, {'HARNESS_AGENT_COMMAND': 'nope'}.get, lambda n: None)[0]['status'], 'fail')

    def test_quota_hint_from_recent_state(self):
        with preflight_fixture() as root:
            state = root / '.harness/state'
            state.mkdir(parents=True, exist_ok=True)
            (state / 'abc.json').write_text('{"error": "Usage limit reached for this plan"}', encoding='utf-8')
            (state / 'def.json').write_text('{"error": "tests failed"}', encoding='utf-8')
            self.assertEqual(envcheck.quota_hint(root / '.harness'), ['abc'])
            found = envcheck.provider_checks(root / '.harness', {'HARNESS_HOST': 'claude'}.get, lambda n: '/x')
            self.assertEqual(found[1]['id'], 'provider-quota')

    def test_disk_ok_low_unwritable_and_invalid_dir(self):
        with preflight_fixture() as root:
            h = root / '.harness'
            fine = by_id(envcheck.disk_checks(h, root / 'no' / 'existe' / 'todavia'))
            self.assertEqual(fine['disk-worktree']['status'], 'ok')
            self.assertFalse((root / 'no').exists())  # probing never creates the directory
            self.assertEqual(envcheck.nearest_existing(root / 'a' / 'b' / 'c'), root)
            low = by_id(envcheck.disk_checks(h, root, {'worktree': (10 ** 12, 10 ** 12)}))
            self.assertEqual((low['disk-worktree']['status'], low['disk-worktree']['severity']), ('fail', 'blocking'))
            with patch.object(envcheck, 'writable', return_value=False):
                self.assertIn('permiso', by_id(envcheck.disk_checks(h, root))['disk-worktree']['message'])
            bad = by_id(envcheck.disk_checks(h, ValueError('HARNESS_WORKTREE_DIR must be an absolute path')))
            self.assertEqual(bad['disk-worktree']['severity'], 'blocking')

    def test_relative_worktree_dir_is_reported_not_raised(self):
        with preflight_fixture(HARNESS_WORKTREE_DIR='relative\\wt', HARNESS_PREFLIGHT_CHECKS='', HARNESS_HOST='claude'):
            with patch('shutil.which', return_value='/bin/x'), patch.object(envcheck, 'tool_version', tool_probe()):
                result = preflight.run('docs', CLEAR)
        self.assertEqual(by_id(result['checks'])['disk-worktree']['status'], 'fail')
        self.assertFalse(result['ready'])


class ResidualAndWiringTests(unittest.TestCase):
    def test_residual_reports_pids_and_never_kills(self):
        with preflight_fixture() as root:
            state = root / '.harness/state'
            state.mkdir(parents=True, exist_ok=True)
            (state / 't1.lock').write_text('{"pid": 4242}', encoding='utf-8')
            with patch('os.kill') as kill, patch('subprocess.Popen') as popen:
                found = envcheck.residual_check(root / '.harness', ['t1'], [{'name': 'wt'}])
            kill.assert_not_called()
            popen.assert_not_called()
            self.assertIn('4242', found['message'])
            self.assertEqual((found['severity'], found['status']), ('optional', 'fail'))
            self.assertEqual(envcheck.residual_check(root / '.harness', [], [])['status'], 'ok')

    def test_blocking_check_makes_run_not_ready_and_warnings_coexist(self):
        blocker = envcheck.check('tool-go', 'blocking', 'fail', 'go no está', 'Instalar go')
        with preflight_fixture(HARNESS_PREFLIGHT_CHECKS=''):
            with patch.object(envcheck, 'run_checks', return_value=[blocker]):
                result = preflight.run('api', CLEAR)
            self.assertFalse(result['ready'])
            self.assertEqual(result['checks'], [blocker])
            self.assertIn('warnings', result)
            with patch.object(envcheck, 'run_checks', return_value=[envcheck.check('x', 'warning', 'fail', 'm')]), \
                 patch.object(preflight, 'baseline_gates', return_value=[{'status': 'PASS'}]):
                self.assertTrue(preflight.run('api', CLEAR)['ready'])

    def test_explicit_needs_override_derivation(self):
        with preflight_fixture(HARNESS_PREFLIGHT_CHECKS=''), patch.object(envcheck, 'run_checks', return_value=[]) as fake:
            preflight.run('docs', CLEAR, needs={'db'})
            self.assertEqual(fake.call_args[0][0], {'db'})

    def test_checks_only_cli(self):
        call = CliTests().call
        with preflight_fixture(HARNESS_PREFLIGHT_CHECKS=''), patch.object(envcheck, 'run_checks', return_value=[]) as fake:
            code, data = call(['--checks-only', '--needs', 'db,go'])
            self.assertEqual((code, data['ready'], data['needs']), (0, True, ['db', 'go']))
            self.assertEqual(fake.call_args[0][0], {'db', 'go'})
            code, data = call(['--checks-only'])
            self.assertNotIn('docker', data['needs'])
        blocker = envcheck.check('tool-go', 'blocking', 'fail', 'x')
        with preflight_fixture(HARNESS_PREFLIGHT_CHECKS=''), patch.object(envcheck, 'run_checks', return_value=[blocker]):
            self.assertEqual(call(['--checks-only', '--needs', 'go'])[0], 1)
        with preflight_fixture():
            with self.assertRaises(config.UsageError):
                preflight.main(['--checks-only', '--needs', 'redis'])

    def test_checks_stay_fast_with_mocked_probes(self):
        with preflight_fixture() as root:
            started = time.time()
            run_checks(root, {'go', 'db', 'ports', 'provider'})
            self.assertLess(time.time() - started, 3)


if __name__ == '__main__':
    unittest.main()
