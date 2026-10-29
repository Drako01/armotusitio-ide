"""Gate cache: key invalidation, PASS-only reuse, bounded/atomic local store, disabled-by-default remote, flaky + telemetry hooks."""
import json
import os
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import fixture
from test_impact import js_fixture, write
import contextlib
import core
from core import config, gatecache, verification

LINT = ['pnpm', '--filter', './packages/x', 'lint']
ITEM = {'command': LINT, 'tier': 'targeted', 'reason': 't', 'requires': []}
VERSIONS = {'node': 'v20.20.0', 'pnpm': '9.0.0'}


def versions(overrides=None):
    return patch.object(gatecache, 'tool_version', side_effect=lambda name: {**VERSIONS, **(overrides or {})}.get(name))


def outcome(status, **extra):
    return {'command': LINT, 'tier': 'targeted', 'reason': 't', 'requires': [], 'status': status, 'exit': 0 if status == 'PASS' else 1,
            'durationMs': 7, 'log': None, 'skipReason': None, 'stdoutTail': '', 'stderrTail': '', **extra}


class KeyTests(unittest.TestCase):
    def key(self, item=ITEM):
        with versions():
            return gatecache.cache_key(item)

    def test_key_is_stable_and_hex(self):
        with fixture() as root:
            js_fixture(root)
            self.assertEqual(self.key(), self.key())
            self.assertRegex(self.key(), r'^[0-9a-f]{64}$')

    def test_unknown_inputs_have_no_key_so_they_always_run(self):
        with fixture() as root:
            js_fixture(root)
            self.assertIsNone(self.key({**ITEM, 'command': ['bash', './verify-enterprise.sh', '--full']}))
            self.assertIsNone(self.key({**ITEM, 'command': ['pnpm', '--filter', './packages/x', 'build']}))  # build produces artifacts
            self.assertIsNone(self.key({**ITEM, 'command': ['pnpm', '--filter', './nope', 'lint']}))

    def test_content_of_unchanged_but_relevant_files_changes_the_key(self):
        with fixture() as root:
            js_fixture(root)
            before = self.key()
            write(root, 'packages/x/src/other.ts', 'export const a = 1')  # not "changed" by git, still an input
            added = self.key()
            self.assertNotEqual(before, added)
            write(root, 'packages/x/src/other.ts', 'export const a = 2')
            self.assertNotEqual(added, self.key())
            write(root, 'apps/z/src/unrelated.ts', 'x')  # a workspace x does not depend on
            self.assertEqual(self.key(), self.key())
            stable = self.key()
            write(root, 'packages/x/node_modules/pkg/index.js', 'ignored')
            self.assertEqual(stable, self.key())  # node_modules is not an input

    def test_dependency_workspace_content_is_an_input(self):
        with fixture() as root:
            js_fixture(root)
            item = {**ITEM, 'command': ['pnpm', '--filter', './apps/y', 'typecheck']}
            before = self.key(item)
            write(root, 'packages/x/src/a.ts', 'changed dependency')
            self.assertNotEqual(before, self.key(item))

    def test_env_allowlist_tool_versions_and_config_invalidate(self):
        with fixture() as root:
            js_fixture(root)
            base = self.key()
            with patch.dict(os.environ, {'NODE_ENV': 'production'}):
                self.assertNotEqual(base, self.key())
            with patch.dict(os.environ, {'NOT_ALLOWLISTED_VAR': 'x'}):
                self.assertEqual(base, self.key())
            with versions({'node': 'v22.0.0'}):
                self.assertNotEqual(base, gatecache.cache_key(ITEM))
            with versions({'pnpm': '10.0.0'}):
                self.assertNotEqual(base, gatecache.cache_key(ITEM))
            policies = root / '.harness/manifests/policies.json'
            policies.write_text(policies.read_text(encoding='utf-8') + '\n', encoding='utf-8')
            self.assertNotEqual(base, self.key())

    def test_missing_tool_version_means_no_key(self):
        with fixture() as root:
            js_fixture(root)
            with versions({'pnpm': None}):
                self.assertIsNone(gatecache.cache_key(ITEM))

    def test_command_change_changes_key(self):
        with fixture() as root:
            js_fixture(root)
            self.assertNotEqual(self.key(), self.key({**ITEM, 'command': ['pnpm', '--filter', './packages/x', 'test']}))

    def test_paths_are_posix_and_windows_safe(self):
        with fixture() as root:
            js_fixture(root)
            digest = gatecache.digest_paths(['packages/x'], root)
            self.assertRegex(digest, r'^[0-9a-f]{64}$')
            self.assertEqual(digest, gatecache.digest_paths(['./packages/x'.lstrip('./')], root))


