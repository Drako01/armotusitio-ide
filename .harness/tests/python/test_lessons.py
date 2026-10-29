"""Learning-from-errors loop: catalog, relevance, local observations and prompt injection (temp dirs only)."""
import contextlib
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SOURCE))
from core import config, lessons, delegation


def lesson(id, severity='medium', count=0, domains=(), agents=(), trigger=''):
    return {'id': id, 'title': 'Titulo ' + id, 'trigger': trigger, 'advice': 'Consejo ' + id,
            'appliesTo': {'domains': list(domains), 'agents': list(agents)}, 'severity': severity, 'count': count}


@contextlib.contextmanager
def harness(catalog=None):
    with tempfile.TemporaryDirectory(prefix='redevent-lessons-test-') as directory:
        h = Path(directory) / '.harness'
        (h / 'lessons').mkdir(parents=True)
        (h / 'state').mkdir()
        if catalog is not None:
            (h / 'lessons' / 'lessons.json').write_text(json.dumps({'schemaVersion': 1, 'lessons': catalog}), encoding='utf-8')
        with patch.object(config, 'H', h):
            yield h


class CatalogTests(unittest.TestCase):
    def test_real_catalog_is_valid_and_seeded(self):
        catalog = json.loads((SOURCE / 'lessons' / 'lessons.json').read_text(encoding='utf-8'))
        self.assertEqual(catalog['schemaVersion'], 1)
        self.assertGreaterEqual(len(catalog['lessons']), 10)  # seeded with 10; `harness:lessons add` grows it
        for item in catalog['lessons']:
            self.assertTrue({'id', 'title', 'trigger', 'advice', 'appliesTo', 'severity', 'count'} <= item.keys())
            self.assertIn(item['severity'], ['high', 'medium', 'low'])

    def test_load_catalog(self):
        with harness([lesson('L1')]):
            self.assertEqual(lessons.load_catalog()['lessons'][0]['id'], 'L1')
        with harness():
            self.assertEqual(lessons.load_catalog()['lessons'], [])

    def test_filter_by_domain_and_agent(self):
        with harness([lesson('all'), lesson('api', domains=['api']), lesson('tester', agents=['tester'])]):
            self.assertEqual({l['id'] for l in lessons.relevant('web', ['backend'])}, {'all'})
            self.assertEqual({l['id'] for l in lessons.relevant('api', ['backend'])}, {'all', 'api'})
            self.assertEqual({l['id'] for l in lessons.relevant('web', ['tester'])}, {'all', 'tester'})

    def test_limit_and_ordering(self):
        items = [lesson('low9', 'low', 9), lesson('med1', 'medium', 1), lesson('med5', 'medium', 5), lesson('high0', 'high', 0)] + [lesson(f'x{i}', 'low', 0) for i in range(5)]
        with harness(items):
            self.assertEqual([l['id'] for l in lessons.relevant('d', ['a'], limit=4)], ['high0', 'med5', 'med1', 'low9'])
            self.assertEqual(len(lessons.relevant('d', ['a'])), 5)

    def test_recurrence_reorders(self):
        with harness([lesson('a', count=1, trigger='boom'), lesson('b', count=2)]):
            self.assertEqual(lessons.relevant('d', ['x'])[0]['id'], 'b')
            for _ in range(3):
                lessons.observe({'domain': 'd'}, {'agent': 'x'}, 'agent-result', 'boom happened')
            self.assertEqual(lessons.relevant('d', ['x'])[0]['id'], 'a')


