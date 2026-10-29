"""Learning from errors: a versioned lesson catalog plus a local, best-effort log of observed failures."""
import json
import os
import re
import threading
from . import config
from .config import UsageError, dumps, now, read_json, write_json

SEVERITY = {'high': 0, 'medium': 1, 'low': 2}
LOCK = threading.Lock()


def catalog_file():
    return config.H / 'lessons' / 'lessons.json'


def observed_file():
    return config.H / 'state' / 'lessons-observed.json'


def load_catalog():
    """Validated catalog; a missing file is an empty catalog, a corrupt one is an error for explicit callers."""
    file = catalog_file()
    if not file.exists():
        return {'schemaVersion': 1, 'lessons': []}
    catalog = read_json(file)
    if catalog.get('schemaVersion') != 1 or not isinstance(catalog.get('lessons'), list):
        raise ValueError('Lessons catalog invalid: schemaVersion 1 and lessons[] required')
    return catalog


def load_observed():
    try:
        value = read_json(observed_file())
        if isinstance(value, dict) and isinstance(value.get('entries'), list):
            return value
    except Exception:
        pass
    return {'schemaVersion': 1, 'entries': [], 'recurrence': {}}


def normalize(reason):
    """Stable fingerprint of a failure reason: no paths, ids or numbers, lowercase, bounded."""
    text = str(reason or '').lower()
    text = re.sub(r'(?:[a-z]:)?[\w.~-]*[\\/][^\s\'",;)]*', '<path>', text)
    text = re.sub(r'\b\d{8,}-[0-9a-f]+\b|\b[0-9a-f]{6,}\b', '<id>', text)
    text = re.sub(r'\d+', '<n>', text)
    return re.sub(r'\s+', ' ', text).strip()[:160]


def matches(lesson, category, reason):
    trigger = str(lesson.get('trigger') or '')
    if not trigger:
        return False
    if trigger == category:
        return True
    try:
        return bool(re.search(trigger, str(category) + ' ' + str(reason), re.I))
    except re.error:
        return False


def relevant(domain, agents, limit=5):
    """Lessons applicable to the domain/agents, most severe then most recurrent first."""
    try:
        recurrence = load_observed().get('recurrence', {})
        agents = [agents] if isinstance(agents, str) else list(agents or [])
        found = []
        for lesson in load_catalog()['lessons']:
            applies = lesson.get('appliesTo') or {}
            if applies.get('domains') and domain not in applies['domains']:
                continue
            if applies.get('agents') and not set(applies['agents']) & set(agents):
                continue
            found.append(lesson)
        found.sort(key=lambda l: (SEVERITY.get(l.get('severity'), 3), -(int(l.get('count', 0)) + int(recurrence.get(l.get('id'), 0))), l.get('id', '')))
        return found[:max(0, limit)]
    except Exception:
        return []


def observe(task, node, category, reason):
    """Records one failure locally and bumps the recurrence of matching lessons. Never raises."""
    try:
        text = normalize(reason)
        agent, domain = (node or {}).get('agent'), (task or {}).get('domain')
        with LOCK:
            observed = load_observed()
            entry = next((e for e in observed['entries'] if (e.get('category'), e.get('reason'), e.get('agent'), e.get('domain')) == (category, text, agent, domain)), None)
            if entry is None:
                entry = {'category': category, 'reason': text, 'agent': agent, 'domain': domain, 'count': 0}
                observed['entries'].append(entry)
            entry['count'] += 1
            entry['lastSeen'] = now()
            recurrence = observed.setdefault('recurrence', {})
            for lesson in load_catalog()['lessons']:
                if matches(lesson, category, str(reason or '')[:2000]):  # raw reason: triggers may name paths
                    recurrence[lesson['id']] = int(recurrence.get(lesson['id'], 0)) + 1
            observed['entries'] = observed['entries'][-200:]
            write_json(observed_file(), observed)
    except Exception:
        pass


def slug(title):
    return re.sub(r'[^a-z0-9]+', ' ', str(title).lower()).strip()


def new_id(existing_ids):
    """owner_timestamp (UTC, YYYYMMDDHHMMSS), so independent devs never collide on the same id.

    owner comes from HARNESS_OWNER, falls back to HARNESS_HOST, then to 'dev' when neither is set.
    """
    owner = os.environ.get('HARNESS_OWNER') or os.environ.get('HARNESS_HOST') or 'dev'
    base = re.sub(r'[^a-z0-9]+', '', owner.lower()) or 'dev'
    stamp = now().replace('-', '').replace(':', '').replace('T', '').split('.')[0].rstrip('Z')
    candidate, suffix = f'{base}_{stamp}', 0
    while candidate in existing_ids:
        suffix += 1
        candidate = f'{base}_{stamp}_{suffix}'
    return candidate


def add(title, advice, severity='medium'):
    """Appends a lesson to the catalog; the same (normalized) title returns the existing id."""
    if severity not in SEVERITY:
        raise UsageError('severity must be high|medium|low')
    if not slug(title) or not str(advice).strip():
        raise UsageError('title and advice are required')
    with LOCK:
        catalog = load_catalog()
        existing = next((l for l in catalog['lessons'] if slug(l.get('title')) == slug(title)), None)
        if existing:
            return existing['id']
        lesson = {'id': new_id({l.get('id') for l in catalog['lessons']}), 'title': str(title).strip(), 'trigger': '',
                  'advice': str(advice).strip(), 'appliesTo': {'domains': [], 'agents': []}, 'severity': severity, 'count': 1}
        catalog['lessons'].append(lesson)
        write_json(catalog_file(), catalog)
        return lesson['id']


def render_block(lessons):
    """Short Spanish text for humans/prompts; empty when there is nothing to say."""
    if not lessons:
        return ''
    return 'Lecciones aprendidas:\n' + '\n'.join(f'- [{l.get("severity", "medium")}] {l["title"]}: {l["advice"]}' for l in lessons)


def main(args):
    args = list(args)
    if args and args[0] == 'add':
        rest, severity = args[1:], 'medium'
        if '--severity' in rest:
            index = rest.index('--severity')
            if index + 1 >= len(rest):
                raise UsageError('--severity requires a value')
            severity = rest[index + 1]
            rest = rest[:index] + rest[index + 2:]
        if len(rest) != 2:
            raise UsageError('usage: lessons add "<titulo>" "<consejo>" [--severity high|medium|low]')
        print(add(rest[0], rest[1], severity))
        return 0
    unknown = [a for a in args if a != '--json']
    if unknown:
        raise UsageError('usage: lessons [--json] | lessons add "<titulo>" "<consejo>" [--severity x]')
    catalog = load_catalog()['lessons']
    recurrence = load_observed().get('recurrence', {})
    rows = [{**l, 'observed': int(recurrence.get(l['id'], 0))} for l in catalog]
    if '--json' in args:
        print(dumps(rows))
        return 0
    for l in rows:
        print(f'{l["id"]}  {l.get("severity", "medium"):<6}  x{int(l.get("count", 0)) + l["observed"]:<3}  {l["title"]}')
    return 0
