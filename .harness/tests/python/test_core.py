"""Regression contracts for the Python core; isolated state, no provider usage."""
import contextlib
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SOURCE))
from core import config, security, routing, adapters, runner, context, state, tasks, verification, snapshot
from gitenv import GIT_ENV, git_run


@contextlib.contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='redevent-python-test-') as directory:
        root = Path(directory)
        shutil.copytree(SOURCE / 'manifests', root / '.harness/manifests')
        shutil.copytree(SOURCE.parent / '.codex/skills', root / '.codex/skills')
        for name in ['tasks/inbox', 'tasks/active', 'tasks/failed', 'tasks/completed', 'state', 'handoffs', 'runtime']:
            (root / '.harness' / name).mkdir(parents=True, exist_ok=True)
        from core import delegation, lifecycle, hygiene, progress, checkpoint, retention
        # checkpoint and retention cache H/ROOT too: unpatched, a fixture run wrote (and could prune) the real .harness/state.
        modules = [config, security, runner, context, state, tasks, verification, snapshot, delegation, lifecycle, hygiene, progress,
                   checkpoint, retention]
        with contextlib.ExitStack() as stack:
            for module in modules:
                if hasattr(module, 'ROOT'):
                    stack.enter_context(patch.object(module, 'ROOT', root))
                if hasattr(module, 'H'):
                    stack.enter_context(patch.object(module, 'H', root / '.harness'))
            from core import changes
            stack.enter_context(patch.object(changes, 'ROOT', root))
            stack.enter_context(patch.dict(os.environ, {'HARNESS_CONTEXT_BUDGET': '16000', 'HARNESS_TASK_BUDGET': '16000',
                'HARNESS_HOST': '', 'HARNESS_AGENT_COMMAND': '', 'HARNESS_BASE': '',
                # Lifecycle fixtures never inherit operator receipts or cleanup;
                # dedicated preflight tests override these inside their scope.
                'HARNESS_IGNORE_ENV_FILE': '1', 'HARNESS_PREFLIGHT': 'off',
                'HARNESS_KEEP_ARTIFACTS': '1', **GIT_ENV}))
            for name in [n for n in os.environ if n.startswith('REDEVENT_VERIFY_')]:
                del os.environ[name]  # restored by patch.dict: a real run's report directory/strictness never leaks into fixtures
            yield root


class FixtureIsolationTests(unittest.TestCase):
    def test_fixture_redirects_every_module_that_writes_operational_state(self):
        from core import checkpoint, retention
        real = (SOURCE / 'state').resolve()
        with fixture() as root:
            for module in (checkpoint, retention):
                self.assertEqual(module.H, root / '.harness', module.__name__)
            self.assertNotEqual(checkpoint.storage('20260101000000-abcdef').parent.resolve(), real / 'checkpoints')
            self.assertTrue(checkpoint.storage('20260101000000-abcdef').is_relative_to(root.resolve()))


class SchemaConfigTests(unittest.TestCase):
    def test_unknown_schema_keyword_denied(self):
        self.assertTrue(config.validate_schema('x', {'type': 'string', 'pattern': '^x$'}))
        self.assertFalse(config.validate_schema('x', {'type': 'string', '$schema': 's'}))

    def test_bool_not_integer_const_enum_nested(self):
        for schema in [{'const': 1}, {'enum': [1]}, {'const': {'a': [1]}}]:
            value = {'a': [True]} if isinstance(schema.get('const'), dict) else True
            self.assertTrue(config.validate_schema(value, schema))
        self.assertFalse(config.validate_schema(1.0, {'const': 1}))

    def test_timeout_retries_budget_validation(self):
        with patch.dict(os.environ, {'HARNESS_MAX_RETRIES': '99'}):
            with self.assertRaises(ValueError):
                config.max_retries()
        with patch.dict(os.environ, {'HARNESS_GATE_TIMEOUT_MS': '0'}):
            with self.assertRaises(ValueError):
                config.gate_timeout_ms()
        self.assertGreater(config.tokenize('ñ' * 10), config.tokenize('a' * 10))


class SecurityTests(unittest.TestCase):
    def test_recursive_redaction_every_sensitive_value_type(self):
        marker = 'SYNTHETIC_VALUE_87987'
        for key in ['password', 'Cookie', 'ATS_MCP_TOKEN', 'authorization', 'private_secret']:
            for value in [marker, {'raw': marker}, [marker], 123456]:
                safe = security.redact_value({key: value})
                self.assertEqual(safe[key], '[REDACTED]')
        for value in [f'{{"token":"{marker}"}}', f'Authorization: Bearer {marker}',
                      f'Cookie: session={marker}', f'postgres://user:{marker}@localhost/db',
                      '-----BEGIN PRIVATE KEY-----\n' + marker + '\n-----END PRIVATE KEY-----']:
            self.assertNotIn(marker, security.redact(value))

    def test_exact_effective_environment_redaction(self):
        marker = 'SYNTHETIC_VALUE_66778'
        self.assertNotIn(marker, security.redact(marker, {'CUSTOM_SECRET': marker}))

    def test_path_guards_and_sensitive_aliases(self):
        with fixture():
            domain = {'paths': ['**'], 'exclude': []}
            agent = {'name': 'architect', 'allowedPaths': ['**'], 'forbiddenPaths': []}
            for name in ['../x', '/absolute', 'C:/x', '.env', '.env.local', 'key.pem', '.harness/state/x.json', 'secrets/file.key']:
                self.assertFalse(security.allowed_path(name, domain, agent), name)
            if os.name == 'nt':
                for name in ['.ENV', '.harness/STATE/x.json', '.harness/LOGS/x.json', '.env.', 'nul.txt']:
                    self.assertFalse(security.allowed_path(name, domain, agent), name)
            self.assertFalse(security.allowed_path('x.txt', domain, {**agent, 'name': 'reviewer'}))
            self.assertTrue(security.allowed_path('x.txt', domain, agent))

    def test_symlink_escape_and_dangling(self):
        with fixture() as root, tempfile.TemporaryDirectory() as outside:
            try:
                (root / 'escape').symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest('OS denies unprivileged symlink creation')
            self.assertFalse(security.contained('escape/file'))
            (root / 'dangling').symlink_to(root / 'missing')
            self.assertFalse(security.contained('dangling'))

    def test_command_denials_including_trusted_destructive(self):
        for cmd, args in [('python', ['-cprint(1)']), ('python', ['-Bcprint(1)']), ('node', ['--eval=1']),
                          ('bash', ['-lc', 'echo x']), ('git', ['reset', '--hard']), ('rm', ['-rf', '/']),
                          ('node', ['x.js', ';'])]:
            with self.assertRaises(ValueError, msg=str((cmd,args))):
                security.command_policy(cmd, args)
        with self.assertRaises(ValueError):
            security.command_policy('Remove-Item', ['x'], trusted=True)
        for cmd, args in [('bash',['-c','rm -rf synthetic-target']), ('cmd',['/c','del synthetic-target'])]:
            with self.assertRaises(ValueError):
                security.command_policy(cmd, args, trusted=True)
        security.command_policy('pnpm', ['format:check'], trusted=True)

    def test_orchestrator_guard_input_and_product(self):
        with fixture(), patch.dict(os.environ, {'HARNESS_AGENT': '', 'HARNESS_ALLOW_HOST_WRITES': ''}, clear=False):
            self.assertFalse(security.orchestrator_guard({}))
            self.assertFalse(security.orchestrator_guard({'tool_input': {'file_path': 'apps/api/main.go'}}))
            self.assertTrue(security.orchestrator_guard({'tool_input': {'file_path': '.harness/state/x.json'}}))

    def test_orchestrator_links_never_grant_code_or_escape_writes(self):
        with fixture() as root, tempfile.TemporaryDirectory() as outside, patch.dict(os.environ,
                {'HARNESS_AGENT':'','HARNESS_ALLOW_HOST_WRITES':'','CLAUDE_PROJECT_DIR':str(root)}):
            (root/'.harness/core').mkdir(exist_ok=True)
            try:
                (root/'.harness/state/core-link').symlink_to(root/'.harness/core',target_is_directory=True)
                (root/'.harness/state/external-link').symlink_to(outside,target_is_directory=True)
            except OSError:
                self.skipTest('OS denies unprivileged symlink creation')
            for target in ['.harness/state/core-link/security.py','.harness/state/external-link/file.txt']:
                self.assertFalse(security.orchestrator_guard({'tool_input':{'file_path':target}}))


