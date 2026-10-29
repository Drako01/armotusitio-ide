"""Dependency-graph verification: impact selection, honest execution states and routing; no network, no provider."""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture
from gitenv import git_run
import subprocess
from core import config, context, routing, runner, tasks, verification, impact


def write(root, name, text=''):
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding='utf-8')


def package(root, directory, name, scripts, deps=None):
    write(root, directory + '/package.json', json.dumps({'name': name, 'scripts': {s: 'x ' + s for s in scripts}, 'dependencies': deps or {}}))


def js_fixture(root):
    package(root, 'packages/x', '@t/x', ['lint', 'test'])
    write(root, 'packages/x/package.json', json.dumps({'name': '@t/x', 'scripts': {'lint': 'l', 'test': 't', 'test:critical': 't'}}))
    package(root, 'apps/y', '@t/y', ['typecheck', 'build'], {'@t/x': 'workspace:*'})
    package(root, 'apps/z', '@t/z', ['lint'])
    write(root, 'packages/x/src/a.ts')
    write(root, 'apps/api/go.mod', 'module example.test/api\n')


def argvs(checks):
    return [verification.argv(c) for c in checks]


def go_json(root, graph):
    base = root / 'apps/api'
    items = []
    for path, (directory, deps) in graph.items():
        items.append({'ImportPath': path, 'Dir': str(base / directory) if directory else '/usr/local/go/src/' + path,
                      'Deps': deps, **({} if directory else {'DepOnly': True})})
    return '\n'.join(json.dumps(i) for i in items)