class LocalCacheTests(unittest.TestCase):
    def test_only_pass_is_stored(self):
        with fixture() as root:
            cache = gatecache.LocalCache()
            self.assertFalse(cache.put('k1', {'status': 'FAIL'}))
            self.assertFalse(cache.put('k2', {'status': 'SKIPPED_ENVIRONMENT'}))
            self.assertIsNone(cache.get('k1'))
            self.assertTrue(cache.put('k3', {'status': 'PASS', 'durationMs': 5}))
            self.assertEqual(cache.get('k3')['durationMs'], 5)
            self.assertEqual(cache.path, root / '.harness/state/gate-cache.json')

    def test_ttl_and_size_bounds(self):
        with fixture():
            cache = gatecache.LocalCache(ttl=60, limit=3)
            for n in range(5):
                cache.put(f'k{n}', {'status': 'PASS'})
                time.sleep(0.01)
            self.assertEqual(sorted(cache.load()), ['k2', 'k3', 'k4'])
            with patch.object(gatecache.time, 'time', return_value=time.time() + 3600):
                self.assertIsNone(cache.get('k4'))

    def test_invalidate_one_and_all(self):
        with fixture():
            cache = gatecache.LocalCache()
            cache.put('a', {'status': 'PASS'})
            cache.put('b', {'status': 'PASS'})
            self.assertEqual(cache.invalidate('a'), 1)
            self.assertIsNone(cache.get('a'))
            self.assertIsNotNone(cache.get('b'))
            self.assertEqual(cache.invalidate(), 1)
            self.assertIsNone(cache.get('b'))

    def test_corrupt_or_foreign_file_is_a_miss_never_an_error(self):
        with fixture() as root:
            cache = gatecache.LocalCache()
            cache.path.parent.mkdir(parents=True, exist_ok=True)
            cache.path.write_text('{not json', encoding='utf-8')
            self.assertIsNone(cache.get('k'))
            cache.path.write_text(json.dumps({'schemaVersion': 99, 'entries': {'k': {'status': 'PASS', 'at': time.time()}}}), encoding='utf-8')
            self.assertIsNone(cache.get('k'))
            self.assertTrue(cache.put('k', {'status': 'PASS'}))  # recovers by rewriting

    def test_concurrent_writers_keep_the_file_valid_and_lose_nothing(self):
        with fixture():
            cache = gatecache.LocalCache(limit=100)
            threads = [threading.Thread(target=cache.put, args=(f'k{n}', {'status': 'PASS'})) for n in range(20)]
            [t.start() for t in threads]
            [t.join() for t in threads]
            self.assertEqual(len(cache.load()), 20)
            json.loads(cache.path.read_text(encoding='utf-8'))
            self.assertEqual([p.name for p in cache.path.parent.glob('*.tmp')], [])