class GitHermeticTests(unittest.TestCase):
    def test_fixture_git_disables_maintenance_and_gc(self):
        with fixture() as root:
            git_run(root, 'init')
            for key, expected in [('maintenance.auto', 'false'), ('gc.auto', '0')]:
                with self.subTest(key=key):
                    self.assertEqual(git_run(root, 'config', '--get', key).stdout.strip(), expected)
            # child processes (e.g. the CLI under test) inherit the same configuration through the environment
            inherited = subprocess.run(['git', 'config', '--get', 'maintenance.auto'], cwd=root, capture_output=True, text=True)
            self.assertEqual(inherited.stdout.strip(), 'false')
            self.assertEqual(os.environ['GIT_CONFIG_NOSYSTEM'], '1')


class ContextRoutingTests(unittest.TestCase):
    def test_existing_portals_route_independently_without_consumption_or_prohibited_writes(self):
        with fixture():
            domains = context.manifests()['domains']
            self.assertEqual(routing.infer_domains(
                'Implementar backoffice\nImplementar provider-portal\nImplementar sales-portal', domains),
                ['backoffice', 'provider-portal', 'sales-portal'])
            self.assertEqual(routing.infer_domains(
                'Implementar backoffice que consume provider-portal existente', domains), ['backoffice'])
            self.assertEqual(routing.infer_domains(
                'Implementar backoffice\nProhibido:\nImplementar provider-portal\nImplementar sales-portal',
                domains), ['backoffice'])

    def test_parent_git_worktree_cannot_supply_workspace_changes(self):
        from core import changes
        with tempfile.TemporaryDirectory(prefix='harness-parent-git-') as directory:
            parent=Path(directory)
            git_run(parent,'init',identity=False)
            child=parent/'child'
            child.mkdir()
            (parent/'outside.txt').write_text('outside workspace')
            with patch.object(changes,'ROOT',child):
                with self.assertRaisesRegex(ValueError,'worktree root differs'):
                    changes.changed_files()

    def test_git_changed_files_union_and_fail_closed_base(self):
        with fixture() as root:
            def git(*args):
                run=git_run(root,*args,check=False,identity=False)
                self.assertEqual(run.returncode,0,run.stderr)
                return run.stdout.strip()
            git('init')
            (root/'base.txt').write_text('first')
            git('add','base.txt')
            git('-c','user.name=Harness Fixture','-c','user.email=fixture@example.test','commit','-m','fixture baseline')
            base=git('rev-parse','HEAD')
            (root/'base.txt').write_text('committed change')
            git('add','base.txt')
            git('-c','user.name=Harness Fixture','-c','user.email=fixture@example.test','commit','-m','fixture change')
            (root/'staged.txt').write_text('staged')
            git('add','staged.txt')
            (root/'base.txt').write_text('unstaged')
            (root/'untracked.txt').write_text('untracked')
            (root/'.gitignore').write_text('ignored.txt\n')
            (root/'ignored.txt').write_text('ignored')
            from core.changes import changed_files
            files=changed_files(base)
            for name in ['base.txt','staged.txt','untracked.txt']:
                self.assertIn(name,files)
            self.assertNotIn('ignored.txt',files)
            with self.assertRaises(ValueError):
                changed_files('nonexistent-harness-base')
    def test_context_metadata_dedup_and_budget(self):
        with fixture():
            ctx = context.context('api', 'bounded task')
            self.assertTrue(all('content' not in s and 'sha256' in s for s in ctx['skills']))
            self.assertEqual(context.deduplicate(['x', 'x', 'y']), ['x', 'y'])
            with patch.dict(os.environ, {'HARNESS_TASK_BUDGET': '30'}):
                with self.assertRaisesRegex(ValueError, 'budget'):
                    context.context('repo', 'must preserve restrictions')

    def test_cache_invalidation_content_even_same_mtime(self):
        with fixture() as root:
            first = context.context_index()['fingerprint']
            file = root / '.harness/manifests/domains.json'
            previous = file.stat()
            value = file.read_bytes().replace(b'Preserve monorepo', b'Preserve Monorepo')
            file.write_bytes(value)
            os.utime(file, ns=(previous.st_atime_ns, previous.st_mtime_ns))
            self.assertNotEqual(first, context.context_index()['fingerprint'])

    def test_domain_consumer_and_sensitive_routing(self):
        with fixture():
            self.assertEqual(routing.infer_domains('Implementar pantalla backoffice que consume API existente', context.manifests()['domains']), ['backoffice'])
            selection = routing.select_agents(context.get_domain('api'), 'ajustar permisos', context.manifests()['agents'])
            self.assertIn('security-auditor', selection['agents'])
            small = routing.select_agents(context.get_domain('docs'), 'corregir typo documental trivial', context.manifests()['agents'])
            self.assertEqual(len([n for n in small['agents'] if n not in config.NON_IMPLEMENTERS]), 1)
            self.assertNotIn('reviewer', small['agents'])
            selected=routing.select_agents(context.get_domain('repo'),'specialist:protocol-auditor',context.manifests()['agents'])
            repeated=routing.select_agents(context.get_domain('repo'),'specialist:protocol-auditor',context.manifests()['agents'])
            self.assertEqual(selected['temporary']['name'],repeated['temporary']['name'])
            self.assertEqual(selected['temporary']['allowedPaths'],context.get_domain('repo')['paths'])
            self.assertIsNone(routing.select_agents(context.get_domain('repo'),'reference kafka redis only',context.manifests()['agents'])['temporary'])

    def test_prior_documentation_changes_never_lower_future_runtime_task_risk(self):
        with fixture():
            change_set={'files':['README.md'],'sha256':'synthetic'}
            selected_context={**context.context('repo'),'changeSet':change_set}
            with patch.object(tasks,'context',return_value=selected_context):
                task=tasks.make_task('repo','Modificar package.json para agregar dependencia de runtime')
            self.assertEqual(task['risk'],'MEDIUM')
            self.assertIn('reviewer',[node['agent'] for node in task['dag']])
            trivial=routing.select_agents(context.get_domain('docs'),'corregir typo documental trivial',context.manifests()['agents'],['README.md'])
            self.assertNotIn('reviewer',trivial['agents'])
            self.assertEqual(len([n for n in trivial['agents'] if n not in config.NON_IMPLEMENTERS]),1)
            self.assertEqual(routing.risk(['package.json'],'corregir typo documental trivial','repo'),'MEDIUM')

    def test_large_source_lossless_and_ingestion_secret_denied(self):
        with fixture():
            text = 'domain: repo\n' + 'detail\n' * 9000 + 'Never modify secrets.'
            task = tasks.make_task('repo', text, 'file:fixture')
            self.assertIn('EXPLICIT PARTIAL VIEW', task['task'])
            pages, offset = [], 0
            while True:
                page = tasks.expand_source(task['id'], offset, 12000)
                pages.append(page['text'])
                offset = page['nextOffset']
                if page['complete']:
                    break
            self.assertEqual(''.join(pages), text)
            with self.assertRaisesRegex(ValueError, 'sensitive'):
                tasks.make_task('repo', 'password=SYNTHETIC_1234')

    def test_selective_plan_and_invalid_base(self):
        with fixture():
            plan = verification.verify_plan(files=['.harness/core/security.py'])
            self.assertEqual(plan['domains'], ['repo'])
            self.assertEqual(plan['risk'], 'HIGH')
            self.assertFalse(plan['validated'])
            self.assertEqual(verification.verify_plan(files=['docs/guide.md'])['domains'], ['docs'])
            self.assertTrue(verification.verify_plan(full=True, files=[])['full'])
            from core.changes import changed_files
            with patch.dict(os.environ, {'HARNESS_BASE': '--unsafe'}):
                with self.assertRaisesRegex(ValueError, 'HARNESS_BASE'):
                    changed_files()


