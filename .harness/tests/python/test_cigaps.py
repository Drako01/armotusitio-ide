"""CI <-> Harness parity: synthetic workflows in temporary fixtures; no network, no provider."""
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture
from test_impact import write, package
from core import config, check, cigaps

BASE = ['agents', 'domains']


def domain(name, paths, verification, enabled=True):
    return {'domain': name, 'agent': 'architect', 'paths': paths, 'exclude': [], 'instructions': [], 'skills': [],
            'contextSources': [], 'verification': verification, 'tokenBudget': 1000, 'ownership': 'x', 'dependencies': [],
            'risks': ['LOW'], 'securityImplications': [], **({} if enabled else {'enabled': False})}


def setup(root, workflow, domains=None, scripts=None):
    write(root, '.harness/manifests/domains.json', json.dumps({'schemaVersion': 1, 'domains': domains or []}))
    package(root, 'apps/web', '@t/web', scripts or ['lint', 'build'])
    package(root, 'packages/lib', '@t/lib', ['lint', 'test'])
    write(root, '.github/workflows/ci.yml', workflow)


def job(body, name='quality'):
    return f'name: CI\njobs:\n  {name}:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n{body}'


def rows(root):
    return cigaps.analyze()


def find(result, direction, item):
    return next(r for r in result if r['direction'] == direction and r['item'] == item)


