"""Flaky-test registry and guarded quarantine. Quarantine is explicit, owned and time-boxed; critical tests never qualify."""
import json
import re
import threading
from datetime import datetime, timedelta, timezone
from . import config

HISTORY_LIMIT = 50
WINDOW = 20
CRITICAL_DEFAULT = ['security', 'auth', 'rbac', 'tenan', 'isolation', 'migrat', 'permission', 'integrity']
INFRASTRUCTURE = re.compile(r'ECONNRESET|ETIMEDOUT|ENOSPC|EADDRINUSE|EAI_AGAIN|ECONNREFUSED|'
                            r'Cannot connect to the Docker daemon|docker daemon|error during connect|daemon is not running|'
                            r'rate limit|quota (?:exceeded|exhausted)|no space left on device|address already in use', re.I)
_LOCK = threading.RLock()


def registry_file():
    return config.H / 'state' / 'flaky.json'


def settings():
    try:
        value = config.policy().get('flaky', {})
    except (OSError, ValueError):
        value = {}
    return value if isinstance(value, dict) else {}


def test_id(path_or_name, name=None):
    """Stable id: `path::name` with forward slashes and no surrounding whitespace, or just the normalized name."""
    first = str(path_or_name or '').strip().replace('\\', '/')
    second = str(name).strip() if name else ''
    return re.sub(r'\s+', ' ', first + '::' + second if second else first)


def load():
    """{id: record}; a missing or corrupt registry is an empty one (it is a cache of observations, not a source of truth)."""
    try:
        rows = config.read_json(registry_file()).get('tests', [])
    except (OSError, ValueError, AttributeError):
        return {}
    return {r['id']: r for r in rows if isinstance(r, dict) and isinstance(r.get('id'), str)} if isinstance(rows, list) else {}


def save(tests):
    # A list (not a dict keyed by id) so ids never collide with the key-based secret redaction in write_json.
    config.write_json(registry_file(), {'schemaVersion': 1, 'tests': sorted(tests.values(), key=lambda r: r['id'])})