class LifecycleAdapterTests(unittest.TestCase):
    def test_deterministic_docs_verifier_executes_sensitive_openapi_gate(self):
        from core import delegation, impact
        with fixture() as root:
            (root/'node_modules').mkdir()
            task=tasks.make_task('docs','Actualizar docs/api/openapi.yaml')
            node=next(n for n in task['dag'] if n['agent']=='verifier')
            node.update(status='running',attempts=1)
            affected=['docs/api/openapi.yaml','.harness/state/task.json','apps/api/auth.go']
            with patch.object(verification,'changed_files',return_value=affected), patch.object(verification.shutil,'which',return_value='/usr/bin/tool'), patch.object(impact,'go_list_json',side_effect=ValueError('hermetic: go list is never run')), patch.object(verification,'enterprise_report',return_value=([],None)), patch.object(delegation,'spawn_run',return_value={'code':0,'out':'passed','err':'','durationMs':1}) as spawn:
                self.assertTrue(delegation.run_deterministic(task,node,{'estimatedTokens':1}))
            commands=[[call.args[0],*call.args[1]] for call in spawn.call_args_list]
            self.assertIn(['bash','./verify-enterprise.sh','--security'],commands)
            self.assertIn(['pnpm','format:check'],commands)
            plan=verification.task_verify_plan(task,affected)
            self.assertEqual(plan['files'],['docs/api/openapi.yaml'])
            self.assertIn(['pnpm','format:check'],[verification.argv(c) for c in verification.task_verify_plan(task,[])['checks']])

    def test_multi_fails_closed_when_a_combined_gate_is_skipped(self):
        from core import lifecycle
        with fixture():
            child=tasks.make_task('docs','Actualizar documentación')
            parent={'id':'combined-skip','children':[child['id']]}
            gates=[0]
            def run_gate(task,gate):
                gates[0]+=1
                return {'code':3,'skipped':True,'reason':'docker is not installed or not on PATH'}
            with patch.object(lifecycle,'load_task',return_value=child), patch.object(lifecycle,'execute_locked',return_value={**child,'status':'completed'}), patch.object(verification,'changed_files',return_value=['docs/guide.md']), patch.object(lifecycle,'run_gate',side_effect=run_gate), patch.object(lifecycle,'move_task') as move, patch.object(lifecycle,'log') as log:
                result=lifecycle.run_multi(parent)
            self.assertIs(result,parent)
            self.assertEqual(gates[0],1)  # stops at the first skipped gate
            move.assert_not_called()  # neither completed nor failed: blocked, still active
            self.assertIn('SKIPPED_ENVIRONMENT',log.call_args.args[3]['reason'])

    def test_combined_gates_recompute_sensitive_plan_after_last_child_write(self):
        from core import lifecycle
        with fixture():
            child=tasks.make_task('docs','Actualizar documentación')
            parent={'id':'combined-fixture','children':[child['id']]}
            affected=[]
            def execute_child(identity):
                affected.append('docs/api/openapi.yaml')
                return {**child,'status':'completed'}
            with patch.object(lifecycle,'load_task',return_value=child), patch.object(lifecycle,'execute_locked',side_effect=execute_child), patch.object(verification,'changed_files',side_effect=lambda **kwargs:list(affected)), patch.object(lifecycle,'run_gate',return_value={'code':0}) as gate, patch.object(lifecycle,'move_task') as move:
                lifecycle.run_multi(parent)
            commands=[verification.argv(call.args[1]) for call in gate.call_args_list]
            self.assertIn(['bash','./verify-enterprise.sh','--security'],commands)
            self.assertEqual(len(commands),len({tuple(command) for command in commands}))
            move.assert_called_once_with(parent,'completed')

    def test_interruption_preserves_running_baseline(self):
        from core import delegation
        with fixture(), patch.dict(os.environ, {'HARNESS_AGENT_COMMAND': 'fixture-command'}):
            task = tasks.make_task('repo', 'interruption fixture')
            task['dag'][0].update(status='passed', attempts=1)
            node = task['dag'][1]
            with patch.object(delegation, 'spawn_run', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    delegation.execute_node(task, node)
            self.assertEqual(node['status'], 'running')
            self.assertTrue(snapshot.baseline_file(task, node).exists())

    def test_unverifiable_scope_retains_baseline_and_blocks_retry(self):
        from core import delegation
        with fixture(), patch.dict(os.environ, {'HARNESS_AGENT_COMMAND': 'fixture-command'}):
            task = tasks.make_task('repo', 'snapshot error fixture')
            task['dag'][0].update(status='passed', attempts=1)
            node = task['dag'][1]
            with patch.object(delegation, 'snapshot', side_effect=[snapshot.Snapshot(), OSError('synthetic failure')]), patch.object(delegation, 'spawn_run', return_value={'code':0,'out':'{}','err':''}):
                self.assertFalse(delegation.execute_node(task, node))
            self.assertTrue(snapshot.baseline_file(task, node).exists())
            self.assertIn('scopeValidationPending', task)
            state.move_task(task, 'failed')
            with self.assertRaisesRegex(ValueError, 'Unverified'):
                tasks.retry_task(task['id'])

    def test_interrupted_owned_artifacts_and_legal_partial_work_resume(self):
        from core import delegation
        with fixture() as root, patch.dict(os.environ, {'HARNESS_AGENT_COMMAND': 'fixture-command'}):
            task = tasks.make_task('repo', 'artifact recovery fixture')
            task['dag'][0].update(status='passed', attempts=1)
            node = task['dag'][1]
            with patch.object(delegation,'spawn_run',side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    delegation.execute_node(task,node)
            baseline=snapshot.baseline_file(task,node)
            owned=json.loads(baseline.read_text())['owned']
            for name in owned:
                if name == baseline.relative_to(root).as_posix():
                    continue
                file=root/name
                file.parent.mkdir(parents=True,exist_ok=True)
                file.write_text('host artifact')
            (root/'legal.txt').write_text('partial work')
            snapshot.verify_interrupted(task)
            self.assertFalse(baseline.exists())
            self.assertNotIn('scopeViolation',task)

    def test_task_corruption_transition_retry_identity(self):
        with fixture():
            task = tasks.make_task('repo', 'lifecycle fixture')
            self.assertEqual(task['dag'][0]['agent'], 'context-manager')
            original = task['id']
            state.move_task(task, 'failed')
            reopened = tasks.retry_task(task['id'])
            self.assertEqual(reopened['id'], original)
            self.assertEqual(reopened['status'], 'active')
            with self.assertRaises(ValueError):
                state.move_task(reopened, 'completed')
            reopened['dag'][0]['dependsOn'] = [reopened['dag'][-1]['id']]
            with self.assertRaisesRegex(ValueError, 'cycle'):
                state.validate_task(reopened)

    def test_adapters_and_invalid_zero_exit_result(self):
        result = {'status': 'passed', 'changes': [], 'files': [], 'decisions': [], 'risks': [], 'verification': [], 'nextAction': None}
        self.assertEqual(adapters.parse_result(json.dumps(result)), result)
        for raw in ['Everything passed', '{}', json.dumps({**result, 'status': 'done'})]:
            with self.assertRaises(ValueError):
                adapters.parse_result(raw)
        with patch.dict(os.environ, {'HARNESS_HOST': 'codex', 'HARNESS_AGENT_COMMAND': ''}):
            spec = adapters.host_adapter('reviewer', 'literal input', 'result.json')
            self.assertEqual(spec['input'], 'literal input')
            self.assertNotIn('literal input', ' '.join(spec['args']))
            self.assertIn('read-only', ' '.join(spec['args']))
        args = adapters.claude_args(True)
        self.assertIn('--strict-mcp-config', args)
        envelope = {'type': 'result', 'subtype': 'success', 'is_error': False, 'structured_output': result}
        self.assertEqual(json.loads(adapters.extract_claude_result(json.dumps(envelope))), result)
        envelope['is_error'] = True
        with self.assertRaisesRegex(ValueError, 'is_error'):
            adapters.extract_claude_result(json.dumps(envelope))

    def test_scope_latch_restoration_hmac_and_readonly(self):
        with fixture() as root:
            before = snapshot.Snapshot({'secrets/key.txt': '33188:hash'}, ignored=['secrets/key.txt'])
            task = tasks.make_task('repo', 'scope fixture')
            node = task['dag'][1]
            node['attempts'] = 1
            snapshot.record_scope_violation(task, node, before, ['secrets/key.txt'], 'fixture')
            state.move_task(task, 'failed')
            self.assertTrue(task['scopeViolation']['restoration'][0]['fingerprint'].startswith('hmac:'))
            with self.assertRaisesRegex(ValueError, 'Unresolved'):
                tasks.retry_task(task['id'])
            with self.assertRaises(snapshot.ScopeError):
                snapshot.compare_snapshots(snapshot.Snapshot(), snapshot.Snapshot({'x': 'hash'}),
                    {'paths':['**'],'exclude':[]}, {'name':'reviewer','allowedPaths':['**'],'forbiddenPaths':[]})

    def test_ephemeral_harness_artifacts_are_not_scope_violations(self):
        domain = {'paths': ['**'], 'exclude': []}
        contract = {'name': 'architect', 'allowedPaths': ['apps/api/**'], 'forbiddenPaths': []}
        base = snapshot.Snapshot({'.harness/runtime/fingerprint.salt': 'a'})
        ephemeral = snapshot.Snapshot({'.harness/runtime/fingerprint.salt': 'a', '.harness/runtime/context-index.json': 'x',
                                       '.harness/runtime/verify-last.json': 'v',
                                       '.harness/runtime/verify-last.json.0a1b2c3d4e5f.tmp': 'v',
                                       '.harness/runtime/output/x.log': 'y',
                                       '.harness/runtime/change-refs/x.json': 'z',
                                       '.harness/runtime/progress/t1.json': 'p',
                                       '.harness/runtime/progress/t1.json.0a1b2c3d4e5f.tmp': 'p'})
        self.assertEqual(snapshot.compare_snapshots(base, ephemeral, domain, contract), [])
        reader = {'name': 'reviewer', 'allowedPaths': ['**'], 'forbiddenPaths': []}
        self.assertEqual(snapshot.compare_snapshots(base, ephemeral, domain, reader), [])
        for file in ['.harness/state/a.json', '.harness/tasks/active/a.json', '.harness/handoffs/a.json',
                     '.harness/logs/audit/a.log', '.harness/runtime/fingerprint.salt', '.harness/runtime/python/x',
                     '.harness/runtime/t-baseline.json', '.harness/runtime/change-refs/x.txt',
                     '.harness/runtime/change-refs/sub/x.json', '.harness/runtime/verify-last.json.bak', '.harness/runtime/verify-last.json.zz.tmp', 'apps/web/page.tsx',
                     '.harness/runtime/progress/sub/x.json', '.harness/runtime/progress/x.txt', '.harness/runtime/progress/x.json.zz.tmp']:
            with self.subTest(file=file), self.assertRaises(snapshot.ScopeError):
                snapshot.compare_snapshots(base, snapshot.Snapshot({**base, file: 'changed'}), domain, contract)

    def test_ignored_tsbuildinfo_regenerated_by_gates_is_not_a_scope_violation(self):
        domain = {'paths': ['**'], 'exclude': []}
        contract = {'name': 'backend', 'allowedPaths': ['apps/api/**'], 'forbiddenPaths': []}
        with fixture() as root:
            git = lambda *args: self.assertEqual(git_run(root, *args, check=False).returncode, 0)
            git('init')
            (root / '.gitignore').write_text('*.tsbuildinfo\n.env\n')
            (root / 'apps/portal').mkdir(parents=True)
            (root / 'apps/portal/next-env.d.ts').write_text('// v1\n')
            git('add', '.gitignore', 'apps/portal/next-env.d.ts')
            git('commit', '-m', 'baseline')
            (root / 'apps/portal/tsconfig.tsbuildinfo').write_text('{"v":1}')
            (root / '.env').write_text('A=1\n')
            before = snapshot.snapshot()
            self.assertNotIn('apps/portal/tsconfig.tsbuildinfo', before)
            self.assertIn('.env', before.ignored)
            (root / 'apps/portal/tsconfig.tsbuildinfo').write_text('{"v":2}')
            (root / 'tsconfig.tsbuildinfo').write_text('{"root":1}')
            self.assertEqual(snapshot.compare_snapshots(before, snapshot.snapshot(), domain, contract), [])
            for file, content in [('apps/portal/next-env.d.ts', '// v2\n'), ('.env', 'A=2\n')]:
                with self.subTest(file=file):
                    (root / file).write_text(content)
                    with self.assertRaisesRegex(snapshot.ScopeError, 'outside allowed scope: ' + file.replace('.', r'\.')):
                        snapshot.compare_snapshots(before, snapshot.snapshot(), domain, contract)
                    (root / file).write_text('// v1\n' if file.endswith('.ts') else 'A=1\n')
        # Persisted baselines: ignored build info is exempt, tracked or unlisted ignored files are not.
        base = snapshot.Snapshot({'apps/portal/tsconfig.tsbuildinfo': 'a', 'apps/portal/next-env.d.ts': 'a', '.env': 'a'},
                                 ignored=['apps/portal/tsconfig.tsbuildinfo', '.env'])
        changed = snapshot.Snapshot({**base, 'apps/portal/tsconfig.tsbuildinfo': 'b'}, ignored=base.ignored)
        self.assertEqual(snapshot.compare_snapshots(base, changed, domain, contract), [])
        tracked = snapshot.Snapshot({**base, 'apps/portal/tsconfig.tsbuildinfo': 'b'}, ignored=[])
        with self.assertRaises(snapshot.ScopeError):
            snapshot.compare_snapshots(snapshot.Snapshot(base), tracked, domain, contract)
        for file in ['apps/portal/next-env.d.ts', '.env']:
            with self.subTest(file=file), self.assertRaises(snapshot.ScopeError):
                snapshot.compare_snapshots(base, snapshot.Snapshot({**base, file: 'b'}, ignored=base.ignored), domain, contract)

    def test_tsbuildinfo_exemption_requires_git_ignore_and_manifest_pattern(self):
        domain = {'paths': ['**'], 'exclude': []}
        contract = {'name': 'backend', 'allowedPaths': ['apps/api/**'], 'forbiddenPaths': []}
        with fixture() as root:
            git = lambda *args: self.assertEqual(git_run(root, *args, check=False).returncode, 0)
            git('init')
            (root / '.gitignore').write_text('apps/portal/*.tsbuildinfo\nnext-env.d.ts\n*.tsbuildinfo.bak\n')
            (root / 'apps/portal').mkdir(parents=True)
            (root / 'apps/tracked').mkdir(parents=True)
            (root / 'apps/tracked/tsconfig.tsbuildinfo').write_text('{"v":1}')
            git('add', '.gitignore', 'apps/tracked/tsconfig.tsbuildinfo')
            git('commit', '-m', 'baseline')
            (root / 'apps/portal/tsconfig.tsbuildinfo').write_text('{"v":1}')
            before = snapshot.snapshot()
            # Deleting ignored build info is exempt too: gates may clean before rebuilding.
            (root / 'apps/portal/tsconfig.tsbuildinfo').unlink()
            self.assertEqual(snapshot.compare_snapshots(before, snapshot.snapshot(), domain, contract), [])
            (root / 'apps/portal/tsconfig.tsbuildinfo').write_text('{"v":1}')
            # Tracked build info, an ignored next-env.d.ts (listed but not *.tsbuildinfo) and ignored look-alikes stay writes.
            for file in ['apps/tracked/tsconfig.tsbuildinfo', 'apps/portal/next-env.d.ts', 'apps/portal/tsconfig.tsbuildinfo.bak']:
                with self.subTest(file=file):
                    before = snapshot.snapshot()
                    (root / file).write_text('{"v":2}')
                    with self.assertRaisesRegex(snapshot.ScopeError, 'outside allowed scope: ' + file.replace('.', r'\.')):
                        snapshot.compare_snapshots(before, snapshot.snapshot(), domain, contract)
            # The pattern list comes from policies.json: without its *.tsbuildinfo entries nothing is exempt.
            policies = root / '.harness/manifests/policies.json'
            manifest = json.loads(policies.read_text())
            manifest['generatedArtifacts'] = [p for p in manifest['generatedArtifacts'] if not p.endswith('.tsbuildinfo')]
            policies.write_text(json.dumps(manifest))
            self.assertEqual(snapshot.build_info_patterns(), [])
            before = snapshot.snapshot()
            self.assertIn('apps/portal/tsconfig.tsbuildinfo', before.ignored)
            (root / 'apps/portal/tsconfig.tsbuildinfo').write_text('{"v":3}')
            with self.assertRaisesRegex(snapshot.ScopeError, r'outside allowed scope: apps/portal/tsconfig\.tsbuildinfo'):
                snapshot.compare_snapshots(before, snapshot.snapshot(), domain, contract)

    def test_renamed_files_report_old_and_new_path(self):
        with fixture() as root:
            def git(*args):
                run=git_run(root,*args,check=False)
                self.assertEqual(run.returncode,0,run.stderr)
                return run.stdout.strip()
            git('init')
            (root/'packages/x').mkdir(parents=True)
            (root/'packages/x/old.ts').write_text('export const value = "stable content that git detects as a rename"\n'*5)
            git('add','.')
            git('commit','-m','baseline')
            base=git('rev-parse','HEAD')
            from core.changes import changed_files
            git('mv','packages/x/old.ts','packages/x/new.ts')
            self.assertEqual(changed_files(),['packages/x/new.ts','packages/x/old.ts'])  # staged
            git('commit','-m','rename')
            self.assertEqual(changed_files(base),['packages/x/new.ts','packages/x/old.ts'])  # base...HEAD
            (root/'packages/x/new.ts').rename(root/'packages/x/newer.ts')
            self.assertIn('packages/x/new.ts',changed_files())  # unstaged deletion keeps the old path
            self.assertIn('packages/x/newer.ts',changed_files())


class RunnerTests(unittest.TestCase):
    def test_raw_output_is_not_redacted_and_never_persisted(self):
        with fixture() as root:
            code='import json; print(json.dumps({"DepOnly": True, "Dir": "x"}))'
            with patch.dict(os.environ, {'GO_TOKEN_FLAG': 'true'}):
                redacted = runner.spawn_run(sys.executable, ['-B', '-c', code], {'trusted': True, 'persist': False, 'structured': True})
                raw = runner.spawn_run(sys.executable, ['-B', '-c', code], {'trusted': True, 'persist': False, 'structured': True, 'raw': True})
            self.assertEqual(json.loads(raw['out']), {'DepOnly': True, 'Dir': 'x'})
            self.assertNotIn('true', redacted['out'])
            self.assertNotIn('log', raw)
            with self.assertRaisesRegex(ValueError, 'in-memory'):
                runner.spawn_run(sys.executable, ['-B', '-c', 'pass'], {'trusted': True, 'raw': True})
            self.assertFalse(list((root/'.harness/runtime').glob('output/*')))

    def test_runner_effective_secret_output_persistence_and_compaction(self):
        with fixture() as root:
            marker = 'SYNTHETIC_VALUE_63893'
            result = runner.spawn_run(sys.executable, ['-B', '-c', 'import os; print(os.environ["AUDIT_SECRET"])'],
                {'trusted': True, 'env': {'AUDIT_SECRET': marker}})
            self.assertEqual(result['code'], 0)
            self.assertNotIn(marker, result['out'])
            self.assertNotIn(marker, (root/result['log']).read_text())

    def test_output_overflow_discards_partial_secret(self):
        with fixture() as root:
            marker = 'SYNTHETIC_SECRET_LONG_VALUE_3894'
            result = runner.spawn_run(sys.executable, ['-B', '-c', 'import os; print(os.environ["AUDIT_SECRET"])'],
                {'trusted': True, 'env': {'AUDIT_SECRET': marker}, 'outputLimitBytes': 10})
            self.assertEqual(result['code'], 125)
            self.assertNotIn(marker[:10], result['out'] + (root/result['log']).read_text())

    def test_timeout_kills_process_and_output_is_bounded(self):
        with fixture():
            result = runner.spawn_run(sys.executable, ['-B', '-c', 'import time; time.sleep(10)'],
                                      {'trusted': True, 'timeoutMs': 100})
            self.assertEqual(result['code'], 124)
            self.assertLess(result['durationMs'], 5000)

    def assert_process_terminated(self, pid):
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes as w
            api = ctypes.WinDLL('kernel32', use_last_error=True)
            api.OpenProcess.argtypes, api.OpenProcess.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
            api.WaitForSingleObject.argtypes, api.WaitForSingleObject.restype = [w.HANDLE, w.DWORD], w.DWORD
            api.CloseHandle.argtypes, api.CloseHandle.restype = [w.HANDLE], w.BOOL
            handle = api.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE; never signal an unrelated PID.
            if not handle:
                self.assertEqual(ctypes.get_last_error(), 87)  # Process no longer exists.
                return
            try:
                self.assertEqual(api.WaitForSingleObject(handle, 1000), 0, f'process {pid} survived')
            finally:
                api.CloseHandle(handle)
        else:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            # A killed orphan can remain a zombie until init reaps it on Linux.
            stat = Path(f'/proc/{pid}/stat')
            self.assertTrue(stat.exists() and stat.read_text().split(') ')[1].startswith('Z '),
                            f'process {pid} survived')

    def test_timeout_cleanup_failure_preserves_cancellation_reason(self):
        # Model slow Windows job termination without leaving a real child alive.
        wait = subprocess.Popen.wait
        processes = []
        def slow_cleanup(process, timeout=None):
            processes.append(process)
            wait(process, timeout=10)
            raise subprocess.TimeoutExpired(process.args, timeout)
        with fixture(), patch.object(subprocess.Popen, 'wait', slow_cleanup):
            with self.assertRaisesRegex(RuntimeError, 'Harness timeout after 100ms; process-tree cleanup timed out'):
                runner.spawn_run(sys.executable, ['-B', '-c', 'import time; time.sleep(10)'],
                                 {'trusted': True, 'persist': False, 'timeoutMs': 100})
        self.assertEqual(len(processes), 1)
        self.assert_process_terminated(processes[0].pid)

    def test_overflow_cleanup_failure_preserves_reason_without_echoing_output(self):
        wait = subprocess.Popen.wait
        processes = []
        def slow_cleanup(process, timeout=None):
            processes.append(process)
            wait(process, timeout=10)
            raise subprocess.TimeoutExpired(process.args, timeout)
        with fixture(), patch.object(subprocess.Popen, 'wait', slow_cleanup):
            with self.assertRaisesRegex(RuntimeError, 'Harness output size limit exceeded; process-tree cleanup timed out') as caught:
                runner.spawn_run(sys.executable, ['-B', '-c',
                    'import sys,time; sys.stdout.write("SYNTHETIC_PRIVATE_9981" * 1000); sys.stdout.flush(); time.sleep(10)'],
                    {'trusted': True, 'persist': False, 'outputLimitBytes': 100, 'timeoutMs': 5000})
        self.assertNotIn('SYNTHETIC_PRIVATE_9981', str(caught.exception))
        self.assertEqual(len(processes), 1)
        self.assert_process_terminated(processes[0].pid)

    def test_timeout_and_overflow_terminate_real_descendants(self):
        modes = ['timeout', 'overflow'] + (['parent-exit'] if os.name == 'nt' else [])
        for mode in modes:
            with self.subTest(mode=mode), fixture() as root:
                grandchild = ('import os,time; from pathlib import Path; '
                              'Path("grandchild.pid").write_text(str(os.getpid())); time.sleep(30)')
                child = ('import os,sys,subprocess,time; from pathlib import Path; '
                         f'subprocess.Popen([sys.executable,"-B","-c",{grandchild!r}]); '
                         'Path("child.pid").write_text(str(os.getpid())); time.sleep(30)')
                parent = ('import os,sys,subprocess,time; from pathlib import Path; '
                          f'subprocess.Popen([sys.executable,"-B","-c",{child!r}]); '
                          'Path("parent.pid").write_text(str(os.getpid()))\n'
                          'while not Path("grandchild.pid").exists(): time.sleep(.01)\n' +
                          ('print("x"*32768,flush=True)\n' if mode == 'overflow' else '') +
                          ('time.sleep(30)' if mode != 'parent-exit' else ''))
                result = runner.spawn_run(sys.executable, ['-B', '-c', parent],
                    {'trusted': True, 'persist': False, 'timeoutMs': 8000, 'outputLimitBytes': 1024})
                self.assertEqual(result['code'], {'overflow': 125, 'timeout': 124, 'parent-exit': 0}[mode], result)
                # Three chained interpreters start before the timer matters: a tight limit made this test flaky under load.
                self.assertLess(result['durationMs'], 15000)
                if mode == 'overflow':
                    self.assertEqual(result['out'], '')
                    self.assertIn('incomplete output discarded', result['err'])
                for name in ('parent', 'child', 'grandchild'):
                    pidfile = root / (name + '.pid')
                    self.assertTrue(pidfile.is_file(), f'{name} was not started')
                    self.assert_process_terminated(int(pidfile.read_text()))

    def test_windows_job_setup_failure_never_runs_child(self):
        if os.name == 'nt':
            for stage in ('assignment', 'resume'):
                with self.subTest(stage=stage), fixture() as root:
                    processes = []
                    def deny(job, process):
                        processes.append(process)
                        if stage == 'resume':
                            self.assertTrue(job.api.AssignProcessToJobObject(job.handle, int(process._handle)))
                        raise OSError('synthetic job setup failure')
                    with patch.object(runner.WindowsJob, 'attach_and_resume', deny):
                        result = runner.spawn_run(sys.executable,
                            ['-B', '-c', 'from pathlib import Path; Path("executed").touch()'],
                            {'trusted': True, 'persist': False, 'timeoutMs': 100})
                    self.assertEqual(result['code'], 127)
                    self.assertLess(result['durationMs'], 5000)
                    self.assertFalse((root / 'executed').exists())
                    self.assertEqual(len(processes), 1)
                    self.assert_process_terminated(processes[0].pid)

    def test_structured_host_never_persists_reflected_prompt(self):
        with fixture() as root:
            prompt=json.dumps({'taskId':'fixture','task':'SYNTHETIC_TASK_FULL_PROMPT','context':{}})
            run=runner.spawn_run(sys.executable,['-I','-S','-B','-c','import sys,json; print(json.dumps(json.load(sys.stdin),indent=2))'],
                {'trusted':True,'input':prompt,'structured':True})
            self.assertNotIn('SYNTHETIC_TASK_FULL_PROMPT',(root/run['log']).read_text())

    def test_specialist_inherits_harness_python_for_codex_claude_and_custom_command(self):
        interpreter = sys.executable
        probe = 'import os,json; print(json.dumps([os.environ.get("HARNESS_PYTHON"), os.environ.get("HARNESS_PYTHON_SOURCE")]))'
        custom = 'echo %HARNESS_PYTHON%' if os.name == 'nt' else 'printf "%s\\n" "$HARNESS_PYTHON"'
        for host, command in [('codex', ''), ('claude', ''), ('', custom)]:
            with self.subTest(host=host or 'HARNESS_AGENT_COMMAND'), fixture() as root, patch.dict(os.environ, {
                    'HARNESS_HOST': host, 'HARNESS_AGENT_COMMAND': command, 'HARNESS_PYTHON': interpreter,
                    'HARNESS_PYTHON_SOURCE': 'PATH', 'AUDIT_TOKEN': 'SYNTHETIC_TOKEN_VALUE_5521'}):
                prompt = 'SYNTHETIC_SPECIALIST_PROMPT'
                adapter = adapters.host_adapter('backend', prompt, root / '.harness/runtime/result.json')
                self.assertNotIn('HARNESS_PYTHON', adapter['env'])  # Adapters never shadow the inherited interpreter.
                # Real host CLIs are not invoked: the probe receives exactly the env the runner builds for the adapter.
                cmd, args = (adapter['cmd'], adapter['args']) if command else (sys.executable, ['-I', '-S', '-B', '-c', probe])
                run = runner.spawn_run(cmd, args, {'env': adapter['env'], 'input': adapter['input'], 'host': adapter.get('host'),
                                                   'trusted': True, 'structured': True, 'persist': False})
                self.assertEqual(run['code'], 0, run['err'])
                received = run['out'].strip() if command else json.loads(run['out'])
                self.assertEqual(received, interpreter if command else [interpreter, 'PATH'])
                self.assertEqual(security.redact(interpreter, {**os.environ, **adapter['env']}), interpreter)
                # redact stays active (the secret is masked) while the interpreter path survives intact.
                mixed = security.redact(interpreter + ' SYNTHETIC_TOKEN_VALUE_5521', {**os.environ, **adapter['env']})
                self.assertEqual(mixed, interpreter + ' [REDACTED]')

    def test_doctor_and_check_report_python_origin_without_echoing_unknown_values(self):
        from core import check
        for value, expected in [('managed', 'managed'), ('HARNESS_PYTHON', 'HARNESS_PYTHON'), ('PATH', 'PATH'),
                                ('SYNTHETIC_SECRET_9921', 'direct'), ('', 'direct')]:
            with self.subTest(value=value), patch.dict(os.environ, {'HARNESS_PYTHON_SOURCE': value}):
                row = check.doctor()[0]
                self.assertEqual((row['component'], row['source']), ('Python', expected))
                self.assertNotIn('SYNTHETIC_SECRET_9921', json.dumps(row))


class HygieneTests(unittest.TestCase):
    def setUp(self):
        from core import hygiene
        self.hygiene = hygiene

    def write_task(self, root, status, identity, **extra):
        task = {'schemaVersion': 1, 'id': identity, 'status': status, 'task': 'fixture', 'domain': 'repo',
                'agents': ['architect'], 'createdAt': '2026-09-01T00:00:00.000Z', 'updatedAt': '2026-09-01T00:00:00.000Z',
                'dag': [{'id': 'architect', 'agent': 'architect', 'dependsOn': [], 'status': 'pending', 'attempts': 0}], **extra}
        config.write_json(root / '.harness/tasks' / status / (identity + '.json'), task)
        return task

    def write_invalid(self, root, identity='20260927194556-0ba574'):
        file = root / '.harness/tasks/failed' / (identity + '.json')
        file.write_text('{"id": "%s", "status": "failed"}\n' % identity, encoding='utf-8')
        return file

    def test_report_finds_stale_running_and_invalid_without_writes(self):
        with fixture() as root:
            self.write_task(root, 'active', 'oldtask1')
            running = self.write_task(root, 'failed', 'runtask1')
            running['dag'][0]['status'] = 'running'
            config.write_json(root / '.harness/tasks/failed/runtask1.json', running)
            self.write_invalid(root)
            config.write_json(root / '.harness/state/ghosttask1.json', {'id': 'ghosttask1'})
            before = sorted(str(p) for p in root.rglob('*'))
            data = self.hygiene.report(7)
            self.assertEqual(before, sorted(str(p) for p in root.rglob('*')))
            kinds = {f['kind'] for f in data['findings']}
            self.assertTrue({'stale-active', 'active-without-live-lock', 'running-in-terminal', 'invalid-evidence', 'orphan-state'} <= kinds)
            actions = ' '.join(f['action'] for f in data['findings'])
            self.assertIn('harness:abort -- oldtask1', actions)
            self.assertIn('harness:retry -- runtask1', actions)
            self.assertIn(self.hygiene.QUARANTINE_COMMAND, actions)

    def test_quarantine_identical_copy_removes_failed_copy(self):
        with fixture() as root:
            file = self.write_invalid(root)
            legacy = root / '.harness/tasks/legacy'
            legacy.mkdir()
            (legacy / file.name).write_bytes(file.read_bytes())
            self.hygiene.quarantine(True)
            self.assertFalse(file.exists())
            self.assertEqual(['20260927194556-0ba574.json'], [p.name for p in legacy.iterdir()])
            self.assertEqual(1, len(list((root / '.harness/logs/audit').glob('*.json'))))

    def test_quarantine_different_copy_keeps_both(self):
        with fixture() as root:
            file = self.write_invalid(root)
            legacy = root / '.harness/tasks/legacy'
            legacy.mkdir()
            (legacy / file.name).write_text('different', encoding='utf-8')
            original = file.read_bytes()
            self.hygiene.quarantine(True)
            self.assertFalse(file.exists())
            self.assertEqual('different', (legacy / file.name).read_text(encoding='utf-8'))
            moved = [p for p in legacy.iterdir() if p.name != file.name]
            self.assertEqual(1, len(moved))
            self.assertEqual(original, moved[0].read_bytes())

    def test_dry_run_modifies_nothing_and_valid_tasks_untouched(self):
        with fixture() as root:
            file = self.write_invalid(root)
            valid = self.write_task(root, 'failed', 'oktask01')
            before = sorted(str(p) for p in root.rglob('*'))
            plan = self.hygiene.quarantine(False)
            self.assertEqual([False], [p['applied'] for p in plan])
            self.assertEqual(before, sorted(str(p) for p in root.rglob('*')))
            self.hygiene.quarantine(True)
            self.assertTrue((root / '.harness/tasks/failed/oktask01.json').exists())
            self.assertFalse(file.exists())

    def test_live_workspace_lock_blocks_quarantine(self):
        with fixture() as root:
            file = self.write_invalid(root)
            with state.Lock(root / '.harness/state/workspace.lock'):
                with self.assertRaises(ValueError):
                    self.hygiene.quarantine(True)
            self.assertTrue(file.exists())

    def test_argument_validation(self):
        for args in [['--yes'], ['--stale-days', 'x'], ['--bogus']]:
            with self.assertRaises(ValueError):
                self.hygiene.parse_args(args)
        self.assertEqual(3, self.hygiene.parse_args(['--stale-days', '3'])['staleDays'])


    def test_fresh_active_with_live_lock_has_no_findings(self):
        with fixture() as root:
            now = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat().replace('+00:00', 'Z')
            self.write_task(root, 'active', 'livetask', updatedAt=now, createdAt=now)
            with state.Lock(root / '.harness/state/livetask.lock'):
                data = self.hygiene.report(7)
            self.assertEqual([], [f for f in data['findings'] if f['task'] == 'livetask'])

    def test_main_json_report_and_dry_run_output(self):
        with fixture() as root:
            self.write_invalid(root)
            with contextlib.redirect_stdout(__import__('io').StringIO()) as out:
                self.assertEqual(0, self.hygiene.main(['--json']))
            self.assertEqual(['invalid-evidence'], [f['kind'] for f in json.loads(out.getvalue())['findings']])
            with contextlib.redirect_stdout(__import__('io').StringIO()) as out:
                self.assertEqual(0, self.hygiene.main(['--quarantine-invalid', '--json']))
            self.assertFalse(json.loads(out.getvalue())['applied'])
            self.assertTrue((root / '.harness/tasks/failed/20260927194556-0ba574.json').exists())

    def test_check_warning_recommends_hygiene_command(self):
        source = (SOURCE / 'core/check.py').read_text(encoding='utf-8')
        self.assertIn(self.hygiene.QUARANTINE_COMMAND, source)


if __name__ == '__main__':
    unittest.main()