class ExecuteTests(unittest.TestCase):
    def runner(self, statuses, calls, mutate=None):
        queue = list(statuses)

        def run():
            calls.append(1)
            if mutate:
                mutate()
            return outcome(queue.pop(0) if len(queue) > 1 else queue[0])
        return run

    def test_pass_is_reused_until_an_input_changes(self):
        with fixture() as root, versions():
            js_fixture(root)
            cache, calls = gatecache.LocalCache(), []
            first = gatecache.execute(ITEM, self.runner(['PASS'], calls), cache)
            second = gatecache.execute(ITEM, self.runner(['PASS'], calls), cache)
            self.assertEqual(len(calls), 1)
            self.assertTrue(second['cached'])
            self.assertEqual((second['status'], second['savedMs'], second['durationMs']), ('PASS', 7, 0))
            self.assertNotIn('cached', first)
            write(root, 'packages/x/src/a.ts', 'edited')
            gatecache.execute(ITEM, self.runner(['PASS'], calls), cache)
            self.assertEqual(len(calls), 2)

    def test_env_and_tool_version_change_force_a_rerun(self):
        with fixture() as root:
            js_fixture(root)
            cache, calls = gatecache.LocalCache(), []
            with versions():
                gatecache.execute(ITEM, self.runner(['PASS'], calls), cache)
                with patch.dict(os.environ, {'CI': 'changed-' + os.environ.get('CI', '')}):  # always differs, also where CI is already set
                    gatecache.execute(ITEM, self.runner(['PASS'], calls), cache)
            with versions({'node': 'v99'}):
                gatecache.execute(ITEM, self.runner(['PASS'], calls), cache)
            self.assertEqual(len(calls), 3)

    def test_a_failure_is_never_stored_or_reused(self):
        with fixture() as root, versions():
            js_fixture(root)
            cache, calls = gatecache.LocalCache(), []
            self.assertEqual(gatecache.execute(ITEM, self.runner(['FAIL'], calls), cache)['status'], 'FAIL')
            self.assertEqual(cache.load(), {})
            again = gatecache.execute(ITEM, self.runner(['PASS'], calls), cache)
            self.assertEqual((len(calls), again['status']), (2, 'PASS'))

    def test_pass_that_modified_its_own_inputs_is_not_stored(self):
        with fixture() as root, versions():
            js_fixture(root)
            cache, calls = gatecache.LocalCache(), []
            gatecache.execute(ITEM, self.runner(['PASS'], calls, mutate=lambda: write(root, 'packages/x/src/gen.ts', str(time.time()))), cache)
            self.assertEqual(cache.load(), {})

    def test_uncacheable_check_always_runs(self):
        with fixture():
            cache, calls = gatecache.LocalCache(), []
            item = {**ITEM, 'command': [sys.executable, '-B', '-c', 'pass']}
            gatecache.execute(item, self.runner(['PASS'], calls), cache)
            gatecache.execute(item, self.runner(['PASS'], calls), cache)
            self.assertEqual(len(calls), 2)

    def test_cache_disabled_by_policy_or_env(self):
        with fixture():
            self.assertIsNotNone(gatecache.default_cache())
            with patch.dict(os.environ, {'HARNESS_GATE_CACHE': '0'}):
                self.assertIsNone(gatecache.default_cache())

    def test_hit_and_miss_are_recorded_through_optional_telemetry(self):
        events = []
        fake = types.ModuleType('core.telemetry')
        fake.record = lambda kind, **fields: events.append((kind, fields))
        with fixture() as root, versions(), patch.dict(sys.modules, {'core.telemetry': fake}), patch.object(core, 'telemetry', fake, create=True):
            js_fixture(root)
            cache, calls = gatecache.LocalCache(), []
            gatecache.execute(ITEM, self.runner(['PASS'], calls), cache)
            gatecache.execute(ITEM, self.runner(['PASS'], calls), cache)
        self.assertEqual([(k, f['hit']) for k, f in events], [('cache', False), ('cache', True)])
        self.assertEqual(events[1][1]['savedMs'], 7)

    def test_telemetry_failures_never_break_a_gate(self):
        fake = types.ModuleType('core.telemetry')
        fake.record = lambda kind, **fields: 1 / 0
        with fixture() as root, versions(), patch.dict(sys.modules, {'core.telemetry': fake}), patch.object(core, 'telemetry', fake, create=True):
            js_fixture(root)
            self.assertEqual(gatecache.execute(ITEM, self.runner(['PASS'], []), gatecache.LocalCache())['status'], 'PASS')


class RemoteTests(unittest.TestCase):
    def test_remote_is_disabled_by_default_and_abstract(self):
        # A developer's local Redis (redevent-local) must not leak into the default: the opt-out keeps the probe off.
        with fixture(), patch.dict(os.environ, {'HARNESS_REDIS': '0'}):
            os.environ.pop('HARNESS_GATE_CACHE_REMOTE', None)
            self.assertIsNone(gatecache.load_remote())
            self.assertIsNone(gatecache.default_cache().remote)
            for call in (lambda: gatecache.RemoteCache().get('k'), lambda: gatecache.RemoteCache().put('k', {}), lambda: gatecache.RemoteCache().invalidate()):
                with self.assertRaises(NotImplementedError):
                    call()

    def test_bad_remote_module_is_ignored(self):
        with fixture(), patch.dict(os.environ, {'HARNESS_GATE_CACHE_REMOTE': 'no_such_module_for_harness'}):
            self.assertIsNone(gatecache.load_remote())

    def test_remote_layer_is_read_through_and_errors_are_swallowed(self):
        class Memory(gatecache.RemoteCache):
            def __init__(self):
                self.data = {}

            def get(self, key):
                return self.data.get(key)

            def put(self, key, entry):
                self.data[key] = entry

            def invalidate(self, key=None):
                self.data.clear()

        class Broken(Memory):
            def get(self, key):
                raise OSError('down')

            def put(self, key, entry):
                raise OSError('down')
        with fixture():
            remote = Memory()
            remote.data['k'] = {'status': 'PASS', 'durationMs': 3, 'at': time.time()}
            remote.data['bad'] = {'status': 'FAIL', 'at': time.time()}
            layered = gatecache.LayeredCache(gatecache.LocalCache(), remote)
            self.assertEqual(layered.get('k')['durationMs'], 3)
            self.assertIsNotNone(layered.local.get('k'))  # promoted locally
            self.assertIsNone(layered.get('bad'))  # a remote failure entry is never reused
            broken = gatecache.LayeredCache(gatecache.LocalCache(), Broken())
            self.assertIsNone(broken.get('zzz'))
            self.assertTrue(broken.put('y', {'status': 'PASS'}))