class ImpactTests(unittest.TestCase):
    def test_js_reverse_dependents_order_and_dedup(self):
        with fixture() as root:
            js_fixture(root)
            checks = impact.targeted_checks(['packages/x/src/a.ts'])
            self.assertEqual(argvs(checks), [
                ['pnpm', '--filter', './packages/x', 'lint'], ['pnpm', '--filter', './packages/x', 'test'],
                ['pnpm', '--filter', './apps/y', 'typecheck'], ['pnpm', '--filter', './apps/y', 'build']])
            self.assertTrue(all(c['tier'] == 'targeted' and c['requires'] == ['pnpm', 'node_modules'] for c in checks))
            self.assertIn('depends on @t/x', checks[2]['reason'])
            self.assertNotIn('apps/z', json.dumps(checks))

    def test_lockfile_and_deleted_paths(self):
        with fixture() as root:
            js_fixture(root)
            self.assertEqual(len({c['command'][2] for c in impact.targeted_checks(['pnpm-lock.yaml'])}), 3)
            self.assertEqual(len({c['command'][2] for c in impact.targeted_checks(['packages/x/src/deleted.ts'])}), 2)
            # A removed workspace directory cannot be traced to its dependents: fail wide.
            with patch.object(impact, 'had_package', return_value=True):
                self.assertEqual(len({c['command'][2] for c in impact.targeted_checks(['packages/gone/src/a.ts'])}), 3)
            self.assertEqual(impact.targeted_checks(['packages/gone/src/a.ts']), [])  # never a workspace in the base: nothing to widen

    def test_go_graph_maps_non_go_files_and_test_deps(self):
        with fixture() as root:
            js_fixture(root)
            write(root, 'apps/api/internal/a/a.go')
            write(root, 'apps/api/internal/a/q.sql')
            text = go_json(root, {
                'example.test/api/internal/a': ('internal/a', ['fmt']),
                'example.test/api/internal/b': ('internal/b', ['example.test/api/internal/a']),
                'example.test/api/internal/c': ('internal/c', ['fmt']),
                'example.test/api/internal/c [example.test/api/internal/c.test]': ('internal/c', ['example.test/api/internal/a']),
                'fmt': ('', [])})
            with patch.object(impact, 'go_list_json', return_value=text):
                checks = impact.targeted_checks(['apps/api/internal/a/q.sql', 'apps/api/internal/a/a.go', 'apps/api/internal/a/old.go'])
            self.assertEqual(argvs(checks)[0], ['gofmt', '-l', '--', 'apps/api/internal/a/a.go'])
            self.assertTrue(checks[0]['failOnOutput'])
            self.assertEqual(argvs(checks)[1:], [['go', '-C', 'apps/api', 'vet', './internal/a', './internal/b', './internal/c'],
                                                 ['go', '-C', 'apps/api', 'test', './internal/a', './internal/b', './internal/c']])
            with patch.object(impact, 'go_list_json', return_value=text):
                leaf = argvs(impact.targeted_checks(['apps/api/internal/b/x.sql']))
            self.assertEqual(leaf[0], ['go', '-C', 'apps/api', 'vet', './internal/b'])

    def test_go_mod_all_and_unavailable_graph_fallback(self):
        with fixture() as root:
            js_fixture(root)
            checks = impact.targeted_checks(['apps/api/go.mod'])
            self.assertEqual(argvs(checks), [['go', '-C', 'apps/api', 'vet', './...'], ['go', '-C', 'apps/api', 'test', './...']])
            write(root, 'apps/api/internal/a/a.go')
            with patch.object(impact, 'go_list_json', side_effect=ValueError('go list failed with exit 1')):
                checks = impact.targeted_checks(['apps/api/internal/a/a.go'])
            self.assertIn('falling back to ./...', checks[-1]['reason'])
            self.assertEqual(argvs(checks)[-1], ['go', '-C', 'apps/api', 'test', './...'])

    def test_infra_and_agent_configuration(self):
        with fixture() as root:
            for name in ['start.sh', 'infra/docker/compose.verify.yml', '.github/workflows/ci.yml', 'AGENTS.md', '.codex/skills/a/SKILL.md']:
                write(root, name)
            commands = argvs(impact.targeted_checks(['start.sh', 'infra/docker/compose.verify.yml', '.github/workflows/ci.yml', 'AGENTS.md', '.codex/skills/a/SKILL.md', 'gone.sh']))
            self.assertEqual(commands, [['bash', '-n', '--', 'start.sh'], ['docker', 'compose', '-f', './infra/docker/compose.verify.yml', 'config', '--quiet'],
                                        ['pnpm', 'exec', 'prettier', '--check', '--', '.github/workflows/ci.yml'], ['pnpm', 'agent-config:check']])

    def test_plan_tiers_order_dedup_and_no_execution(self):
        with fixture() as root:
            js_fixture(root)
            with patch.object(runner, 'spawn_run') as spawn:
                plan = verification.verify_plan(files=['packages/x/src/a.ts'])
                text = verification.render_plan(plan)
            spawn.assert_not_called()
            self.assertFalse(plan['validated'])
            tiers = [c['tier'] for c in plan['checks']]
            self.assertEqual(tiers, sorted(tiers, key=['targeted', 'authoritative'].index))
            self.assertEqual(len(argvs(plan['checks'])), len({tuple(c) for c in argvs(plan['checks'])}))
            self.assertIn('[targeted] pnpm --filter ./packages/x lint', text)
            self.assertIn('reason:', text)
            json.dumps(plan)

    def test_security_escalation_preserved(self):
        with fixture() as root:
            js_fixture(root)
            plan = verification.verify_plan(files=['apps/api/internal/auth/token.go'])
            commands = argvs(plan['checks'])
            self.assertIn(['bash', './verify-enterprise.sh', '--security'], commands)
            self.assertNotIn(['bash', './verify-enterprise.sh', '--quick'], commands)