class ObserveTests(unittest.TestCase):
    def test_counting_and_normalization(self):
        with harness([lesson('S', trigger='security-denial')]) as h:
            task, node = {'domain': 'api'}, {'agent': 'backend'}
            lessons.observe(task, node, 'security-denial', 'Write F:\\redevent\\apps\\x.go failed in 20260101120000-abc123 after 42 tries')
            lessons.observe(task, node, 'security-denial', 'write /home/u/y.go failed in 20260202130000-def456 after 7 tries')
            data = json.loads((h / 'state' / 'lessons-observed.json').read_text(encoding='utf-8'))
            self.assertEqual(len(data['entries']), 1)
            entry = data['entries'][0]
            self.assertEqual((entry['count'], entry['agent'], entry['domain'], entry['category']), (2, 'backend', 'api', 'security-denial'))
            self.assertEqual(entry['reason'], 'write <path> failed in <id> after <n> tries')
            self.assertIn('lastSeen', entry)
            self.assertEqual(data['recurrence'], {'S': 2})

    def test_reason_is_bounded(self):
        self.assertEqual(len(lessons.normalize('x' * 500)), 160)

    def test_never_raises(self):
        with harness([lesson('A')]) as h:
            (h / 'state' / 'lessons-observed.json').write_text('{corrupt', encoding='utf-8')
            lessons.observe(None, None, 'x', None)
            with patch.object(lessons, 'write_json', side_effect=OSError('disk')):
                lessons.observe({'domain': 'd'}, {'agent': 'a'}, 'x', 'r')
        with patch.object(config, 'H', Path('/nonexistent-root/.harness')):
            lessons.observe({'domain': 'd'}, {'agent': 'a'}, 'x', 'r')

    def test_thread_safe(self):
        with harness([]) as h:
            threads = [threading.Thread(target=lessons.observe, args=({'domain': 'd'}, {'agent': 'a'}, 'c', 'same')) for _ in range(12)]
            [t.start() for t in threads]
            [t.join() for t in threads]
            self.assertEqual(json.loads((h / 'state' / 'lessons-observed.json').read_text(encoding='utf-8'))['entries'][0]['count'], 12)


class AddAndRenderTests(unittest.TestCase):
    def test_add_and_dedupe(self):
        with harness([lesson('L001')]) as h, patch.dict(os.environ, {'HARNESS_OWNER': 'Drako'}, clear=False):
            new = lessons.add('Nueva  Leccion!', 'Hacer esto', 'high')
            self.assertRegex(new, r'^drako_\d{14}$')  # owner_timestamp: devs independientes nunca colisionan
            self.assertEqual(lessons.add('nueva leccion', 'otro texto'), new)
            stored = json.loads((h / 'lessons' / 'lessons.json').read_text(encoding='utf-8'))['lessons']
            self.assertEqual([l['id'] for l in stored], ['L001', new])
            self.assertEqual(stored[1]['severity'], 'high')
            with self.assertRaises(config.UsageError):
                lessons.add('x', 'y', 'urgent')

    def test_new_id_owner_fallback_and_collision(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertTrue(lessons.new_id(set()).startswith('dev_'))
        with patch.dict(os.environ, {'HARNESS_HOST': 'Claude'}, clear=True):
            self.assertTrue(lessons.new_id(set()).startswith('claude_'))
        with patch.dict(os.environ, {'HARNESS_OWNER': 'Drako', 'HARNESS_HOST': 'Claude'}, clear=True):
            first = lessons.new_id(set())
            self.assertTrue(first.startswith('drako_'))
            second = lessons.new_id({first})
            self.assertNotEqual(first, second)
            self.assertTrue(second.startswith(first + '_'))

    def test_render_and_cli(self):
        self.assertEqual(lessons.render_block([]), '')
        self.assertIn('Consejo A', lessons.render_block([lesson('A', 'high')]))
        with harness([lesson('A')]):
            self.assertEqual(lessons.main(['add', 'T', 'C', '--severity', 'low']), 0)
            self.assertEqual(lessons.main(['--json']), 0)
            self.assertEqual(lessons.main([]), 0)
            with self.assertRaises(config.UsageError):
                lessons.main(['add', 'solo-titulo'])


class PromptTests(unittest.TestCase):
    def prompt(self, budget=100000):
        task = {'id': 't1', 'task': 'do', 'domain': 'api'}
        ctx = {'verification': [], 'skills': [{'name': 's', 'description': 'd', 'path': 'p'}], 'tokenBudget': budget}
        with patch.object(delegation, 'budget', lambda *values: min(v for v in values if v is not None)):  # policies.json is not in the temp harness
            return delegation.delegation_prompt(task, {'agent': 'backend'}, {'name': 'backend'}, ctx, [])

    def test_injected_only_when_present(self):
        with harness([lesson(f'L{i}', count=i) for i in range(8)]):
            value = json.loads(self.prompt())
            self.assertEqual(len(value['lessons']), 5)
            self.assertEqual(set(value['lessons'][0]), {'id', 'title', 'advice'})
        with harness([lesson('only-tester', agents=['tester'])]):
            self.assertNotIn('lessons', json.loads(self.prompt()))
        with harness():
            self.assertNotIn('lessons', json.loads(self.prompt()))

    def test_lessons_dropped_before_budget_failure(self):
        with harness():
            limit = config.tokenize(self.prompt()) + 5
        with harness([lesson('A')]):
            self.assertNotIn('lessons', json.loads(self.prompt(limit)))


if __name__ == '__main__':
    unittest.main()
