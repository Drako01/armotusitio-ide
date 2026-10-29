"""Retention: completed cleanup keeps an audit manifest, failed evidence expires, and every deletion stays inside managed paths."""
import contextlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture
from gitenv import git_run
from core import config, retention, worktree, hygiene

OLD = time.time() - 30 * 86400
DONE, FAIL, LIVE = '20261001000000-aaaaaa', '20261001000001-bbbbbb', '20261001000002-cccccc'


@contextlib.contextmanager
def env(**extra):
    with fixture() as root, tempfile.TemporaryDirectory(prefix='redevent-wt-') as trees:
        with contextlib.ExitStack() as stack:
            for module in (retention, worktree):
                stack.enter_context(patch.object(module, 'ROOT', root))
                stack.enter_context(patch.object(module, 'H', root / '.harness'))
            stack.enter_context(patch.dict(os.environ, {'HARNESS_WORKTREE_DIR': trees, 'HARNESS_KEEP_ARTIFACTS': '', **extra}))
            (root / '.harness/state').mkdir(parents=True, exist_ok=True)
            yield root


def write_task(root, status, identity, **extra):
    task = {'schemaVersion': 1, 'id': identity, 'status': status, 'task': 'fixture', 'domain': 'repo', 'agents': ['architect'],
            'createdAt': '2026-09-01T00:00:00.000Z', 'updatedAt': '2026-09-01T00:00:00.000Z',
            'dag': [{'id': 'architect', 'agent': 'architect', 'dependsOn': [], 'status': 'passed', 'attempts': 1}], **extra}
    config.write_json(root / '.harness/tasks' / status / (identity + '.json'), task)
    return task