class GoListTests(unittest.TestCase):
    def test_environment_is_inherited_and_only_goproxy_defaults(self):
        with patch.dict(os.environ, {}, clear=False) as env, patch.object(runner, 'spawn_run', return_value={'code': 0, 'out': '{}', 'err': ''}) as spawn:
            env.pop('GOPROXY', None)
            env['GOTOOLCHAIN'] = 'auto'
            impact.go_list_json()
            options = spawn.call_args.args[2]
            self.assertEqual(options['env'], {'GOPROXY': 'off'})  # never GOTOOLCHAIN: same toolchain as the later go test
            self.assertTrue(options['raw'] and options['structured'] and options['persist'] is False)
            env['GOPROXY'] = 'https://proxy.example.test'
            impact.go_list_json()
            self.assertEqual(spawn.call_args.args[2]['env'], {})

    def test_failure_reason_carries_sanitized_last_stderr_line(self):
        stderr = 'go: downloading\ngo: toolchain not available token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\x1b[0m\n'
        with patch.object(runner, 'spawn_run', return_value={'code': 1, 'out': '', 'err': stderr}):
            with self.assertRaises(ValueError) as caught:
                impact.go_list_json()
        message = str(caught.exception)
        self.assertIn('go list failed with exit 1: go: toolchain not available', message)
        self.assertNotIn('ghp_', message)
        self.assertNotIn('\x1b', message)
        self.assertNotIn('downloading', message)
        with fixture() as root:
            js_fixture(root)
            write(root, 'apps/api/internal/a/a.go')
            with patch.object(impact, 'go_list_json', side_effect=ValueError(message)):
                reason = impact.targeted_checks(['apps/api/internal/a/a.go'])[-1]['reason']
            self.assertIn('go: toolchain not available', reason)
            self.assertIn('falling back to ./...', reason)


class WorkspaceDiscoveryTests(unittest.TestCase):
    def test_pnpm_workspace_globs_are_respected(self):
        with fixture() as root:
            package(root, 'apps/a', '@t/a', ['lint'])
            package(root, 'tooling/t', '@t/t', ['lint'])
            package(root, 'extras/e', '@t/e', ['lint'])
            self.assertEqual(sorted(impact.js_workspaces()), ['apps/a'])  # no pnpm-workspace.yaml: defaults apps/* and packages/*
            write(root, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - \'tooling/*\'\n  - "!tooling/skip"\nallowBuilds:\n  esbuild: false\n')
            self.assertEqual(sorted(impact.js_workspaces()), ['apps/a', 'tooling/t'])
            checks = impact.targeted_checks(['tooling/t/src/x.ts'])
            self.assertEqual(argvs(checks), [['pnpm', '--filter', './tooling/t', 'lint']])
            with patch.object(impact, 'had_package', return_value=True):
                self.assertEqual(len({c['command'][2] for c in impact.targeted_checks(['tooling/gone/src/x.ts'])}), 2)  # removed workspace: fail wide

    def test_agent_configuration_check_triggers(self):
        with fixture() as root:
            for name in ['scripts/check-agent-config-sync.mjs', '.gitignore']:
                write(root, name)
                self.assertEqual(argvs(impact.targeted_checks([name])), [['pnpm', 'agent-config:check']], name)


def plan_of(*commands, requires=None):
    return {'checks': [{'command': c, 'tier': 'targeted' if i == 0 else 'authoritative', 'reason': 'test', 'requires': requires or []}
                       for i, c in enumerate(commands)], 'risk': 'LOW', 'domains': []}


