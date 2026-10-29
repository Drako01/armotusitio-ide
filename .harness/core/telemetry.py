"""Historical telemetry: an append-only, redacted JSONL event log plus read-side summaries. Recording never raises."""
import json
import os
import threading
from . import config

ROTATE_BYTES = 5 * 1024 * 1024
MAX_TEXT = 200
# Free-text carriers that must never be persisted (prompts, raw output, secrets).
DROPPED = {'prompt', 'prompts', 'text', 'output', 'stdout', 'stderr', 'message', 'content', 'env'}
KINDS = ['task', 'phase', 'worker', 'gate', 'cache', 'retry', 'resume', 'failure', 'concurrency', 'saved']
_LOCK = threading.Lock()


def log_file():
    return config.H / 'state' / 'telemetry' / 'events.jsonl'


def clean(value, depth=0):
    """Redacted, size-bounded copy of a field value; long free text is truncated instead of stored whole."""
    from .security import redact
    if isinstance(value, str):
        value = redact(value)
        return value if len(value) <= MAX_TEXT else value[:MAX_TEXT] + '...'
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    if depth < 3 and isinstance(value, (list, tuple)):
        return [clean(v, depth + 1) for v in list(value)[:50]]
    if depth < 3 and isinstance(value, dict):
        return {str(k): clean(v, depth + 1) for k, v in value.items() if str(k).lower() not in DROPPED}
    return clean(str(value), depth + 1)


def record(kind, **fields):
    """Append one event. Telemetry is observability only: any failure is swallowed so it can never break a task."""
    try:
        from .security import redact_value
        event = {'ts': config.now(), 'kind': str(kind)[:40]}
        event.update(redact_value({k: clean(v) for k, v in fields.items() if k.lower() not in DROPPED and k not in ('ts', 'kind')}))
        line = json.dumps(event, ensure_ascii=False, separators=(',', ':')) + '\n'
        file = log_file()
        with _LOCK:
            file.parent.mkdir(parents=True, exist_ok=True)
            if file.exists() and file.stat().st_size >= ROTATE_BYTES:
                os.replace(file, file.with_name(file.name + '.1'))  # keep exactly one previous generation
            with file.open('a', encoding='utf-8') as stream:
                stream.write(line)
    except Exception:
        pass


def read_events():
    """Every parseable event (old generation first); corrupt or foreign lines are skipped."""
    events = []
    file = log_file()
    for part in (file.with_name(file.name + '.1'), file):
        try:
            text = part.read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        for line in text.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and isinstance(event.get('kind'), str):
                events.append(event)
    return events


def history(kind, key=None, limit=200):
    rows = [e for e in read_events() if e['kind'] == kind and (key is None or e.get('key') == key)]
    return rows[-limit:] if limit else rows


def durations(rows):
    return [r['durationMs'] for r in rows if isinstance(r.get('durationMs'), (int, float)) and not isinstance(r.get('durationMs'), bool)]