def touch(path, content='x' * 10, age=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')
    if age is not None:
        os.utime(path, (age, age))
    return path


def artifacts(root, identity, age=None):
    h = root / '.harness'
    found = [touch(h / 'runtime/output' / (identity + '-architect-1-abcdef123456.log'), age=age),
            touch(h / 'runtime' / (identity + '-architect-1-result.json'), '{}', age),
            touch(h / 'runtime' / (identity + '-spec.txt'), age=age),
            touch(h / 'runtime' / ('seeds-' + identity) / 'seed.sql', age=age),
            touch(h / 'logs/execution' / (identity + '-1-aa.json'), '{}', age),
            touch(h / 'handoffs' / (identity + '-architect-1.json'), '{}', age)]
    if age is not None:
        os.utime(h / 'runtime' / ('seeds-' + identity), (age, age))
    return found


class RetentionTests(unittest.TestCase):
    def test_completed_cleanup_keeps_manifest_written_before_deletion(self):
        with env() as root:
            task = write_task(root, 'completed', DONE, pr='https://example/pr/1')
            files = artifacts(root, DONE)
            audit = touch(root / '.harness/logs/audit' / (DONE + '-1-aa.json'), '{}')
            order = []
            real_remove = retention.force_remove

            def spy(path):
                order.append(retention.manifest_file(DONE).exists())
                real_remove(path)
            with patch.object(retention, 'force_remove', spy):
                out = retention.on_task_finished(task)
            self.assertTrue(order and all(order))  # manifest existed before every deletion
            self.assertFalse(any(f.exists() for f in files))
            self.assertTrue(audit.exists())
            manifest = json.loads(retention.manifest_file(DONE).read_text(encoding='utf-8'))
            self.assertEqual((manifest['taskId'], manifest['pr'], manifest['result']), (DONE, 'https://example/pr/1', 'passed'))
            self.assertIn('detailed-logs', manifest['cleanups'][0]['classes'])
            self.assertIn('detailed-logs', out['removed'])
            self.assertTrue((root / '.harness/tasks/completed' / (DONE + '.json')).exists())

    def test_idempotent_second_run_removes_nothing(self):
        with env() as root:
            task = write_task(root, 'completed', DONE)
            artifacts(root, DONE)
            retention.on_task_finished(task)
            before = retention.manifest_file(DONE).read_text(encoding='utf-8')
            again = retention.on_task_finished(task)
            self.assertEqual(again['removed'], {})
            self.assertEqual(before, retention.manifest_file(DONE).read_text(encoding='utf-8'))
            self.assertEqual(retention.sweep(apply=True)['files'], 0)

    def test_keep_artifacts_env_disables_everything(self):
        with env(HARNESS_KEEP_ARTIFACTS='1') as root:
            task = write_task(root, 'completed', DONE)
            files = artifacts(root, DONE, OLD)
            self.assertTrue(retention.on_task_finished(task)['disabled'])
            self.assertTrue(retention.sweep(apply=True)['disabled'])
            self.assertTrue(all(f.exists() for f in files))
            self.assertFalse(retention.manifest_file(DONE).exists())

    def test_failed_kept_until_expiry_then_cleaned_by_sweep(self):
        with env() as root:
            write_task(root, 'failed', FAIL, updatedAt=time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()))
            files = artifacts(root, FAIL, OLD)
            self.assertEqual(retention.sweep(apply=True)['files'], 0)  # fresh failure: evidence kept
            self.assertTrue(all(f.exists() for f in files))
            self.assertEqual(retention.on_task_finished(write_task(root, 'failed', FAIL))['removed'], {})  # never cleaned on finish
            self.assertTrue(all(f.exists() for f in files))
            dry = retention.sweep(apply=False)  # updatedAt 2026-09-01: long expired
            self.assertGreater(dry['files'], 0)
            self.assertTrue(all(f.exists() for f in files))
            self.assertGreater(retention.sweep(apply=True)['files'], 0)
            self.assertFalse(any(f.exists() for f in files))
            self.assertTrue((root / '.harness/tasks/failed' / (FAIL + '.json')).exists())
            self.assertEqual(retention.sweep(apply=True)['files'], 0)

    def test_retention_days_env_extends_window(self):
        with env(HARNESS_RETENTION_DAYS='3650') as root:
            write_task(root, 'failed', FAIL)
            files = artifacts(root, FAIL, OLD)
            self.assertEqual(retention.sweep(apply=True)['files'], 0)
            self.assertTrue(all(f.exists() for f in files))

    def test_checkpoints_protect_failed_task_while_valid(self):
        with env() as root:
            write_task(root, 'failed', FAIL)
            files = artifacts(root, FAIL, OLD)
            checkpoint = touch(root / '.harness/state/checkpoints' / FAIL / 'node.json', '{}')
            self.assertEqual(retention.sweep(apply=True)['files'], 0)
            self.assertTrue(retention.protected(checkpoint, grace=0))
            self.assertTrue(all(f.exists() for f in files) and checkpoint.exists())
            os.utime(checkpoint, (OLD, OLD))
            os.utime(checkpoint.parent, (OLD, OLD))
            self.assertFalse(retention.protected(checkpoint, grace=0))
            self.assertGreater(retention.sweep(apply=True)['files'], 0)
            self.assertFalse(checkpoint.exists())

    def test_active_task_and_active_sources_untouched(self):
        with env() as root:
            write_task(root, 'active', LIVE, source='file:.harness/runtime/live-spec.txt')
            files = artifacts(root, LIVE, OLD)
            spec = touch(root / '.harness/runtime/live-spec.txt', age=OLD)
            retention.on_task_finished(write_task(root, 'completed', DONE, source='file:.harness/runtime/live-spec.txt'))
            retention.on_task_finished({'id': LIVE, 'status': 'completed'})  # still in tasks/active: refused
            retention.sweep(apply=True)
            self.assertTrue(all(f.exists() for f in files) and spec.exists())

    def test_grace_period_protects_recent_files_in_sweep(self):
        with env() as root:
            write_task(root, 'completed', DONE)
            files = artifacts(root, DONE)  # just created
            self.assertEqual(retention.sweep(apply=True)['files'], 0)
            self.assertTrue(all(f.exists() for f in files))

    def test_path_traversal_and_symlink_escape_rejected(self):
        with env() as root, tempfile.TemporaryDirectory() as outside:
            secret = touch(Path(outside) / 'keep.txt')
            h = root / '.harness'
            self.assertTrue(retention.protected(h / 'runtime/../tasks/completed/x.json', grace=0))
            self.assertTrue(retention.protected(secret, grace=0))
            link = h / 'runtime' / (DONE + '-link')
            try:
                os.symlink(outside, link, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('symlinks unavailable')
            self.assertTrue(retention.protected(link, grace=0))
            self.assertTrue(retention.protected(link / 'keep.txt', grace=0))
            nested = touch(h / 'runtime' / (DONE + '-dir') / 'a.txt', age=OLD)
            os.symlink(secret, nested.parent / 'escape.txt')
            retention.on_task_finished(write_task(root, 'completed', DONE))
            self.assertTrue(secret.exists() and nested.exists())  # a directory holding a link is skipped whole

    def test_tracked_files_env_and_locks_never_deleted(self):
        with env() as root:
            git_run(root, 'init', '-q')
            tracked_file = touch(root / '.harness/runtime' / (DONE + '-tracked.json'), '{}', OLD)
            git_run(root, 'add', '-f', str(tracked_file.relative_to(root)))
            dotenv = touch(root / '.harness/runtime' / (DONE + '-.env'), age=OLD)
            lock = touch(root / '.harness/runtime' / (DONE + '-x.lock'), age=OLD)
            user = touch(root / 'user-file.txt', age=OLD)
            root_env = touch(root / '.env', age=OLD)
            workspace_lock = touch(root / '.harness/state/workspace.lock', '{}', OLD)
            retention.on_task_finished(write_task(root, 'completed', DONE))
            retention.sweep(apply=True)
            for kept in (tracked_file, dotenv, lock, user, root_env, workspace_lock):
                self.assertTrue(kept.exists(), kept.name)
            self.assertTrue(retention.protected(tracked_file, grace=0))
            self.assertTrue(retention.protected(workspace_lock, grace=0))

    def test_worktree_removed_and_registry_cleared(self):
        with env() as root:
            git_run(root, 'init', '-q')
            task = write_task(root, 'completed', DONE)
            handle = worktree.Worktree(DONE, 'architect', 1, 'abcdef123456')
            touch(handle.path / 'file.txt')
            config.write_json(worktree.registry_file(handle.name), {'schemaVersion': 1, 'name': handle.name, 'task': DONE, 'node': 'architect',
                                                                   'attempt': 1, 'runId': 'abcdef123456', 'path': str(handle.path)})
            out = retention.on_task_finished(task)
            self.assertIn('worktrees', out['removed'])
            self.assertFalse(handle.path.exists())
            self.assertFalse(worktree.registry_file(handle.name).exists())

    def test_worktree_path_outside_managed_dir_rejected(self):
        with env() as root, tempfile.TemporaryDirectory() as outside:
            task = write_task(root, 'completed', DONE)
            victim = touch(Path(outside) / 'data.txt')
            config.write_json(worktree.registry_file('evil'), {'schemaVersion': 1, 'name': 'evil', 'task': DONE, 'node': 'n', 'attempt': 1,
                                                              'runId': 'abcdef123456', 'path': outside})
            out = retention.on_task_finished(task)
            self.assertTrue(victim.exists())
            self.assertTrue(any('outside' in str(s) for s in out['skipped']))

    def test_cleanup_failure_never_raises(self):
        with env() as root:
            task = write_task(root, 'completed', DONE)
            artifacts(root, DONE)
            with patch.object(retention, 'force_remove', side_effect=PermissionError('locked')):
                out = retention.on_task_finished(task)
            self.assertEqual(out['removed'], {})
            with patch.object(retention, 'process', side_effect=RuntimeError('boom')):
                self.assertTrue(any('error' in str(s) for s in retention.on_task_finished(task)['skipped']))
            self.assertIn('task', retention.on_task_finished({}))

    def test_orphan_seeds_expire(self):
        with env() as root:
            old = touch(root / '.harness/runtime/seeds-zzz/a.sql', age=OLD)
            os.utime(old.parent, (OLD, OLD))
            fresh = touch(root / '.harness/runtime/seeds-new/a.sql')
            retention.sweep(apply=True)
            self.assertFalse(old.exists())
            self.assertTrue(fresh.exists())


class HygieneRetentionCliTests(unittest.TestCase):
    def test_report_is_dry_run_and_apply_removes(self):
        with env() as root:
            write_task(root, 'failed', FAIL)
            files = artifacts(root, FAIL, OLD)
            with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink):
                self.assertEqual(hygiene.main(['--retention-report']), 0)
                self.assertTrue(all(f.exists() for f in files))
                self.assertEqual(hygiene.main(['--apply-retention', '--json']), 0)
            self.assertFalse(any(f.exists() for f in files))

    def test_flags_exclusive_and_defaults_unchanged(self):
        with self.assertRaises(config.UsageError):
            hygiene.parse_args(['--apply-retention', '--retention-report'])
        with self.assertRaises(config.UsageError):
            hygiene.parse_args(['--apply-retention', '--prune-worktrees'])
        self.assertFalse(hygiene.parse_args([])['applyRetention'])


if __name__ == '__main__':
    unittest.main()