class ExecutionTests(unittest.TestCase):
    def test_partial_when_tool_missing_is_not_success(self):
        with fixture() as root:
            ok = [sys.executable, '-B', '-c', 'pass']
            plan = plan_of(ok, [sys.executable, '-B', '-c', 'pass#2'])
            plan['checks'][1]['requires'] = ['docker']
            with patch.object(verification.shutil, 'which', side_effect=lambda n: None if n == 'docker' else '/bin/' + n):
                summary = verification.run_plan(plan, 20000)
            self.assertEqual(summary['status'], 'PARTIAL')
            self.assertEqual(verification.EXIT['PARTIAL'], 3)
            self.assertEqual([c['status'] for c in summary['checks']], ['PASS', 'SKIPPED_ENVIRONMENT'])
            self.assertIn('docker', summary['checks'][1]['skipReason'])
            saved = json.loads((root / '.harness/runtime/verify-last.json').read_text())
            self.assertEqual(saved['status'], 'PARTIAL')
            report = verification.render_report(saved)
            self.assertLess(report.index('Skipped'), report.index('Passed'))

    def test_failing_check_is_never_reclassified_as_environment(self):
        with fixture():
            plan = plan_of([sys.executable, '-B', '-c', 'import sys; print("docker: command not found"); sys.exit(127)'])
            summary = verification.run_plan(plan, 20000)
            self.assertEqual(summary['status'], 'FAIL')
            self.assertEqual(summary['checks'][0]['status'], 'FAIL')

    def test_keep_going_reports_every_failure_and_default_stops(self):
        with fixture():
            fail = lambda n: [sys.executable, '-B', '-c', f'import sys; print("boom{n}"); sys.exit({n})']
            plan = plan_of(fail(2), fail(3), [sys.executable, '-B', '-c', 'pass'])
            stopped = verification.run_plan(plan, 20000)
            self.assertEqual([c['status'] for c in stopped['checks']], ['FAIL', 'NOT_RUN', 'NOT_RUN'])
            summary = verification.run_plan(plan, 20000, keep_going=True)
            self.assertEqual([c['status'] for c in summary['checks']], ['FAIL', 'FAIL', 'PASS'])
            self.assertEqual(summary['status'], 'FAIL')
            report = verification.render_report(summary)
            self.assertLess(report.index('Failures'), report.index('Passed'))
            self.assertIn('boom2', report)
            self.assertIn('boom3', report)

    def test_fast_runs_only_targeted_and_declares_it(self):
        with fixture():
            summary = verification.run_plan(plan_of([sys.executable, '-B', '-c', 'pass'], [sys.executable, '-B', '-c', 'raise SystemExit(1)']), 20000, fast=True)
            self.assertEqual(len(summary['checks']), 1)
            self.assertFalse(summary['authoritative'])
            self.assertIn('NOT the authoritative', summary['notice'])

    def test_fail_on_output_check(self):
        with fixture():
            item = {'command': [sys.executable, '-B', '-c', 'print("unformatted.go")'], 'tier': 'targeted', 'reason': 't', 'requires': [], 'failOnOutput': True}
            self.assertEqual(verification.execute_check(item, 20000)['status'], 'FAIL')

    def test_verifier_blocks_on_skipped_environment(self):
        from core import delegation
        with fixture():
            task = tasks.make_task('docs', 'Actualizar documentación')
            node = next(n for n in task['dag'] if n['agent'] == 'verifier')
            node.update(status='running', attempts=1)
            with patch.object(verification, 'changed_files', return_value=['docs/guide.md']), \
                    patch.object(verification.shutil, 'which', return_value=None), patch.object(delegation, 'spawn_run') as spawn:
                self.assertFalse(delegation.run_deterministic(task, node, {'estimatedTokens': 1}))
            spawn.assert_not_called()
            self.assertEqual(node['status'], 'blocked')
            handoff = json.loads(next((config.H / 'handoffs').glob('*verifier-1.json')).read_text())
            self.assertEqual(handoff['status'], 'blocked')
            self.assertIn('SKIPPED_ENVIRONMENT', handoff['risks'][0])


