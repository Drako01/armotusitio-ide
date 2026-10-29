"""Regression coverage for Harness failure prevention without network or live services."""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from core import envcheck, progress, security, snapshot, preflight, verification, gatetriage


class GuardPreventionTests(unittest.TestCase):
    def test_live_workspace_lock_denies_host_write(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '.harness/state').mkdir(parents=True)
            (root / '.harness/state/workspace.lock').write_text(json.dumps({'pid': os.getpid()}))
            with patch.dict(os.environ, {'CLAUDE_PROJECT_DIR': folder, 'HARNESS_ALLOW_HOST_WRITES': '1', 'HARNESS_AGENT': ''}):
                self.assertFalse(security.orchestrator_guard({'tool_input': {'file_path': 'README.md'}}))
                self.assertTrue(security.orchestrator_guard({'tool_input': {'file_path': '.harness/runtime/output/notes.log'}}))

    def test_pending_interrupted_baseline_denies_host_write(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '.harness/runtime').mkdir(parents=True)
            (root / '.harness/runtime/20260101-node-1-baseline.json').write_text('{}')
            with patch.dict(os.environ, {'CLAUDE_PROJECT_DIR': folder, 'HARNESS_ALLOW_HOST_WRITES': '1', 'HARNESS_AGENT': ''}):
                self.assertFalse(security.orchestrator_guard({'tool_input': {'file_path': 'README.md'}}))

    def test_delegated_worker_uses_its_scope_contract(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '.harness/state').mkdir(parents=True)
            (root / '.harness/state/workspace.lock').write_text(json.dumps({'pid': os.getpid()}))
            with patch.dict(os.environ, {'CLAUDE_PROJECT_DIR': folder, 'HARNESS_AGENT': 'backend'}):
                self.assertTrue(security.orchestrator_guard({'tool_input': {'file_path': 'README.md'}}))


class GeneratedArtifactTests(unittest.TestCase):
    def test_tracked_generated_files_still_count(self):
        self.assertFalse(snapshot.regenerated('apps/backoffice/next-env.d.ts', set(), ['*.tsbuildinfo']))
        self.assertFalse(snapshot.regenerated('apps/backoffice/tsconfig.tsbuildinfo', set(), ['*.tsbuildinfo']))
        self.assertTrue(snapshot.regenerated('apps/backoffice/tsconfig.tsbuildinfo',
                                             {'apps/backoffice/tsconfig.tsbuildinfo'}, ['**/*.tsbuildinfo']))


class MigrationPreventionTests(unittest.TestCase):
    def test_missing_gh_returns_unknown_not_empty(self):
        with patch.object(envcheck.shutil, 'which', return_value=None):
            self.assertIsNone(envcheck.open_pr_migrations(Path.cwd()))

    def test_process_detection_is_informational(self):
        with patch.object(envcheck.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = 'air -c .air.toml\nplaywright test'
            result = envcheck.interfering_process_checks(Path.cwd())[0]
            self.assertEqual(result['severity'], 'optional')
            self.assertEqual(result['status'], 'fail')


class GateBaselineTests(unittest.TestCase):
    def test_baseline_does_not_duplicate_domain_gates(self):
        check = {'command': ['pnpm', 'typecheck'], 'tier': 'authoritative'}
        with patch.object(preflight, 'safe_preview', return_value=([{'domain': 'repo'}, {'domain': 'repo'}], None)), \
             patch.object(verification, 'verify_plan', return_value={'checks': [check]}), \
             patch.object(verification, 'selected', return_value=[check]), \
             patch.object(verification, 'run_gates', return_value=[{'status': 'PASS'}]) as run:
            results = preflight.baseline_gates('repo', 'sample')
        self.assertEqual(results[0]['status'], 'PASS')
        self.assertEqual(run.call_count, 1)


class TriagePreventionTests(unittest.TestCase):
    def test_preexisting_gate_blocks_correction_only_when_reproduced(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            handoffs = root / 'handoffs'
            handoffs.mkdir()
            identity = '20260101000000-abc123'
            (handoffs / (identity + '-verifier-1.json')).write_text(json.dumps({
                'verification': [json.dumps({'status': 'FAIL', 'command': ['node', '--test']})]}))
            task = {'id': identity}
            node = {'id': 'verifier', 'agent': 'verifier', 'attempts': 1}
            with patch.object(gatetriage, 'H', root), \
                 patch.object(gatetriage, 'ROOT', root), \
                 patch.object(gatetriage.subprocess, 'run') as git, \
                 patch.object(gatetriage, 'execute_check', return_value={
                     'status': 'FAIL', 'stdoutTail': 'assertion failed', 'stderrTail': '',
                     'log': 'baseline.log'}), \
                 patch.object(gatetriage, 'log'):
                git.return_value.returncode = 0
                self.assertEqual(gatetriage.triage_failed_gate(task, node), 'preexisting')

    def test_unknown_when_baseline_has_missing_dependencies(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            handoffs = root / 'handoffs'
            handoffs.mkdir()
            identity = '20260101000000-abc123'
            (handoffs / (identity + '-verifier-1.json')).write_text(json.dumps({
                'verification': [json.dumps({'status': 'FAIL', 'command': ['pnpm', 'test']})]}))
            with patch.object(gatetriage, 'H', root), \
                 patch.object(gatetriage, 'ROOT', root), \
                 patch.object(gatetriage.subprocess, 'run') as git, \
                 patch.object(gatetriage, 'execute_check', return_value={
                     'status': 'FAIL', 'stdoutTail': 'Cannot find module', 'stderrTail': ''}):
                git.return_value.returncode = 0
                self.assertEqual(gatetriage.triage_failed_gate(
                    {'id': identity}, {'id': 'verifier', 'agent': 'verifier', 'attempts': 1}), 'unknown')


class ProgressPreventionTests(unittest.TestCase):
    def test_long_node_warns_without_cancelling(self):
        with tempfile.TemporaryDirectory() as folder:
            task = {'id': '20260101000000-abc123', 'status': 'active',
                    'dag': [{'id': 'backend', 'status': 'running',
                             'activeStartedAt': '2020-01-01T00:00:00Z'}]}
            with patch.object(progress, 'H', Path(folder)), \
                 patch.object(progress, 'policy', return_value={'parallel': {'longNodeWarningMs': 1000}}):
                warnings = progress.passive_alerts(task, True)
            self.assertTrue(any(item['kind'] == 'long-node' for item in warnings))
            self.assertEqual(task['dag'][0]['status'], 'running')


if __name__ == '__main__':
    unittest.main()
