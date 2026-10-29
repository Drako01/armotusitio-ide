"""The Harness state gate: operational state is local, only .gitkeep placeholders may be versioned."""
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SOURCE))
from core import check
from gitenv import GIT_ENV, git_run


class StateGateTest(unittest.TestCase):
    def repo(self, directory):
        root = Path(directory)
        git_run(root, 'init', '-q')
        for name in ['tasks/inbox', 'handoffs', 'state', 'logs/audit']:
            (root / '.harness' / name).mkdir(parents=True)
            (root / '.harness' / name / '.gitkeep').write_text('')
        git_run(root, 'add', '-A')
        return root

    def gate(self, root):
        with patch.object(check, 'ROOT', root), patch.dict(os.environ, GIT_ENV):
            return check.state_gate()

    def test_passes_with_only_gitkeep(self):
        with tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
            self.assertIsNone(self.gate(self.repo(directory)))

    def test_fails_with_versioned_operational_file(self):
        with tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
            root = self.repo(directory)
            (root / '.harness/handoffs/t-architect-1.json').write_text('{}')
            git_run(root, 'add', '-f', '.harness/handoffs/t-architect-1.json')
            with self.assertRaises(ValueError) as error:
                self.gate(root)
            self.assertIn('.harness/handoffs/t-architect-1.json', str(error.exception))
            self.assertIn('git rm --cached --ignore-unmatch -- .harness/handoffs/t-architect-1.json', str(error.exception))

    def test_fails_for_every_operational_folder_and_lookalike_names(self):
        for path in ['runtime/x.json', 'specs/draft.md', 'tasks/sources/t.txt', 'logs/audit/a.json', 'state/.gitkeep.json']:
            with self.subTest(path=path), tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
                root = self.repo(directory)
                target = root / '.harness' / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('x')
                git_run(root, 'add', '-f', '.harness/' + path)
                with self.assertRaises(ValueError) as error:
                    self.gate(root)
                self.assertIn('.harness/' + path, str(error.exception))

    def test_untracked_operational_file_is_allowed(self):
        with tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
            root = self.repo(directory)
            (root / '.harness/state/t.json').write_text('{}')
            self.assertIsNone(self.gate(root))

    def test_skipped_without_git_repository(self):
        with tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
            root = Path(directory)
            (root / '.harness/state').mkdir(parents=True)
            (root / '.harness/state/t.json').write_text('{}')
            with patch.dict(os.environ, {'GIT_CEILING_DIRECTORIES': str(root.parent)}):
                self.assertIsNone(self.gate(root))

    def test_gitkeep_outside_expected_list_or_with_content_is_a_violation(self):
        for path, content in [('specs/.gitkeep', ''), ('tasks/sources/.gitkeep', ''), ('state/.gitkeep', 'x')]:
            with self.subTest(path=path), tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
                root = self.repo(directory)
                target = root / '.harness' / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
                git_run(root, 'add', '-f', '.harness/' + path)
                with self.assertRaises(ValueError) as error:
                    self.gate(root)
                self.assertIn('.harness/' + path, str(error.exception))

    def test_query_is_anchored_to_the_git_toplevel(self):
        with tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
            root = Path(directory)
            git_run(root, 'init', '-q')
            nested = root / 'sub'
            (nested / '.harness/state').mkdir(parents=True)
            (nested / '.harness/state/t.json').write_text('{}')
            git_run(root, 'add', '-f', 'sub/.harness/state/t.json')
            with self.assertRaises(ValueError) as error:
                self.gate(nested)
            self.assertIn('.harness/state/t.json', str(error.exception))

    def test_git_error_other_than_not_a_repository_fails_closed(self):
        failed = subprocess.CompletedProcess([], 128, b'', b'fatal: unable to read config')
        dubious = subprocess.CompletedProcess([], 128, b'', b'fatal: detected dubious ownership in repository')
        for result in [failed, dubious]:
            with self.subTest(stderr=result.stderr), tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
                root = self.repo(directory)
                with patch.object(subprocess, 'run', return_value=result):
                    with self.assertRaises(ValueError):
                        self.gate(root)

    def test_git_timeout_or_missing_binary_fails_closed(self):
        for error in [subprocess.TimeoutExpired('git', 30), FileNotFoundError('git')]:
            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
                root = self.repo(directory)
                with patch.object(subprocess, 'run', side_effect=error):
                    with self.assertRaises(ValueError):
                        self.gate(root)

    def test_reads_use_safe_directory(self):
        calls = []
        real = subprocess.run

        def spy(command, *args, **kwargs):
            calls.append(command)
            return real(command, *args, **kwargs)
        with tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
            root = self.repo(directory)
            with patch.object(subprocess, 'run', side_effect=spy):
                self.gate(root)
        self.assertTrue(calls and all('safe.directory=' in ' '.join(c) for c in calls))

    def test_git_runs_with_c_locale_so_missing_repository_detection_is_stable(self):
        envs = []
        real = subprocess.run

        def spy(command, *args, **kwargs):
            envs.append(kwargs.get('env'))
            return real(command, *args, **kwargs)
        with tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
            root = Path(directory)
            with patch.dict(os.environ, {'GIT_CEILING_DIRECTORIES': str(root.parent), 'LANG': 'es_ES.UTF-8',
                                         'LC_ALL': 'es_ES.UTF-8'}), patch.object(subprocess, 'run', side_effect=spy):
                self.assertIsNone(self.gate(root))
        self.assertTrue(envs and all(e and e['LC_ALL'] == 'C' for e in envs))

    def test_fix_command_quotes_paths_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
            root = self.repo(directory)
            (root / '.harness/state/my file.json').write_text('{}')
            git_run(root, 'add', '-f', '.harness/state/my file.json')
            with self.assertRaises(ValueError) as error:
                self.gate(root)
            self.assertIn("-- '.harness/state/my file.json'", str(error.exception))

    def test_many_offenders_suggest_the_pipeline_form(self):
        with tempfile.TemporaryDirectory(prefix='redevent-gate-') as directory:
            root = self.repo(directory)
            for number in range(21):
                (root / '.harness/state' / ('t%d.json' % number)).write_text('{}')
            git_run(root, 'add', '-f', '.harness/state')
            with self.assertRaises(ValueError) as error:
                self.gate(root)
            message = str(error.exception)
            self.assertIn("grep -zv '/\\.gitkeep$' | xargs -0 git rm --cached --", message)
            self.assertIn('(+1)', message)

    def test_gitignore_covers_loose_files_and_keeps_gitkeep(self):
        cases = {'tasks/x.json': True, 'logs/x.json': True, 'tasks/inbox/a.md': True, 'logs/audit/a.json': True,
                 'tasks/inbox/.gitkeep': False, 'logs/audit/.gitkeep': False}
        # Certify only the repository policy, independently of the user's local
        # info/exclude, global ignore file and Git initialization templates.
        with tempfile.TemporaryDirectory(prefix='redevent-ignore-') as directory:
            root = Path(directory)
            git_run(root, 'init', '-q', '--template=')
            (root / '.gitignore').write_bytes((SOURCE.parent / '.gitignore').read_bytes())
            for path, ignored in cases.items():
                with self.subTest(path=path):
                    target = root / '.harness' / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text('')
                    run = git_run(root, '-c', 'safe.directory=' + str(root), '-c', 'core.excludesFile=',
                                  'check-ignore', '-q', '--no-index', '.harness/' + path, check=False)
                    self.assertIn(run.returncode, (0, 1), run.stderr)
                    self.assertEqual(run.returncode == 0, ignored)


if __name__ == '__main__':
    unittest.main()