def percentile_or_none(values, pct):
    """Nearest-rank percentile; None when there is no sample (callers fall back to static estimates)."""
    values = sorted(values)
    if not values:
        return None
    return values[min(len(values) - 1, max(0, -(-len(values) * pct // 100) - 1))]


def summarize(kind, key=None):
    values = durations(history(kind, key))
    return {'count': len(values), 'medianMs': percentile_or_none(values, 50),
            'p90Ms': percentile_or_none(values, 90), 'lastMs': values[-1] if values else None}


def number(event, *names):
    for name in names:
        value = event.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
    return 0


def is_hit(event):
    return event.get('hit') is True or event.get('result') == 'hit'


def bottlenecks(events, limit=5):
    out = {}
    for kind in ('gate', 'phase'):
        groups = {}
        for event in events:
            if event['kind'] == kind and isinstance(event.get('durationMs'), (int, float)):
                groups.setdefault(str(event.get('key') or event.get('name') or '?'), []).append(event['durationMs'])
        rows = [{'key': k, 'count': len(v), 'medianMs': percentile_or_none(v, 50), 'p90Ms': percentile_or_none(v, 90), 'totalMs': int(sum(v))}
                for k, v in groups.items()]
        out[kind + 's'] = sorted(rows, key=lambda r: -r['p90Ms'])[:limit]
    return out


def report(trend=False):
    events = read_events()
    by = {k: [e for e in events if e['kind'] == k] for k in KINDS}
    hits = sum(1 for e in by['cache'] if is_hit(e))
    failures = {}
    for event in by['failure']:
        category = str(event.get('category') or 'unknown')
        failures[category] = failures.get(category, 0) + 1
    levels = [number(e, 'value', 'workers', 'effective') for e in by['concurrency']]
    result = {
        'events': len(events),
        'tasks': len(by['task']),
        'gates': len(by['gate']),
        'cache': {'hits': hits, 'misses': len(by['cache']) - hits, 'hitRate': round(hits / len(by['cache']), 3) if by['cache'] else None},
        'retries': len(by['retry']),
        'resumes': len(by['resume']),
        'failures': failures,
        'effectiveConcurrency': round(sum(levels) / len(levels), 2) if levels else None,
        'estimatedSavedMs': int(sum(number(e, 'ms', 'savedMs', 'durationMs') for e in by['saved'])),
        'bottlenecks': bottlenecks(events),
    }
    if trend:
        days = {}
        for event in events:
            name = str(event.get('ts', ''))[:10] or '?'
            day = days.setdefault(name, {'day': name, 'tasks': 0, 'gates': 0, 'failures': 0, 'retries': 0, 'cacheHits': 0, 'savedMs': 0})
            kind = event['kind']
            day['tasks'] += kind == 'task'
            day['gates'] += kind == 'gate'
            day['failures'] += kind == 'failure'
            day['retries'] += kind == 'retry'
            day['cacheHits'] += kind == 'cache' and is_hit(event)
            day['savedMs'] += int(number(event, 'ms', 'savedMs', 'durationMs')) if kind == 'saved' else 0
        result['trend'] = [days[d] for d in sorted(days)]
    return result


def render_bottlenecks(data):
    lines = []
    for title, rows in data['bottlenecks'].items():
        lines.append('slowest ' + title + ':')
        lines += [f"  {r['key']}: p90 {r['p90Ms'] / 1000:.1f}s median {r['medianMs'] / 1000:.1f}s x{r['count']}" for r in rows] or ['  (no data)']
    return lines


def render(data):
    cache = data['cache']
    lines = ['Harness telemetry (' + str(data['events']) + ' events)',
             f"tasks {data['tasks']} | gates {data['gates']} | retries {data['retries']} | resumes {data['resumes']}",
             'cache hit rate ' + ('n/a' if cache['hitRate'] is None else f"{cache['hitRate'] * 100:.0f}% ({cache['hits']}/{cache['hits'] + cache['misses']})"),
             'effective concurrency ' + ('n/a' if data['effectiveConcurrency'] is None else str(data['effectiveConcurrency'])),
             f"estimated time saved {data['estimatedSavedMs'] / 1000:.1f}s",
             'failures ' + (', '.join(f'{k}={v}' for k, v in sorted(data['failures'].items())) or 'none')]
    lines += render_bottlenecks(data)
    for row in data.get('trend', []):
        lines.append(f"  {row['day']}: tasks {row['tasks']} gates {row['gates']} failures {row['failures']} retries {row['retries']} saved {row['savedMs'] / 1000:.1f}s")
    return '\n'.join(lines)


def main(args):
    if [a for a in args if a not in ('--json', '--trend', '--bottlenecks')]:
        raise config.UsageError('Uso: harness:telemetry [--json] [--trend] [--bottlenecks]')
    data = report(trend='--trend' in args)
    if '--bottlenecks' in args:
        data = {'bottlenecks': data['bottlenecks']}
    print(json.dumps(data, ensure_ascii=False, indent=2) if '--json' in args
          else '\n'.join(render_bottlenecks(data)) if '--bottlenecks' in args else render(data))
    return 0