class RoutingTests(unittest.TestCase):
    def test_unsupported_apps_derive_from_manifest(self):
        with fixture():
            domains = context.manifests()['domains']
            self.assertEqual(routing.infer_domains('Implementar pantalla provider-portal nueva', domains), ['provider-portal'])
            self.assertEqual(routing.infer_domains('Implementar pantalla sales-portal nueva', domains), ['sales-portal'])
            with self.assertRaisesRegex(ValueError, 'unsupported'):
                routing.infer_domains('Implementar pantalla marketplace nueva', domains)
            manifest = config.H / 'manifests/domains.json'
            data = json.loads(manifest.read_text())
            next(d for d in data['domains'] if d['domain'] == 'provider-portal')['enabled'] = False
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'unsupported'):
                routing.infer_domains('Implementar pantalla provider-portal nueva', context.manifests()['domains'])


if __name__ == '__main__':
    unittest.main()


class DeduplicationTests(unittest.TestCase):
    def test_canonical_dedup_keeps_the_targeted_check_once(self):
        with fixture() as root:
            js_fixture(root)
            targeted = [impact.check(['pnpm', '--filter', './apps/y', 'build'], 'targeted', 'targeted reason', ['pnpm'])]
            gates = [verification.authoritative(['pnpm', '--dir', 'apps/y', 'build'], 'declared'),
                     verification.authoritative(['pnpm', '--filter', '@t/y', 'typecheck'], 'declared'),
                     verification.authoritative(['pnpm', '--filter', './apps/y', 'build'], 'declared')]
            merged = verification.merge(targeted, gates)
            self.assertEqual(argvs(merged), [['pnpm', '--filter', './apps/y', 'build'], ['pnpm', '--filter', '@t/y', 'typecheck']])
            self.assertEqual(merged[0]['tier'], 'targeted')
            self.assertIn('pnpm --dir apps/y build', merged[0]['reason'])

    def test_go_vet_and_test_only_run_with_fast_when_enterprise_verifier_is_planned(self):
        with fixture() as root:
            js_fixture(root)
            write(root, 'apps/api/internal/a/a.go')
            with patch.object(impact, 'go_list_json', side_effect=ValueError('go list failed with exit 1')):
                plan = verification.verify_plan(files=['apps/api/internal/a/a.go'])
            every = argvs(plan['checks'])
            self.assertIn(['go', '-C', 'apps/api', 'test', './...'], every)
            (root / 'node_modules').mkdir()
            with patch.object(verification.shutil, 'which', return_value='/bin/tool'):
                standard = argvs(verification.selected(plan))
            self.assertIn(['bash', './verify-enterprise.sh', '--quick'], standard)
            self.assertFalse([c for c in standard if c[0] in ('go', 'gofmt')])  # M5: gofmt is covered like vet/test
            # M1: when the verifier cannot run here, what it covers is kept.
            with patch.object(verification.shutil, 'which', side_effect=lambda n: None if n == 'bash' else '/bin/' + n):
                self.assertIn(['gofmt', '-l', '--', 'apps/api/internal/a/a.go'], argvs(verification.selected(plan)))
            fast = argvs(verification.selected(plan, True))
            self.assertIn(['go', '-C', 'apps/api', 'vet', './...'], fast)
            self.assertNotIn(['bash', './verify-enterprise.sh', '--quick'], fast)
            self.assertIn('only with --fast', verification.render_plan(plan))
            # Without the enterprise verifier in the plan (e.g. an unrelated domain), nothing is hidden.
            alone = {'checks': [c for c in plan['checks'] if c['tier'] == 'targeted']}
            self.assertEqual(argvs(verification.selected(alone)), argvs(alone['checks']))