def run_main(args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cigaps.main(args)
    return code, out.getvalue()


class ShellParsingTests(unittest.TestCase):
    def test_env_prefix_continuation_chain_and_quotes(self):
        text = 'set -euo pipefail\nCI=1 NODE_ENV=test pnpm --filter "./apps/web" \\\n  lint && echo done; go test ./... | tee out\n'
        found = [argv for argv, _ in cigaps.shell_commands(text)]
        self.assertEqual(found, [['pnpm', '--filter', './apps/web', 'lint'], ['go', 'test', './...']])

    def test_loops_dirname_cd_and_redirects(self):
        text = ('for package in packages/*/package.json; do\n  dir="$(dirname "$package")"\n'
                '  for script in lint test; do\n    pnpm --filter "./${dir}" run "${script}" >/dev/null 2>&1\n  done\ndone\n'
                'cd apps/api\ngo vet ./... # comment\ncat <<EOF\npnpm hidden\nEOF\n')
        found = [(argv, cwd) for argv, cwd in cigaps.shell_commands(text)]
        self.assertEqual(found, [(['pnpm', '--filter', './packages/*', 'run', 'lint'], '.'),
                                 (['pnpm', '--filter', './packages/*', 'run', 'test'], '.'),
                                 (['go', 'vet', './...'], 'apps/api')])

    def test_workflow_parser_handles_scalar_and_block_runs(self):
        steps = cigaps.parse_workflow(job('      - run: pnpm format:check\n      - name: x\n        working-directory: apps/api\n'
                                          '        run: |\n          go vet ./...\n          go test ./...\n'))
        self.assertEqual([(s['run'], s['cwd']) for s in steps if s['run']],
                         [('pnpm format:check', '.'), ('go vet ./...\ngo test ./...', 'apps/api')])

    def test_dash_run_block_stops_before_sibling_keys(self):
        steps = cigaps.parse_workflow(job('      - run: |\n          go test ./...\n        working-directory: apps/api\n'
                                          '        env:\n          CI: 1\n'))
        self.assertEqual([(s['run'], s['cwd']) for s in steps if s['run']], [('go test ./...', 'apps/api')])


class SoftStepTests(unittest.TestCase):
    def test_pipe_true_and_colon_are_soft_per_statement(self):
        found = cigaps.shell_commands('pnpm lint || true\npnpm test || :\npnpm build\npnpm a && pnpm b || true\npnpm c; pnpm d || true\n', True)
        self.assertEqual([(a[-1] if len(a) == 2 else a[1] + ' ' + a[-1], bool(soft)) for a, _, soft in found],
                         [('lint', True), ('test', True), ('build', False), ('a', True), ('b', True), ('c', False), ('d', True)])
        self.assertTrue(cigaps.shell_commands('pnpm lint || echo failed\n', True)[0][2])  # L1: any `||` alternative is soft

    def test_scripts_are_verification_commands(self):
        found = cigaps.shell_commands('./verify-enterprise.sh --ci\nbash scripts/x.sh\nbash ./verify-enterprise.sh --quick\n')
        self.assertEqual([a for a, _ in found], [['./verify-enterprise.sh', '--ci'], ['bash', 'scripts/x.sh'], ['bash', './verify-enterprise.sh', '--quick']])
        self.assertEqual(cigaps.canonical(['./verify-enterprise.sh', '--quick']), ['bash', './verify-enterprise.sh', '--quick'])

    def test_step_flags_and_job_needs_are_parsed(self):
        text = ('jobs:\n  a:\n    steps:\n      - run: pnpm lint\n        continue-on-error: true\n'
                '      - run: pnpm test\n        if: ${{ false }}\n      - run: pnpm build\n        if: steps.app.outputs.present == \'true\'\n'
                '      - run: pnpm x\n        continue-on-error: false\n  required:\n    needs: [a, b]\n    steps:\n      - run: echo\n'
                '  c:\n    needs:\n      - a # comment\n      - "b"\n    steps:\n      - run: pnpm y\n  d:\n    needs: c\n    steps:\n      - run: pnpm z\n')
        steps = cigaps.parse_workflow(text)
        self.assertEqual([(s['run'], bool(s['soft'])) for s in steps if s['job'] == 'a'],
                         [('pnpm lint', True), ('pnpm test', True), ('pnpm build', False), ('pnpm x', False)])
        self.assertEqual(cigaps.parse_needs(text), {'a': [], 'required': ['a', 'b'], 'c': ['a', 'b'], 'd': ['c']})

    def test_soft_steps_do_not_cover_and_guards_do(self):
        with fixture() as root:
            body = ('      - run: pnpm --filter ./apps/web lint\n        continue-on-error: true\n'
                    '      - run: pnpm --filter ./apps/web build || true\n'
                    '      - run: pnpm --filter ./packages/lib lint\n        if: "false"\n'
                    '      - run: pnpm --filter ./packages/lib test\n        if: steps.app.outputs.present == \'true\'\n')
            setup(root, job(body))
            result = rows(root)
            self.assertEqual(find(result, 'harness->ci', 'apps/web lint')['class'], 'uncovered')
            self.assertIn('continue-on-error', find(result, 'harness->ci', 'apps/web lint')['detail'])
            self.assertEqual(find(result, 'harness->ci', 'apps/web build')['class'], 'uncovered')
            self.assertEqual(find(result, 'harness->ci', 'packages/lib lint')['class'], 'uncovered')
            self.assertEqual(find(result, 'harness->ci', 'packages/lib test')['class'], 'covered')
            self.assertEqual(find(result, 'ci->harness', 'pnpm @apps/web lint')['class'], 'soft')
            self.assertEqual(find(result, 'ci->harness', 'pnpm @packages/lib test')['class'], 'targeted')
            self.assertEqual(run_main(['--strict'])[0], 1)

    def test_soft_gate_is_not_domain_gate_cover(self):
        with fixture() as root:
            setup(root, job('      - run: pnpm format:check || true\n'), [domain('repo', ['*'], [['pnpm', 'format:check']])])
            self.assertEqual(find(rows(root), 'harness->ci', 'repo: pnpm format:check')['class'], 'uncovered')

    def test_not_required_detail_tells_a_missing_need_from_an_unevaluated_result(self):
        with fixture() as root:
            workflow = ('name: CI\njobs:\n  lint:\n    steps:\n      - run: pnpm --filter ./apps/web lint\n'
                        '  unchecked:\n    steps:\n      - run: pnpm --filter ./packages/lib test\n'
                        '  outside:\n    steps:\n      - run: pnpm --filter ./packages/lib lint\n'
                        '  required:\n    if: always()\n    needs:\n      - lint\n      - unchecked\n    steps:\n      - run: echo ${{ needs.lint.result }}\n')
            setup(root, workflow)
            result = rows(root)
            unchecked = find(result, 'harness->ci', 'packages/lib test')
            self.assertEqual(unchecked['class'], 'not-required')
            self.assertIn('is in the needs of', unchecked['detail'])
            self.assertIn('needs.unchecked.result` is not evaluated', unchecked['detail'])
            outside = find(result, 'harness->ci', 'packages/lib lint')
            self.assertIn('is not in the needs of', outside['detail'])
            self.assertNotIn('not evaluated', outside['detail'])

    def test_covering_job_must_be_required(self):
        with fixture() as root:
            workflow = ('name: CI\njobs:\n  lint:\n    steps:\n      - run: pnpm --filter ./apps/web lint\n'
                        '  build:\n    steps:\n      - run: pnpm --filter ./apps/web build\n'
                        '  slow:\n    needs: build\n    steps:\n      - run: pnpm --filter ./packages/lib lint\n'
                        '  required:\n    if: always()\n    needs:\n      - lint\n      - slow\n    steps:\n      - run: echo ${{ needs.lint.result }} ${{ needs.slow.result }}\n'
                        '  extra:\n    steps:\n      - run: pnpm --filter ./packages/lib test\n')
            setup(root, workflow)
            result = rows(root)
            self.assertEqual(find(result, 'harness->ci', 'apps/web lint')['class'], 'covered')
            self.assertEqual(find(result, 'harness->ci', 'apps/web build')['class'], 'covered')  # transitive need of `slow`
            self.assertEqual(find(result, 'harness->ci', 'packages/lib lint')['class'], 'covered')
            gap = find(result, 'harness->ci', 'packages/lib test')
            self.assertEqual((gap['class'], gap['where']), ('not-required', 'ci.yml:extra'))
            self.assertIn('is not in the needs of', gap['detail'])
            self.assertEqual(run_main(['--strict'])[0], 1)
            code, out = run_main(['--strict', '--json'])
            self.assertEqual(json.loads(out)['summary']['notRequired'], 1)
            # Without a `required` job there is nothing to enforce.
            setup(root, workflow.replace('required:', 'gate:'))
            self.assertEqual(find(rows(root), 'harness->ci', 'packages/lib test')['class'], 'covered')


class ParityTests(unittest.TestCase):
    def test_classification_of_ci_commands(self):
        with fixture() as root:
            body = ('      - run: pnpm install --frozen-lockfile\n      - run: pnpm format:check\n'
                    '      - run: pnpm --filter ./apps/web lint\n      - run: pnpm --filter ./apps/web build\n'
                    '      - run: go test -race ./...\n        working-directory: apps/api\n'
                    '      - run: python3 scripts/unknown.py\n')
            setup(root, job(body), [domain('repo', ['*'], [['pnpm', 'format:check'], ['pnpm', '--dir', 'apps/web', 'build']])])
            result = rows(root)
            classes = {r['item']: r['class'] for r in result if r['direction'] == 'ci->harness'}
            self.assertEqual(classes['pnpm install --frozen-lockfile'], 'ignored')
            self.assertEqual(classes['pnpm format:check'], 'domain-gate')
            self.assertEqual(classes['pnpm @apps/web build'], 'domain-gate')
            self.assertEqual(classes['pnpm @apps/web lint'], 'targeted')
            self.assertEqual(classes['go -C apps/api test -race ./...'], 'ci-only')
            self.assertEqual(classes['python3 scripts/unknown.py'], 'uncovered')

    def test_harness_ci_gaps_strict_step_matches_declared_gate(self):
        with fixture() as root:
            gate = ['pnpm', 'harness:ci-gaps', '--', '--strict']
            setup(root, job('      - run: pnpm harness:ci-gaps -- --strict\n'),
                  [domain('repo', ['*'], [gate]), domain('infra', ['.github/**'], [gate])])
            result = rows(root)
            self.assertEqual(find(result, 'ci->harness', 'harness ci-gaps -- --strict')['class'], 'domain-gate')
            self.assertEqual(find(result, 'harness->ci', 'repo: pnpm harness:ci-gaps -- --strict')['class'], 'covered')
            self.assertEqual(find(result, 'harness->ci', 'infra: pnpm harness:ci-gaps -- --strict')['class'], 'covered')

    def test_multiline_block_with_chain_and_env_prefix(self):
        with fixture() as root:
            body = '      - shell: bash\n        run: |\n          set -e\n          CI=1 pnpm --filter ./apps/web lint && pnpm --filter ./apps/web build\n'
            setup(root, job(body))
            result = rows(root)
            self.assertEqual(find(result, 'harness->ci', 'apps/web lint')['class'], 'covered')
            self.assertEqual(find(result, 'harness->ci', 'apps/web build')['class'], 'covered')

    def test_workspace_script_missing_from_ci_is_uncovered(self):
        with fixture() as root:
            setup(root, job('      - run: pnpm --filter ./apps/web lint\n'))
            result = rows(root)
            self.assertEqual(find(result, 'harness->ci', 'apps/web lint')['class'], 'covered')
            self.assertEqual(find(result, 'harness->ci', 'apps/web build')['class'], 'uncovered')
            self.assertEqual(find(result, 'harness->ci', 'packages/lib test')['class'], 'uncovered')

    def test_dynamic_discovery_job_covers_packages(self):
        with fixture() as root:
            body = ('      - shell: bash\n        run: |\n          for package in packages/*/package.json; do\n'
                    '            dir="$(dirname "$package")"\n            for script in lint typecheck test test:critical build; do\n'
                    '              pnpm --filter "./${dir}" run "${script}"\n            done\n          done\n')
            setup(root, job(body, 'packages'))
            result = rows(root)
            self.assertEqual(find(result, 'harness->ci', 'packages/lib lint')['where'], 'ci.yml:packages')
            self.assertEqual(find(result, 'harness->ci', 'packages/lib test')['class'], 'covered')
            self.assertEqual(find(result, 'harness->ci', 'apps/web lint')['class'], 'uncovered')
            self.assertEqual(find(result, 'ci->harness', 'pnpm @packages/* build')['class'], 'targeted')

    def test_gates_local_only_and_enabled_app_domains(self):
        with fixture() as root:
            gates = [['bash', './verify-enterprise.sh', '--quick'], ['pnpm', '--dir', 'apps/web', 'lint'], ['pnpm', 'e2e']]
            setup(root, job('      - run: pnpm --filter ./apps/web lint\n'),
                  [domain('web', ['apps/web/**'], gates), domain('ghost', ['apps/ghost/**'], [], True),
                   domain('off', ['apps/off/**'], [], False)])
            result = rows(root)
            self.assertEqual(find(result, 'harness->ci', 'web: bash ./verify-enterprise.sh --quick')['class'], 'local-only')
            self.assertEqual(find(result, 'harness->ci', 'web: pnpm --dir apps/web lint')['class'], 'covered')
            self.assertEqual(find(result, 'harness->ci', 'web: pnpm e2e')['class'], 'uncovered')
            self.assertEqual(find(result, 'harness->ci', 'web: apps/web')['class'], 'covered')
            self.assertEqual(find(result, 'harness->ci', 'ghost: apps/ghost')['class'], 'uncovered')
            self.assertFalse([r for r in result if r['item'].startswith('off:')])

    def test_strict_exit_codes_and_json(self):
        with fixture() as root:
            setup(root, job('      - run: pnpm --filter ./apps/web lint\n'))
            self.assertEqual(run_main([])[0], 0)
            code, out = run_main(['--strict', '--json'])
            self.assertEqual(code, 1)
            self.assertGreater(json.loads(out)['summary']['uncovered'], 0)
            setup(root, job('      - run: pnpm --filter ./apps/web lint\n      - run: pnpm --filter ./apps/web build\n'
                            '      - run: pnpm --filter ./packages/lib lint\n      - run: pnpm --filter ./packages/lib test\n'))
            self.assertEqual(run_main(['--strict'])[0], 0)
            with self.assertRaises(ValueError):
                cigaps.main(['--bogus'])


class ManifestTests(unittest.TestCase):
    def test_invalid_manifest_rejected_by_loader_and_check(self):
        with fixture() as root:
            good = json.loads((root / '.harness/manifests/ci-parity.json').read_text(encoding='utf-8'))
            for bad in [{**good, 'ciOnly': [{'match': 'go test'}]}, {**good, 'ignored': [{'match': '', 'reason': 'x'}]},
                        {**good, 'localOnly': [{'match': 'x', 'reason': 'y', 'extra': 1}]},
                        {k: v for k, v in good.items() if k != 'ignored'}]:
                write(root, '.harness/manifests/ci-parity.json', json.dumps(bad))
                with self.assertRaisesRegex(ValueError, 'ci-parity.json'):
                    cigaps.load_manifest()
                for item in ['README.md', 'cli.py']:
                    write(root, '.harness/' + item)
                for item in ['agents', 'core', 'tasks/inbox', 'logs/execution', 'logs/errors', 'logs/audit', 'logs/completed']:
                    (root / '.harness' / item).mkdir(parents=True, exist_ok=True)
                with patch.object(check, 'H', root / '.harness'), patch.object(check, 'ROOT', root):
                    with self.assertRaisesRegex(ValueError, 'Manifest ci-parity.json inválido'):
                        check.check()

    def test_real_manifest_exceptions_are_narrow(self):
        with fixture():
            def klass(command):
                tokens = cigaps.canonical(command)
                return ('ignored' if cigaps.first_entry(manifest['ignored'], tokens) else 'ci-only' if cigaps.first_entry(manifest['ciOnly'], tokens)
                        else 'local-only' if cigaps.first_entry(manifest['localOnly'], tokens) else 'none')
            manifest = cigaps.load_manifest()
            probe = 'const p=require("./x/package.json"); process.exit(p.scripts?.dev ? 0 : 1)'
            self.assertEqual(klass(['node', '-e', probe]), 'ignored')
            self.assertEqual(klass(['node', '-e', 'require("child_process").execSync("make deploy")']), 'none')
            self.assertEqual(klass(['node', '-e', 'process.exit(1)']), 'none')
            go = lambda *a: ['go', '-C', 'apps/api', 'test', *a]
            self.assertEqual(klass(go('./internal/platform/mailer', '-run=TestSMTPMailpitDelivery', '-count=1')), 'ci-only')
            self.assertEqual(klass(go('./internal/app', '-run', '^(TestDomainPostgresE2E|TestUserAdministrationPostgresHTTPAcceptance)$')), 'ci-only')
            self.assertEqual(klass(go('./...', '-run=TestSomethingElse')), 'none')
            self.assertEqual(klass(go('./...')), 'none')
            modes = {m: klass(['bash', './verify-enterprise.sh', m]) for m in ['--quick', '--security', '--full']}
            self.assertEqual(set(modes.values()), {'local-only'})
            self.assertEqual(klass(['bash', './verify-enterprise.sh', '--runtime']), 'none')
            self.assertEqual(klass(['bash', './verify-enterprise.sh']), 'none')

    def test_real_manifest_entries_have_reasons(self):
        manifest = json.loads((Path(__file__).resolve().parents[2] / 'manifests/ci-parity.json').read_text(encoding='utf-8'))
        for section in ['ignored', 'ciOnly', 'localOnly']:
            for entry in manifest[section]:
                self.assertTrue(entry['reason'].strip())


if __name__ == '__main__':
    unittest.main()