class FlakyTests(unittest.TestCase):
    def flaky_module(self, analysis, critical=False):
        fake = types.ModuleType('core.flaky')
        fake.analyze_gate_output = lambda output, retried_passed=False: analysis
        fake.is_critical = lambda test: critical
        return self.install(fake)

    @staticmethod
    def install(fake):
        stack = contextlib.ExitStack()
        stack.enter_context(patch.dict(sys.modules, {'core.flaky': fake}))
        stack.enter_context(patch.object(core, 'flaky', fake, create=True))
        return stack

    def failing(self, **extra):
        return lambda: outcome('FAIL', stdoutTail='1 failed', **extra)

    ANALYSIS = {'failures': ['t1'], 'quarantined': ['t1'], 'blocking': [], 'category': 'flaky', 'all_quarantined': True}

    def test_known_flaky_pattern_retries_once_and_a_pass_is_reported(self):
        with fixture():
            calls = []
            replies = [outcome('FAIL', stderrTail='read ECONNRESET'), outcome('PASS')]
            with patch.object(config, 'policy', return_value={'flakyPatterns': ['ECONNRESET'], 'generatedArtifacts': []}):
                result = gatecache.execute(ITEM, lambda: (calls.append(1), replies.pop(0))[1], None)
            self.assertEqual((result['status'], len(calls)), ('PASS', 2))
            self.assertTrue(result['flakyRetry'] and result['retried'])

    def test_retry_is_single_and_a_second_failure_stays_a_failure(self):
        with fixture():
            calls = []
            with patch.object(config, 'policy', return_value={'flakyPatterns': ['ECONNRESET'], 'generatedArtifacts': []}):
                result = gatecache.execute(ITEM, lambda: (calls.append(1), outcome('FAIL', stderrTail='ECONNRESET'))[1], None)
            self.assertEqual((result['status'], len(calls)), ('FAIL', 2))

    def test_no_patterns_means_no_retry(self):
        with fixture():
            calls = []
            gatecache.execute(ITEM, lambda: (calls.append(1), outcome('FAIL', stderrTail='ECONNRESET'))[1], None)
            self.assertEqual(len(calls), 1)

    def test_fully_quarantined_non_critical_failure_is_reported_apart_and_does_not_fail(self):
        with fixture(), self.flaky_module(self.ANALYSIS):
            result = gatecache.execute(ITEM, self.failing(), None)
            self.assertTrue(result['quarantined'])
            self.assertEqual(result['status'], 'FAIL')  # the raw status is kept; the aggregate decides
            self.assertEqual(verification.overall([result]), 'PASS')
            plan = {'checks': [ITEM], 'risk': 'LOW', 'domains': []}
            with patch.object(verification, 'execute_check', return_value=result):
                summary = verification.run_plan(plan, 1000, concurrency=1)
            self.assertEqual(summary['status'], 'PASS')
            self.assertEqual(len(summary['quarantined']), 1)
            report = verification.render_report(summary)
            self.assertIn('Quarantined', report)
            self.assertNotIn('Failures', report)

    def test_blocking_or_critical_failures_still_fail(self):
        with fixture():
            blocking = {**self.ANALYSIS, 'blocking': ['t2'], 'all_quarantined': False}
            with self.flaky_module(blocking):
                self.assertNotIn('quarantined', gatecache.execute(ITEM, self.failing(), None))
            with self.flaky_module(self.ANALYSIS, critical=True):
                result = gatecache.execute(ITEM, self.failing(), None)
                self.assertNotIn('quarantined', result)
                self.assertEqual(verification.overall([result]), 'FAIL')

    def test_missing_or_broken_flaky_module_fails_closed(self):
        with fixture():
            with patch.dict(sys.modules, {'core.flaky': None}), patch.object(core, 'flaky', None, create=True):
                self.assertNotIn('quarantined', gatecache.execute(ITEM, self.failing(), None))
            fake = types.ModuleType('core.flaky')
            fake.analyze_gate_output = lambda *a, **k: 1 / 0
            with self.install(fake):
                self.assertNotIn('quarantined', gatecache.execute(ITEM, self.failing(), None))


if __name__ == '__main__':
    unittest.main()