class EnterpriseSkipTests(unittest.TestCase):
    def report(self, directory, **overrides):
        directory.mkdir(parents=True, exist_ok=True)
        steps = overrides.pop('checks', [{'status': 'PASS', 'duration_seconds': 1, 'name': 'Format'},
                                         {'status': 'SKIP', 'duration_seconds': 0, 'name': 'golangci-lint'},
                                         {'status': 'SKIP', 'duration_seconds': 0, 'name': 'govulncheck'}])
        skips = len([c for c in steps if isinstance(c, dict) and c['status'] == 'SKIP'])
        data = {'schema_version': 1, 'mode': 'security', 'git': {'sha': verification.head()},
                'summary': {'pass': 1, 'fail': 0, 'warn': skips, 'skip': skips}, 'checks': steps, **overrides}
        (directory / 'verification-report.json').write_text(json.dumps(data), encoding='utf-8')

    def item(self, mode='--security'):
        return verification.authoritative(['bash', './verify-enterprise.sh', mode], 'gate')

    def run_item(self, root, item, writer=None, code=0, seen=None):
        def spawn(cmd, args, options):
            directory = Path(options['env']['REDEVENT_VERIFY_REPORT_DIR'])
            if seen is not None:
                seen.append(directory)
            if writer:
                writer(directory)
            return {'code': code, 'out': 'ok', 'err': '', 'durationMs': 1}
        with patch.object(verification.shutil, 'which', return_value='/bin/tool'):
            return verification.execute_check(item, 1000, spawn=spawn)

    def test_requires_do_not_include_optional_linters(self):
        for mode in ['--quick', '--security', '--full', '']:
            requires = verification.requires_for(['bash', './verify-enterprise.sh', mode] if mode else ['bash', './verify-enterprise.sh'])
            self.assertEqual(requires, ['bash', 'go', 'pnpm', 'node_modules'], mode)  # M1: skips come from the structured report
        self.assertEqual(verification.requires_for(['bash', './docker-verify-enterprise.sh']), ['bash', 'docker'])

    def test_skipped_steps_in_structured_report_make_the_check_skipped(self):
        with fixture() as root:
            (root / 'node_modules').mkdir()
            result = self.run_item(root, self.item(), lambda d: self.report(d))
            self.assertEqual(result['status'], verification.SKIPPED)
            self.assertEqual(result['exit'], 0)
            self.assertIn('golangci-lint; govulncheck', result['skipReason'])
            self.assertEqual(verification.overall([result]), 'PARTIAL')

    def test_missing_golangci_lint_keeps_enterprise_and_covered_checks_running(self):
        with fixture() as root:
            (root / 'node_modules').mkdir()
            enterprise = self.item('--quick')
            covered = {**verification.authoritative(['go', '-C', 'apps/api', 'vet', './...'], 'x'), 'tier': 'targeted', 'coveredBy': 'verify-enterprise.sh'}
            plan = {'checks': [covered, enterprise]}
            which = lambda name: None if name == 'golangci-lint' else '/bin/' + name
            with patch.object(verification.shutil, 'which', side_effect=which):
                self.assertEqual(verification.missing_tools(enterprise), '')
                self.assertEqual(argvs(verification.selected(plan)), [argvs([enterprise])[0]])
            # If the covering verifier itself cannot run (go missing), what it covers is kept.
            with patch.object(verification.shutil, 'which', side_effect=lambda n: None if n == 'bash' else '/bin/' + n):
                self.assertEqual(len(verification.selected({'checks': [{**covered, 'requires': []}, enterprise]})), 2)

    def test_clean_report_passes_and_invalid_reports_fail_closed(self):
        with fixture() as root:
            (root / 'node_modules').mkdir()
            clean = [{'status': 'PASS', 'duration_seconds': 1, 'name': 'Format'}]
            self.assertEqual(self.run_item(root, self.item(), lambda d: self.report(d, checks=clean))['status'], verification.PASS)
            missing = self.run_item(root, self.item())
            # The real exit code of the process is kept; the report problem travels in `error`.
            self.assertEqual((missing['status'], missing['exit']), (verification.FAIL, 0))
            self.assertIn('missing or unreadable', missing['error'])
            for writer, text in [(lambda d: (d.mkdir(parents=True, exist_ok=True), (d / 'verification-report.json').write_text('not json')), 'unreadable'),
                                 (lambda d: self.report(d, mode='quick'), 'mode'),
                                 (lambda d: self.report(d, summary={'pass': 1, 'fail': 0, 'skip': 5}), 'inconsistent'),
                                 (lambda d: self.report(d, checks='x'), 'invalid structure')]:
                result = self.run_item(root, self.item(), writer)
                self.assertEqual(result['status'], verification.FAIL, text)
                self.assertIn(text, result['error'])

    def test_every_run_has_its_own_report_directory_and_ignores_older_reports(self):
        with fixture() as root:
            (root / 'node_modules').mkdir()
            clean = [{'status': 'PASS', 'duration_seconds': 1, 'name': 'Format'}]
            shared = verification.report_dir()
            self.report(shared, checks=clean)  # an earlier run's report in the shared location
            seen = []
            first = self.run_item(root, self.item(), seen=seen)
            self.assertEqual(first['status'], verification.FAIL)  # nothing was written by THIS run
            self.run_item(root, self.item(), lambda d: self.report(d, checks=clean), seen=seen)
            self.assertEqual(len(set(seen)), 2)
            self.assertTrue(all(d.parent == shared for d in seen))

    def test_inherited_report_directory_does_not_leak_into_fixtures(self):
        with patch.dict(os.environ, {'REDEVENT_VERIFY_REPORT_DIR': '/somewhere/real', 'REDEVENT_VERIFY_STRICT': '1'}):
            with fixture() as root:
                self.assertNotIn('REDEVENT_VERIFY_REPORT_DIR', os.environ)
                self.assertNotIn('REDEVENT_VERIFY_STRICT', os.environ)
                self.assertEqual(verification.report_dir(), root / '.artifacts/verify-enterprise')
            self.assertEqual(os.environ['REDEVENT_VERIFY_REPORT_DIR'], '/somewhere/real')  # restored afterwards

    def test_only_the_most_recent_run_directories_are_kept(self):
        with fixture() as root:
            (root / 'node_modules').mkdir()
            parent = verification.report_dir()
            for index in range(8):
                run = parent / f'run-old{index}'
                run.mkdir(parents=True)
                os.utime(run, (1000 + index, 1000 + index))
            (parent / 'other').mkdir()
            (parent / 'run-file').write_text('x')
            elsewhere = root / 'elsewhere'
            elsewhere.mkdir()
            (elsewhere / 'keep.txt').write_text('x')
            (parent / 'run-link').symlink_to(elsewhere, target_is_directory=True)
            seen = []
            self.run_item(root, self.item(), seen=seen)
            names = sorted(e.name for e in parent.iterdir())
            kept = [n for n in names if n.startswith('run-old')]
            self.assertEqual(kept, ['run-old4', 'run-old5', 'run-old6', 'run-old7'][-(verification.KEEP_RUNS - 1):])
            self.assertTrue({'other', 'run-file', 'run-link'} <= set(names))  # only real run-* directories are touched
            self.assertTrue((elsewhere / 'keep.txt').exists())
            # The current run's own directory is never deleted, even when it is the oldest.
            current = parent / 'run-current'
            current.mkdir()
            os.utime(current, (1, 1))
            verification.prune_runs(parent, current)
            self.assertTrue(current.is_dir())
            self.assertEqual(len([e for e in parent.iterdir() if e.name.startswith('run-') and e.is_dir() and not e.is_symlink()]), verification.KEEP_RUNS)

    def test_report_commit_must_match_head(self):
        with fixture() as root:
            (root / 'node_modules').mkdir()
            clean = [{'status': 'PASS', 'duration_seconds': 1, 'name': 'Format'}]
            with patch.object(verification, 'head', return_value='a' * 40):
                missing = self.run_item(root, self.item(), lambda d: self.report(d, checks=clean, git={}))
                self.assertEqual(missing['status'], verification.FAIL)
                self.assertIn('expected HEAD', missing['error'])
                other = self.run_item(root, self.item(), lambda d: self.report(d, checks=clean, git={'sha': 'b' * 40, 'branch': 'x'}))
                self.assertEqual(other['status'], verification.FAIL)
                self.assertIn('expected HEAD', other['error'])
                same = self.run_item(root, self.item(), lambda d: self.report(d, checks=clean, git={'sha': 'a' * 40, 'branch': 'x'}))
                self.assertEqual(same['status'], verification.PASS)

    def test_failing_verifier_stays_fail_without_reading_the_report(self):
        with fixture() as root:
            (root / 'node_modules').mkdir()
            with patch.object(verification, 'enterprise_report') as read:
                self.assertEqual(self.run_item(root, self.item(), code=1)['status'], verification.FAIL)
            read.assert_not_called()


