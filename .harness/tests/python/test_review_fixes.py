"""Second independent pre-PR review: base resolution, scoped domains, tails, workspace moves, fingerprint, soft steps."""
import contextlib
import io
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture, SOURCE
from gitenv import git_run
from test_impact import js_fixture, plan_of, write, package
from core import changes, cigaps, config, hygiene, impact, verification

sys.path.insert(0, str(SOURCE))
import cli


def git(root, *args):
    return git_run(root, *args).stdout.strip()


def run_cli(command, *args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = cli.main(command, list(args))
        except config.UsageError as error:
            code = 2
            err.write(str(error))
        except ValueError as error:
            code = 1
            err.write(str(error))
    return code, out.getvalue(), err.getvalue()


def committed_repo(root):
    git(root, 'init', '-b', 'feature')
    write(root, 'README.md', 'x')
    git(root, 'add', '.')
    git(root, 'commit', '-m', 'base')


class BaseResolutionTests(unittest.TestCase):
    def test_precedence_flag_env_merge_base_local(self):
        with fixture() as root:
            committed_repo(root)
            self.assertEqual(changes.resolve_base(), (None, 'local changes only'))
            git(root, 'update-ref', 'refs/remotes/origin/qa', 'HEAD')
            ref, source = changes.resolve_base()
            self.assertEqual((ref, source), (git(root, 'rev-parse', 'HEAD'), 'merge-base with origin/qa'))
            with patch.dict('os.environ', {'HARNESS_BASE': 'HEAD'}):
                self.assertEqual(changes.resolve_base(), ('HEAD', 'HARNESS_BASE'))
                self.assertEqual(changes.resolve_base('feature'), ('feature', '--base'))
            git(root, 'checkout', '-b', 'qa')
            self.assertEqual(changes.resolve_base(), (None, 'local changes only'))  # HEAD is qa

    def test_invalid_refs_are_rejected_like_harness_base(self):
        for ref in ['-x', 'a\nb', 'a\x00b']:
            with self.assertRaises(ValueError):
                changes.resolve_base(ref)
        with fixture() as root:
            committed_repo(root)
            code, _, err = run_cli('verify', '--plan', '--base', '--evil')
            self.assertEqual(code, 2)  # a usage error, not a verification FAIL
            self.assertIn('--base', err)
            for args in [('--base', '--plan'), ('--plan', '--base=-x'), ('--plan', '--base', 'no-such-ref')]:
                code, _, err = run_cli('verify', *args)
                self.assertEqual(code, 2, args)
                self.assertIn('--base', err)

    def test_missing_local_ref_falls_back_to_the_remote_tracking_one_with_a_notice(self):
        with fixture() as root:
            committed_repo(root)
            git(root, 'update-ref', 'refs/remotes/origin/qa', 'HEAD')
            ref, source = changes.resolve_base('qa')
            self.assertEqual(ref, 'origin/qa')
            self.assertIn("local ref 'qa' does not exist", source)
            code, out, _ = run_cli('verify', '--plan', '--explain', '--base', 'qa')
            self.assertEqual(code, 0)
            self.assertIn('origin/qa', out)
            self.assertEqual(run_cli('verify', '--plan', '--base', 'origin/qa')[0], 0)
            git(root, 'branch', 'qa')
            self.assertEqual(changes.resolve_base('qa'), ('qa', '--base'))  # a local ref wins, no notice

    def test_committed_changes_are_verified_with_base_and_reported(self):
        with fixture() as root:
            js_fixture(root)
            committed_repo(root)
            git(root, 'branch', 'qa')
            write(root, 'packages/x/src/b.ts', 'committed')
            git(root, 'add', '.')
            git(root, 'commit', '-m', 'feature')
            code, out, _ = run_cli('verify', '--plan', '--json')
            self.assertEqual(json.loads(out)['checks'], [])  # nothing local: the committed change is invisible
            code, out, _ = run_cli('verify', '--plan', '--json', '--base', 'qa')
            plan = json.loads(out)
            self.assertEqual(plan['base'], {'ref': 'qa', 'source': '--base'})
            self.assertTrue(plan['checks'])
            code, text, _ = run_cli('verify', '--plan', '--explain', '--base=qa')
            self.assertIn('Base: qa (--base)', text)

    def test_no_changes_and_no_base_is_empty_with_guidance(self):
        with fixture() as root:
            committed_repo(root)
            code, out, _ = run_cli('verify')
            self.assertEqual(code, verification.EXIT['EMPTY'])
            self.assertEqual(code, 4)
            self.assertIn('Verification EMPTY', out)
            self.assertIn('--base', out)
            self.assertIn('Base: local changes only', out)
            self.assertIn('unless a base is given', out)
            self.assertIn('--base origin/qa', out)
            self.assertEqual(run_cli('report')[0], verification.EXIT['EMPTY'])

    def test_empty_notice_names_the_base_actually_used(self):
        with fixture() as root:
            committed_repo(root)
            code, out, _ = run_cli('verify', '--base', 'HEAD')
            self.assertEqual(code, verification.EXIT['EMPTY'])
            self.assertIn('Base: HEAD (--base)', out)
            self.assertNotIn('unless a base is given', out)
            self.assertIn('measured against HEAD (--base)', out)


class ScopedDomainTests(unittest.TestCase):
    def test_domain_argument_is_recorded_and_not_authoritative_when_it_hides_gates(self):
        with fixture() as root:
            ok = [sys.executable, '-B', '-c', 'pass']
            files = ['apps/api/internal/a.go', 'docs/a.md']
            plan = {**plan_of(ok), 'files': files, 'domains': ['docs'], 'requestedDomain': 'docs', 'full': False}
            plan['checks'][0]['tier'] = 'authoritative'
            with patch.object(verification, 'verify_plan', side_effect=lambda name=None, **kw: plan if name else {'domains': ['api', 'docs']}):
                summary = verification.run_plan(plan, 20000)
            self.assertEqual((summary['status'], summary['domain'], summary['authoritative']), ('PASS', 'docs', False))
            self.assertIn('SCOPED', summary['notice'])
            saved = verification.last_summary()
            with patch.object(verification, 'staleness', return_value=None):
                self.assertEqual(run_cli('report')[0], verification.EXIT['FAST'])
            self.assertEqual(saved['domain'], 'docs')

    def test_domain_covering_every_selected_domain_stays_authoritative(self):
        with fixture():
            ok = [sys.executable, '-B', '-c', 'pass']
            plan = {**plan_of(ok), 'files': ['docs/a.md'], 'domains': ['docs'], 'requestedDomain': 'docs', 'full': False}
            with patch.object(verification, 'verify_plan', return_value={'domains': ['docs']}):
                self.assertTrue(verification.run_plan(plan, 20000)['authoritative'])


class TailTests(unittest.TestCase):
    def test_stderr_survives_long_stdout_and_both_are_redacted_bounded_and_reported(self):
        with fixture():
            code = 'import sys; print("x" * 50000); print("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", file=sys.stderr); print("tail-err", file=sys.stderr); sys.exit(2)'
            summary = verification.run_plan(plan_of([sys.executable, '-B', '-c', code]), 20000)
            check = summary['checks'][0]
            self.assertLessEqual(len(check['stdoutTail']), verification.TAIL)
            self.assertIn('tail-err', check['stderrTail'])
            self.assertNotIn('ghp_', check['stderrTail'])
            text = verification.render_report(summary)
            self.assertIn('stdout:', text)
            self.assertIn('stderr:', text)
            self.assertIn('tail-err', text)


class WorkspaceMoveTests(unittest.TestCase):
    def test_moved_or_deleted_package_json_selects_every_workspace(self):
        with fixture() as root:
            js_fixture(root)
            (root / 'apps/z/package.json').rename(root / 'apps/z/package.json.bak')
            checks = impact.js_checks(['apps/z/package.json'])
            names = {c['command'][2] for c in checks}
            self.assertEqual(names, {'./packages/x', './apps/y'})
            self.assertTrue(all('apps/z/package.json' in c['reason'] and 'package.json' in c['reason'] for c in checks))

    def test_placeholder_directories_select_nothing_but_removed_workspaces_still_widen(self):
        with fixture() as root:
            js_fixture(root)
            write(root, 'apps/loose/readme.md')
            committed_repo(root)
            # A README under a glob directory that never had a package.json is not a workspace change.
            self.assertEqual(impact.js_checks(['apps/loose/readme.md']), [])
            self.assertEqual(impact.js_checks(['apps/loose/readme.md'], 'HEAD'), [])
            self.assertEqual(impact.targeted_checks(['apps/loose/readme.md'], 'HEAD'), [])
            # A workspace whose package.json existed in the base (or HEAD) and is gone: dependents unknown.
            (root / 'apps/z/package.json').unlink()
            write(root, 'apps/z/readme.md')
            for base in (None, 'HEAD'):
                checks = impact.js_checks(['apps/z/readme.md'], base)
                self.assertEqual({c['command'][2] for c in checks}, {'./packages/x', './apps/y'}, base)
                self.assertIn('no longer exists or is invalid', checks[0]['reason'])
            # A removed workspace directory.
            shutil.rmtree(root / 'apps/z')
            self.assertEqual({c['command'][2] for c in impact.js_checks(['apps/z/src/a.ts'])}, {'./packages/x', './apps/y'})
            # The package.json of a workspace that is new relative to the base is not needed to be in the base.
            self.assertEqual({c['command'][2] for c in impact.js_checks(['apps/loose/package.json'])}, {'./packages/x', './apps/y'})
            self.assertEqual([c for c in impact.js_checks(['apps/api/main.go'])], [])

    def test_the_plan_passes_its_base_to_the_workspace_check(self):
        with fixture() as root:
            js_fixture(root)
            write(root, 'apps/loose/readme.md')
            committed_repo(root)
            code, out, _ = run_cli('verify', '--plan', '--json', '--base', 'HEAD')
            self.assertEqual(code, 0)
            self.assertEqual([c for c in json.loads(out)['checks'] if c['tier'] == 'targeted'], [])


class SelfAlterationTests(unittest.TestCase):
    def test_tracked_next_env_changes_are_not_hidden(self):
        with fixture() as root:
            committed_repo(root)
            write(root, 'apps/backoffice/next-env.d.ts', 'original')
            git(root, 'add', 'apps/backoffice/next-env.d.ts')
            git(root, 'commit', '-m', 'track Next environment artifact')
            write(root, 'apps/backoffice/next-env.d.ts', 'changed')
            self.assertFalse(verification.generated('apps/backoffice/next-env.d.ts'))
            self.assertIn('apps/backoffice/next-env.d.ts',
                          verification.snapshot()[1])

    def test_generated_artifacts_are_not_in_the_fingerprint_and_other_changes_are_marked(self):
        with fixture() as root:
            committed_repo(root)
            write(root, 'apps/backoffice/tsconfig.tsbuildinfo', 'one')
            write(root, 'apps/backoffice/next-env.d.ts', 'one')
            write(root, 'tsconfig.tsbuildinfo', 'one')
            self.assertEqual(verification.fingerprint()['changeSet']['count'], 0)
            rewrite = [sys.executable, '-B', '-c', 'open("apps/backoffice/tsconfig.tsbuildinfo","w").write("two")']
            with patch.object(verification, 'ROOT', root):
                summary = verification.run_plan(plan_of(rewrite), 20000)
            self.assertNotIn('selfAltered', summary)
            self.assertIsNone(verification.staleness(summary))
            real = [sys.executable, '-B', '-c', 'open("touched.txt","w").write("x")']
            summary = verification.run_plan(plan_of(real), 20000)
            self.assertEqual(summary['selfAltered'], ['touched.txt'])
            self.assertIn('SELF-ALTERED', summary['notice'])
            self.assertIn('changed files', verification.staleness(summary))


class CoveredByTests(unittest.TestCase):
    def test_apps_and_packages_js_checks_and_gofmt_are_covered_but_tooling_is_not(self):
        with fixture() as root:
            js_fixture(root)
            package(root, 'tooling/t', '@t/tool', ['lint'])
            write(root, 'tooling/t/a.ts')
            write(root, 'apps/api/internal/a/a.go')
            self.assertTrue(all(c.get('coveredBy') == 'verify-enterprise.sh' for c in impact.js_checks(['packages/x/src/a.ts'])))
            self.assertFalse(any(c.get('coveredBy') for c in impact.js_checks(['tooling/t/a.ts'])))
            with patch.object(impact, 'workspace_bases', return_value=['apps', 'packages', 'tooling']):
                self.assertFalse(any(c.get('coveredBy') for c in impact.js_checks(['tooling/t/a.ts'])))
            with patch.object(impact, 'go_list_json', side_effect=ValueError('x')):
                checks = impact.go_checks(['apps/api/internal/a/a.go'])
            self.assertTrue(all(c.get('coveredBy') == 'verify-enterprise.sh' for c in checks))
            self.assertEqual(checks[0]['command'][:3], ['gofmt', '-l', '--'])


class EnterpriseModeTests(unittest.TestCase):
    def test_only_the_script_as_first_argument_is_an_enterprise_run(self):
        self.assertEqual(verification.enterprise_mode(['bash', './verify-enterprise.sh', '--quick']), '--quick')
        self.assertEqual(verification.enterprise_mode(['bash', 'verify-enterprise.sh']), '')
        self.assertIsNone(verification.enterprise_mode(['bash', '-n', '--', 'verify-enterprise.sh']))
        self.assertIsNone(verification.enterprise_mode(['bash', './docker-verify-enterprise.sh']))
        self.assertEqual(verification.requires_for(['bash', '-n', '--', 'verify-enterprise.sh']), ['bash'])


class ArgvInjectionTests(unittest.TestCase):
    def test_file_names_cannot_become_options(self):
        with fixture() as root:
            write(root, '-s.sh', 'true')
            write(root, '.github/workflows/-x.yml', 'a: 1')
            commands = [c['command'] for c in impact.infra_checks(['-s.sh', '.github/workflows/-x.yml'])]
            self.assertEqual(commands[0], ['bash', '-n', '--', '-s.sh'])
            self.assertEqual(commands[1][-2:], ['--', '.github/workflows/-x.yml'])


class SoftStepTests(unittest.TestCase):
    def soft(self, text, pipefail=False):
        return [(a[1], bool(s)) for a, _, s in cigaps.shell_commands(text, True, pipefail)]

    def test_alternatives_conditions_negation_set_e_and_pipes(self):
        self.assertEqual(self.soft('pnpm a || echo failed\npnpm b\n'), [('a', True), ('b', False)])
        self.assertEqual(self.soft('if pnpm a; then\n  pnpm b\nfi\nwhile pnpm c; do pnpm d; done\n'),
                         [('a', True), ('b', False), ('c', True), ('d', False)])
        self.assertEqual(self.soft('! pnpm a\nif ! pnpm b; then echo; fi\n'), [('a', True), ('b', True)])
        self.assertEqual(self.soft('pnpm a\nset +e\npnpm b\nset -e\npnpm c\n'), [('a', False), ('b', True), ('c', False)])
        self.assertEqual(self.soft('pnpm a | tee out.txt\n'), [('a', True)])
        self.assertEqual(self.soft('pnpm a | tee out.txt\n', pipefail=True), [('a', False)])
        self.assertEqual(self.soft('set -o pipefail\npnpm a | tee out.txt\n'), [('a', False)])
        self.assertEqual(self.soft('set -euo pipefail\npnpm a | tee out.txt\n'), [('a', False)])

    def test_alternatives_and_branches_that_propagate_the_failure_are_hard(self):
        for text in ['pnpm a || exit 1', 'pnpm a || exit $?', 'pnpm a || false', 'pnpm a || exit', 'if ! pnpm a; then exit 1; fi',
                     'if ! pnpm a; then\n  exit 2\nfi', 'pnpm a && pnpm b || exit 1']:
            self.assertFalse([name for name, soft in self.soft(text) if soft], text)
        for text in ['pnpm a || exit 0', 'pnpm a || true', 'pnpm a || echo failed', 'pnpm a || pnpm b || exit 1', 'if ! pnpm a; then exit 0; fi',
                     'if ! pnpm a; then exit; fi', 'if ! pnpm a; then echo no; fi', 'pnpm a || exit 1 || true']:
            self.assertTrue([name for name, soft in self.soft(text) if soft], text)

    def test_step_shell_bash_enables_pipefail(self):
        text = ('jobs:\n  a:\n    steps:\n      - run: pnpm lint | tee l.txt\n      - run: pnpm test | tee t.txt\n        shell: bash\n')
        steps = cigaps.parse_workflow(text)
        self.assertEqual([s['shell'] for s in steps], ['', 'bash'])
        with fixture() as root:
            write(root, '.github/workflows/ci.yml', text)
            write(root, 'apps/web/package.json', json.dumps({'name': 'w', 'scripts': {'lint': 'l', 'test': 't'}}))
            with patch.object(cigaps.config, 'ROOT', root), patch.object(impact.config, 'ROOT', root):
                found = {c['raw']: c['soft'] for c in cigaps.ci_commands(impact.js_workspaces())}
            self.assertTrue(found['pnpm lint'])
            self.assertIsNone(found['pnpm test'])

    def test_job_counts_as_required_only_when_its_result_is_read(self):
        needs = {'a': [], 'b': [], 'required': ['a', 'b']}
        text = 'jobs:\n  a:\n    steps: []\n  b:\n    steps: []\n  required:\n    needs: [a, b]\n    steps:\n      - run: echo ${{ needs.a.result }}\n'
        self.assertEqual(cigaps.required_jobs(needs, text), {'required', 'a'})
        self.assertEqual(cigaps.required_jobs(needs), {'required', 'a', 'b'})


class UsageExitTests(unittest.TestCase):
    def test_usage_errors_exit_2_and_fail_stays_1(self):
        with fixture():
            for command, args in [('verify', ['--bogus']), ('verify', ['--full', '--fast']), ('verify', ['--explain']),
                                  ('verify', ['--base']), ('hygiene', ['--bogus']), ('ci-gaps', ['--bogus']), ('nonsense', [])]:
                self.assertEqual(run_cli(command, *args)[0], 2, (command, args))
            self.assertEqual(verification.EXIT, {'PASS': 0, 'FAIL': 1, 'USAGE': 2, 'PARTIAL': 3, 'EMPTY': 4, 'STALE': 5, 'FAST': 6})

    def test_process_exit_code_for_usage_errors(self):
        run = subprocess.run([sys.executable, '-I', '-B', str(SOURCE / 'cli.py'), 'verify', '--bogus'], capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)


class DocumentationTests(unittest.TestCase):
    def test_skipped_environment_guidance_points_to_execute_not_retry(self):
        instructions = (SOURCE / 'INSTRUCTIONS.md').read_text(encoding='utf-8')
        self.assertIn('pnpm harness:execute', instructions)
        self.assertNotIn('corregí\nel entorno y usá `harness:retry`', instructions)
        source = (SOURCE / 'core/delegation.py').read_text(encoding='utf-8')
        self.assertNotIn("then retry'", source)
        self.assertIn('harness:execute', source)
        for code in ['0 PASS', '1 FAIL', '2 uso', '3 PARTIAL', '4 EMPTY', '5 STALE', '6']:
            self.assertIn(code, instructions)


class HygieneRescanTests(unittest.TestCase):
    def test_candidates_are_scanned_again_inside_the_lock(self):
        with fixture() as root:
            file = root / '.harness/tasks/failed/20260927194556-0ba574.json'
            file.write_text('{"id": "20260927194556-0ba574", "status": "failed"}\n', encoding='utf-8')
            events = []
            real_scan, real_lock = hygiene.invalid_candidates, hygiene.Lock

            class Recording(real_lock):
                def __enter__(self):
                    events.append('lock')
                    return super().__enter__()

            def scan():
                events.append('scan')
                return real_scan()
            with patch.object(hygiene, 'Lock', Recording), patch.object(hygiene, 'invalid_candidates', scan):
                hygiene.quarantine(True)
            self.assertEqual(events, ['lock', 'scan'])
            self.assertFalse(file.exists())


if __name__ == '__main__':
    unittest.main()