def parse_time(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def is_critical(test):
    patterns = settings().get('criticalPatterns') or CRITICAL_DEFAULT
    text = str(test).lower()
    for pattern in patterns:
        try:
            if re.search(pattern, text, re.I):
                return True
        except re.error:
            if str(pattern).lower() in text:
                return True
    return False


def classify_failure(output, history=None):
    """infrastructure (environment, never the test's fault) | intermittent (mixed history) | reproducible."""
    if INFRASTRUCTURE.search(str(output or '')):
        return 'infrastructure'
    statuses = [(h.get('status') if isinstance(h, dict) else h) for h in (history or [])]
    passed = any(s in ('pass', 'passed') for s in statuses)
    failed = any(s in ('fail', 'failed') for s in statuses)
    return 'intermittent' if passed and failed else 'reproducible'


def fresh(test):
    return {'id': test, 'history': [], 'failureRate': 0.0, 'retries': 0, 'durationMs': 0, 'lastFailure': None, 'quarantine': None}


def expired(quarantine):
    until = parse_time((quarantine or {}).get('expiresAt'))
    return bool(until and until <= datetime.now(timezone.utc))


def is_quarantined(test):
    with _LOCK:
        quarantine = (load().get(test) or {}).get('quarantine') or {}
    return quarantine.get('state') == 'quarantined' and not expired(quarantine)


def quarantine_locked(tests, test, owner, days, reason):
    if is_critical(test):
        raise ValueError(f'critical test cannot be quarantined: {test}')
    if not str(owner or '').strip():
        raise ValueError('quarantine requires an explicit owner')
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 90:
        raise ValueError('quarantine days must be an integer 1..90')
    from .security import redact
    record = tests.setdefault(test, fresh(test))
    since = datetime.now(timezone.utc)
    record['quarantine'] = {'state': 'quarantined', 'owner': str(owner).strip()[:80], 'since': config.now(),
                            'expiresAt': (since + timedelta(days=days)).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                            'reason': redact(str(reason or ''))[:200], 'passesSince': 0}
    return record


def quarantine(test, owner, days=None, reason=''):
    with _LOCK:
        tests = load()
        days = settings().get('quarantineDays', 14) if days is None else days
        record = quarantine_locked(tests, test, owner, days, reason)
        save(tests)
        return record


def release(test):
    with _LOCK:
        tests = load()
        record = tests.get(test)
        if not record or not record.get('quarantine'):
            return False
        record['quarantine'] = {**record['quarantine'], 'state': 'released', 'releasedAt': config.now()}
        save(tests)
        return True


def update_stats(record):
    runs = [h for h in record['history'][-WINDOW:] if h.get('category') != 'infrastructure']  # environment noise is not test health
    flaky = [h for h in runs if h['status'] == 'fail' or h.get('retries', 0) > 0]
    record['failureRate'] = round(len(flaky) / len(runs), 3) if runs else 0.0
    return sum(1 for h in runs if h['status'] == 'pass' and h.get('retries', 0) > 0)


def record_result(test, status, duration_ms=0, retries=0, category=None, output=None):
    """Append one run (status pass|fail) and apply rehabilitation, candidate proposal and optional auto-quarantine."""
    from .security import redact
    status = 'pass' if str(status).lower() in ('pass', 'passed', 'ok', 'success') else 'fail'
    with _LOCK:
        tests = load()
        record = tests.setdefault(test, fresh(test))
        if status == 'fail' and not category:
            category = classify_failure(output, record['history'])
        record['history'] = (record['history'] + [{'ts': config.now(), 'status': status, 'durationMs': int(duration_ms or 0),
                                                   'retries': int(retries or 0), 'category': category}])[-HISTORY_LIMIT:]
        record['retries'] = int(record.get('retries', 0)) + int(retries or 0)
        record['durationMs'] = int(duration_ms or 0)
        if status == 'fail':
            record['lastFailure'] = {'ts': config.now(), 'tail': redact(str(output or ''))[-300:]}
        retried_passes = update_stats(record)
        state = record.get('quarantine') or {}
        if state.get('state') == 'quarantined':
            state['passesSince'] = state.get('passesSince', 0) + 1 if status == 'pass' else 0
            if state['passesSince'] >= settings().get('rehabilitationPasses', 10):
                record['quarantine'] = {**state, 'state': 'released', 'releasedAt': config.now(), 'reason': 'rehabilitated'}
        elif (state.get('state') != 'candidate' and not is_critical(test) and retried_passes >= 2
              and record['failureRate'] >= 0.2 and len([h for h in record['history'] if h.get('category') != 'infrastructure']) >= 2):
            record['quarantine'] = {'state': 'candidate', 'since': config.now(), 'reason': 'intermittent: failureRate>=20% with retried passes'}
            owner = settings().get('owner')
            if settings().get('autoQuarantine', False) and owner:
                quarantine_locked(tests, test, owner, settings().get('quarantineDays', 14), 'auto: intermittent')
        save(tests)
        return record


def parse_failures(output):
    """Failing test ids from unittest, node:test/TAP, go test and jest/vitest/pnpm output (order kept, de-duplicated)."""
    found = []
    for line in str(output or '').splitlines():
        line = re.sub(r'\x1b\[[0-9;]*m', '', line).rstrip()
        if re.match(r'FAIL	', line):
            continue  # go package summary (`FAIL	pkg	0.1s`), not a test
        for pattern in (r'^(?:FAIL|ERROR): \S+ \(([\w.]+)\)',                       # unittest
                        r'^\s*(?:✖|×)\s+(.+?)(?:\s+\(\d[\d.]*m?s\))?$',               # node:test
                        r'^\s*not ok \d+ - (.+?)(?:\s+#.*)?$',                        # TAP
                        r'^\s*--- FAIL: (\S+)',                                       # go test
                        r'^\s*FAIL\s+(\S.*?)(?:\s+\(\d[\d.]*\s*m?s\))?$'):            # jest / vitest
            match = re.match(pattern, line)
            if match:
                name = match.group(1).strip()
                if name and not re.match(r'(?i)(failing tests|tests?\b.*:|\d+ )', name) and name not in found:
                    found.append(name)
                break
    return [test_id(n) for n in found]


def blocking_failures(failures):
    """Failures that still block a gate: everything except non-critical, unexpired quarantined tests."""
    return [f for f in failures if is_critical(f) or not is_quarantined(f)]


def analyze_gate_output(output, retried_passed=False):
    failures = parse_failures(output)
    blocking = blocking_failures(failures)
    return {'failures': failures, 'quarantined': [f for f in failures if f not in blocking], 'blocking': blocking,
            'category': 'intermittent' if retried_passed else classify_failure(output),
            'all_quarantined': bool(failures) and not blocking}


def observe_gate_output(output, passed, retries=0, duration_ms=0):
    """Feed a gate's parsed failures into the registry (only when failing; callers record passes per test if they know them)."""
    if passed:
        return []
    failures = parse_failures(output)
    for failure in failures:
        record_result(failure, 'fail', duration_ms, retries, output=output)
    return failures


def report():
    with _LOCK:
        tests = load()
    rows = []
    for record in tests.values():
        state = (record.get('quarantine') or {}).get('state')
        if state == 'quarantined' and expired(record['quarantine']):
            state = 'expired'
        rows.append({'id': record['id'], 'failureRate': record.get('failureRate', 0), 'retries': record.get('retries', 0),
                     'runs': len(record.get('history', [])), 'durationMs': record.get('durationMs', 0),
                     'state': state or 'tracked', 'critical': is_critical(record['id'])})
    return {'tests': sorted(rows, key=lambda r: -r['failureRate']),
            'quarantined': sum(1 for r in rows if r['state'] == 'quarantined'), 'candidates': sum(1 for r in rows if r['state'] == 'candidate')}


def render(data):
    lines = [f"Flaky registry: {len(data['tests'])} tests, {data['quarantined']} quarantined, {data['candidates']} candidates"]
    lines += [f"  {r['state']:11} {r['failureRate'] * 100:3.0f}% runs={r['runs']} retries={r['retries']}{' CRITICAL' if r['critical'] else ''}  {r['id']}"
              for r in data['tests']]
    return '\n'.join(lines)


def option(args, name):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None


def main(args):
    usage = 'Uso: harness:flaky [list|show <id>|quarantine <id> --owner x [--days n] [--reason r]|release <id>] [--json]'
    args = list(args)
    as_json = '--json' in args
    args = [a for a in args if a != '--json']
    command = args[0] if args else 'list'
    target = args[1] if len(args) > 1 and not args[1].startswith('--') else None
    if command == 'list':
        data = report()
        print(json.dumps(data, ensure_ascii=False, indent=2) if as_json else render(data))
    elif command == 'show' and target:
        record = load().get(target)
        if not record:
            raise config.UsageError('Test desconocido: ' + target)
        print(json.dumps(record, ensure_ascii=False, indent=2))
    elif command == 'quarantine' and target:
        days = option(args, '--days')
        if days is not None and not re.fullmatch(r'\d+', days):
            raise config.UsageError('--days requiere un entero')
        try:
            result = quarantine(target, option(args, '--owner'), int(days) if days else None, option(args, '--reason') or '')
        except ValueError as error:
            raise config.UsageError(str(error))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif command == 'release' and target:
        print('released' if release(target) else 'not quarantined')
    else:
        raise config.UsageError(usage)
    return 0