class EnvironmentTests(unittest.TestCase):
    def test_pnpm_checks_without_node_modules_are_skipped_not_failed(self):
        with fixture() as root:
            item = verification.authoritative(['pnpm', 'format:check'], 'gate')
            self.assertEqual(item['requires'], ['pnpm', 'node_modules'])
            with patch.object(verification.shutil, 'which', return_value='/bin/pnpm'), patch.object(runner, 'spawn_run') as spawn:
                result = verification.execute_check(item, 1000)
            spawn.assert_not_called()
            self.assertEqual(result['status'], verification.SKIPPED)
            self.assertIn('node_modules', result['skipReason'])
            (root / 'node_modules').mkdir()
            self.assertEqual(verification.tool_status('node_modules'), (True, ''))
            # Pure Node scripts do not need installed dependencies.
            self.assertEqual(verification.requires_for(['pnpm', 'agent-config:check']), ['pnpm'])
            self.assertEqual(verification.requires_for(['pnpm', 'harness:test']), ['pnpm'])


class EmptyAndStaleTests(unittest.TestCase):
    def test_non_empty_plan_with_nothing_executed_is_not_a_pass(self):
        with fixture() as root:
            plan = plan_of([sys.executable, '-B', '-c', 'pass'])
            plan['checks'][0]['tier'] = 'authoritative'
            summary = verification.run_plan(plan, 20000, fast=True)
            self.assertEqual((summary['status'], summary['checks']), ('EMPTY', []))
            self.assertIn('EMPTY', summary['notice'])
            self.assertNotEqual(verification.EXIT['EMPTY'], 0)
            empty = verification.run_plan(plan_of(), 20000)  # H1: a plan without checks verified nothing
            self.assertEqual(empty['status'], 'EMPTY')
            self.assertIn('--base', empty['notice'])
            self.assertEqual(verification.run_plan({**plan_of(), 'full': True}, 20000)['status'], 'PASS')  # --full keeps its own semantics

    def test_summary_records_head_changeset_and_fast_and_detects_staleness(self):
        with fixture() as root:
            git = lambda *a: git_run(root, *a)
            git('init')
            write(root, 'a.txt', 'one')
            git('add', '.')
            git('commit', '-m', 'base')
            summary = verification.run_plan(plan_of([sys.executable, '-B', '-c', 'pass']), 20000)
            saved = json.loads((root / '.harness/runtime/verify-last.json').read_text())
            self.assertEqual(saved['head'], summary['head'])
            self.assertFalse(saved['fast'])
            self.assertEqual(saved['changeSet']['count'], 0)
            self.assertIsNone(verification.staleness(saved))
            write(root, 'b.txt', 'new')
            self.assertIn('changed files', verification.staleness(saved))
            fresh = verification.run_plan(plan_of([sys.executable, '-B', '-c', 'pass']), 20000)
            self.assertIsNone(verification.staleness(fresh))
            write(root, 'b.txt', 'edited after the verification')  # same path set, different content
            self.assertIn('changed files', verification.staleness(fresh))
            git('add', '.')
            git('commit', '-m', 'more')
            self.assertIn('HEAD changed', verification.staleness(fresh))
            self.assertIn('older Harness', verification.staleness({'status': 'PASS'}))
