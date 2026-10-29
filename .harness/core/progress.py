"""Live progress of Harness tasks: a read-only view over tasks/, handoffs/ and state/.

The reader never takes a lock and never writes. The only files this module creates are the ephemeral gate counters under
`runtime/progress/<task-id>.json` (atomic replace), written by the executing process while verifier gates run.
"""
import json
import os
import re
import secrets
import sys
import time
from datetime import datetime, timezone
from .config import ROOT, H, STATUSES, UsageError, read_json, max_retries, policy
from .security import contained, redact
from .state import alive, assert_task_id

ICONS = {'passed': '✔', 'running': '⟳', 'failed': '✖', 'blocked': '⏸', 'pending': '·'}
BAR_WIDTH = 20
CAUSE_LIMIT = 240
TITLE_LIMIT = 60
STALL_SAMPLES = 2  # --watch exits 3 only after the stall persisted for this many consecutive refreshes
EXIT = {'completed': 0, 'failed': 1, 'stalled': 3}
SLOW_GATE_FACTOR = 1.5  # a gate running longer than this multiple of its typical duration raises an alert
AUDIT_SCAN = 300  # newest audit records read per refresh to learn typical gate durations
PHASES = [('código', 'Código'), ('pruebas', 'Pruebas'), ('revisión', 'Revisión'), ('verificación', 'Verificación')]
PHASE_OF = {'tester': 'pruebas', 'reviewer': 'revisión', 'security-auditor': 'revisión', 'verifier': 'verificación', 'logger': 'verificación'}
COLORS = {'passed': '32', 'running': '36', 'failed': '31', 'blocked': '33', 'pending': '2', 'warn': '33;1', 'bold': '1'}
# failureCategory -> (what happened, suggested action); categories come from the executor and may grow, so unknown ones are skipped.
FAILURES = {
    'timeout': ('el agente superó su tiempo límite', 'reintentar; si se repite, subir el timeout o partir el alcance'),
    'host-unavailable': ('el host del agente no respondió (cuota o red)', 'verificar el host/cuota y reintentar; considerar el otro host'),
    'host-exit': ('el proceso del host terminó con error', 'revisar logs/errors de la tarea y reintentar'),
    'security-denial': ('una política de seguridad denegó la operación', 'revisar el permiso denegado; no relajar reglas sin aprobación'),
    'integration-conflict': ('la integración de archivos tuvo conflictos', 'resolver los conflictos del worktree o partir el alcance'),
    'agent-result': ('el agente reportó un resultado fallido', 'leer el handoff (riesgos) y corregir antes de reintentar'),
    'malformed-result': ('el agente devolvió un resultado ilegible', 'reintentar; si persiste, revisar el contrato del handoff'),
}


class Transient(ValueError):
    """A record is missing or still being written; the caller retries on its next cycle."""


# --- writer (executing process) -------------------------------------------------------------------------------------

def progress_file(task_id):
    assert_task_id(task_id)
    return H / 'runtime' / 'progress' / (task_id + '.json')


def record_gates(task_id, node, done, total, current=None):
    """Publishes `done/total` gates (and the gate in flight) for `node`. Best effort: telemetry never fails a task."""
    try:
        file = progress_file(task_id)
        if not contained(file.parent.relative_to(ROOT).as_posix()):
            return
        file.parent.mkdir(parents=True, exist_ok=True)
        value = {'schemaVersion': 1, 'taskId': task_id, 'node': node, 'done': done, 'total': total,
                 'current': redact(' '.join(current)) if current else None, 'pid': os.getpid(),
                 'updatedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}
        temporary = file.with_name(file.name + '.' + secrets.token_hex(6) + '.tmp')
        try:
            temporary.write_text(json.dumps(value, ensure_ascii=False) + '\n', encoding='utf-8')
            os.replace(temporary, file)
        finally:
            temporary.unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


def clear_gates(task_id):
    try:
        progress_file(task_id).unlink(missing_ok=True)
    except (OSError, ValueError):
        pass


# --- tolerant readers -----------------------------------------------------------------------------------------------

def read_record(file):
    """(value, exists). A file that disappears, is unreadable or is half written yields value None."""
    try:
        return json.loads(file.read_text(encoding='utf-8-sig')), True
    except FileNotFoundError:
        return None, False
    except (OSError, ValueError):
        return None, True


def parse_time(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def find_task(task_id):
    """Task record by id. During a lifecycle move both directories can briefly hold it: the newest `updatedAt` wins."""
    assert_task_id(task_id)
    found, partial = [], False
    for status in STATUSES:
        value, exists = read_record(H / 'tasks' / status / (task_id + '.json'))
        if isinstance(value, dict) and isinstance(value.get('id'), str):
            found.append((parse_time(value.get('updatedAt') or value.get('createdAt')) or 0, status != 'active', value))
        elif exists:
            partial = True
    if found:
        return max(found, key=lambda row: (row[0], row[1]))[2]
    if partial:
        raise Transient('Task record is being written: ' + task_id)
    raise ValueError('Task not found: ' + task_id)


def lock_live(task_id):
    value, _ = read_record(H / 'state' / (task_id + '.lock'))
    pid = value.get('pid') if isinstance(value, dict) else None
    return isinstance(pid, int) and pid > 0 and alive(pid)


def task_handoffs(task_id):
    rows = []
    directory = H / 'handoffs'
    try:
        names = sorted(n for n in os.listdir(directory) if n.startswith(task_id + '-') and n.endswith('.json'))
    except OSError:
        return rows
    for name in names:
        value, _ = read_record(directory / name)
        if isinstance(value, dict) and value.get('taskId') == task_id and isinstance(value.get('agent'), str):
            rows.append({**value, 'time': parse_time(value.get('at'))})
    return rows


def read_gates(task_id):
    value, _ = read_record(progress_file(task_id))
    if isinstance(value, dict) and all(type(value.get(k)) is int for k in ['done', 'total']) and value['total'] > 0:
        return value
    return None


def state_time(task_id):
    value, _ = read_record(H / 'state' / (task_id + '.json'))
    return parse_time(value.get('updatedAt')) if isinstance(value, dict) else None


def short_title(task):
    ref, text = task.get('sourceRef'), ''
    if isinstance(ref, dict) and re.fullmatch(r'\.harness/tasks/sources/[a-zA-Z0-9_-]+\.txt', str(ref.get('path'))):
        try:
            with open(ROOT / ref['path'], encoding='utf-8') as stream:
                text = next((line.strip() for line in stream if line.strip()), '')
        except OSError:
            pass
    if not text:
        text = next(iter(str(task.get('task', '')).strip().splitlines()), '')
    text = redact(re.sub(r'^#+\s*', '', text).replace('`', ''))
    return text if len(text) <= TITLE_LIMIT else text[:TITLE_LIMIT - 1] + '…'


def limit(text, size=CAUSE_LIMIT):
    text = redact(' '.join(str(text).split()))
    return text if len(text) <= size else text[:size - 1] + '…'


# --- model ----------------------------------------------------------------------------------------------------------

def retries():
    try:
        return max_retries()
    except ValueError:
        return 2


def node_rows(task, handoffs, live, now, gates):
    """One row per DAG node plus (done, total) where a running node contributes only measurable sub-steps."""
    created = parse_time(task.get('createdAt')) or now
    stamps = sorted(h['time'] for h in handoffs if h['time'])
    started = state_time(task['id'])
    rows, done = [], 0.0
    for node in task.get('dag', []):
        status = node.get('status') if node.get('status') in ICONS else 'pending'
        mine = [h for h in handoffs if h.get('node', h['agent']) == node.get('id') and h['time']]
        last = max(mine, key=lambda h: (h.get('attempt', 0), h['time'])) if mine else None
        row = {'id': node.get('id'), 'status': status, 'attempt': node.get('attempts', 0), 'maxAttempts': retries() + 1,
               'durationMs': None, 'running': False, 'interrupted': False, 'gates': None}
        if status == 'passed':
            done += 1
        if status == 'running':
            row['running'], row['interrupted'] = live, not live
            begin = started or created
            row['durationMs'] = max(0, round((now - begin) * 1000))
            if live and gates and gates.get('node') == node.get('id'):
                row['gates'] = {'done': gates['done'], 'total': gates['total'], 'current': gates.get('current')}
                done += min(gates['done'] / gates['total'], 0.99)
        elif last and status in ('passed', 'failed', 'blocked'):
            before = [t for t in stamps if t < last['time']]
            row['durationMs'] = max(0, round((last['time'] - (before[-1] if before else created)) * 1000))
        rows.append(row)
    return rows, done


# --- insight (every source is optional: a missing file or key just drops that piece) -------------------------------------

def phase_state(rows):
    states = {r['status'] for r in rows}
    for state in ('failed', 'blocked', 'running'):
        if state in states:
            return state
    return 'passed' if rows and states == {'passed'} else 'running' if 'passed' in states else 'pending'


def phase_summary(rows):
    return [{'id': key, 'label': label, 'done': sum(r['status'] == 'passed' for r in group), 'total': len(group), 'state': phase_state(group)}
            for key, label in PHASES for group in [[r for r in rows if r.get('phase') == key]] if group]


def gate_typical(task_id, command):
    """Median duration of this task's previous runs of the same gate command (from logs/audit), or None."""
    directory, wanted, found = H / 'logs' / 'audit', ' '.join(str(command).split()), []
    try:
        names = sorted(n for n in os.listdir(directory) if n.startswith(task_id + '-') and n.endswith('.json'))[-AUDIT_SCAN:]
    except OSError:
        return None
    for name in names:
        value, _ = read_record(directory / name)
        if not isinstance(value, dict) or value.get('event') != 'gate' or value.get('taskId') != task_id:
            continue
        ran = value.get('command')
        ran = ' '.join(str(c) for c in ran) if isinstance(ran, list) else str(ran)
        if redact(' '.join(ran.split())) == wanted and type(value.get('durationMs')) is int and value['durationMs'] > 0:
            found.append(value['durationMs'])
    found.sort()
    return found[len(found) // 2] if found else None


def previous_reason(row, handoffs):
    """Why the attempt before the current one ended, from its handoff (risks, else nextAction)."""
    earlier = [h for h in handoffs if h.get('node', h['agent']) == row['id'] and h.get('status') in ('failed', 'blocked')
               and type(h.get('attempt')) is int and h['attempt'] < row['attempt']]
    if not earlier:
        return None
    last = max(earlier, key=lambda h: h['attempt'])
    text = '; '.join(str(r) for r in (last.get('risks') or [])[:2]) or str(last.get('nextAction') or '')
    return limit(text, 120) if text else None


def estimate(task, rows, dag, now):
    """(remaining ms per node, critical path ids, unit ms per weight or None). Durations of finished nodes scale plan weights."""
    plan = task.get('plan') if isinstance(task.get('plan'), dict) else {}
    weights = plan.get('weights') if isinstance(plan.get('weights'), dict) else {}
    weight = lambda key: weights[key] if isinstance(weights.get(key), (int, float)) and weights[key] > 0 else 1
    seen = {}
    for row in rows:
        node = dag.get(row['id'], {})
        begin, end = parse_time(node.get('startedAt')), parse_time(node.get('finishedAt'))
        spent = node.get('activeMs') if type(node.get('activeMs')) is int and node['activeMs'] > 0 else round((end - begin) * 1000) if begin and end and end > begin else row['durationMs']
        if row['status'] == 'passed' and spent:
            seen[row['id']] = spent
    unit = sum(seen.values()) / sum(weight(k) for k in seen) if seen else None
    rows_by_id, left, finish = {r['id']: r for r in rows}, {}, {}
    for key, row in rows_by_id.items():
        cost = weight(key) * (unit or 1)
        begin = parse_time(dag.get(key, {}).get('startedAt'))
        left[key] = 0 if row['status'] == 'passed' else max(cost - (now - begin) * 1000, cost * 0.1) if row['running'] and begin else cost
    def done_at(key, trail=()):
        if key not in finish:
            deps = [d for d in dag.get(key, {}).get('dependsOn', []) if d in rows_by_id and d not in trail and d != key]
            finish[key] = left[key] + max([done_at(d, trail + (key,)) for d in deps] or [0])
        return finish[key]
    pending = [k for k, r in rows_by_id.items() if r['status'] != 'passed']
    for key in rows_by_id:
        done_at(key)
    path = []
    current = max(pending, key=lambda k: finish[k], default=None)
    while current and current not in path:
        path.append(current)
        deps = [d for d in dag.get(current, {}).get('dependsOn', []) if d in rows_by_id and rows_by_id[d]['status'] != 'passed']
        current = max(deps, key=lambda k: finish[k], default=None)
    return finish.get(path[0], 0) if path else 0, path, unit


def insight(task, rows, handoffs, live, now, gates):
    """Adds per-node phase/critical/queued/failure keys in place and returns the task-level eta, phases and workers."""
    dag = {n.get('id'): n for n in task.get('dag', []) if isinstance(n, dict)}
    by_id = {r['id']: r for r in rows}
    total_ms, path, unit = estimate(task, rows, dag, now)
    finished = sorted(r['durationMs'] for r in rows if r['status'] in ('passed', 'failed') and r['durationMs'])
    slow = max(finished) if len(finished) >= 3 and finished[-1] >= 2 * finished[len(finished) // 2] else None
    for row in rows:
        node = dag.get(row['id'], {})
        row['phase'] = PHASE_OF.get(node.get('agent'), 'código')
        row['critical'] = row['id'] in path
        row['bottleneck'] = slow is not None and row['status'] in ('passed', 'failed') and row['durationMs'] == slow
        row['queued'] = bool(live and row['status'] == 'pending' and all(by_id.get(d, {}).get('status') == 'passed' for d in node.get('dependsOn', [])))
        row['previousAttempt'] = previous_reason(row, handoffs) if row['attempt'] >= 2 else None
        category = node.get('failureCategory') if row['status'] in ('failed', 'blocked') else None
        row['failure'] = {'category': category, 'cause': FAILURES[category][0], 'action': FAILURES[category][1]} if category in FAILURES else None
        if row['gates']:
            typical = gate_typical(task['id'], row['gates']['current']) if live and row['gates'].get('current') else None
            began = parse_time(gates.get('updatedAt')) if gates else None
            elapsed = max(0, round((now - began) * 1000)) if began else None
            row['gateDetail'] = {'typicalMs': typical, 'elapsedMs': elapsed, 'slow': bool(typical and elapsed and elapsed > SLOW_GATE_FACTOR * typical)}
    metrics = task.get('metrics') if isinstance(task.get('metrics'), dict) else {}
    plan = task.get('plan') if isinstance(task.get('plan'), dict) else {}
    recommended = next((v for v in (metrics.get('workers'), plan.get('workers'), plan.get('recommendedWorkers')) if type(v) is int and v > 0), None)
    workers = {'active': sum(r['running'] for r in rows), 'recommended': recommended, 'queued': sum(r['queued'] for r in rows)}
    eta = {'remainingMs': round(total_ms), 'minutes': max(1, -(-round(total_ms) // 60000))} if unit and live and task.get('status') == 'active' and total_ms > 0 else None
    return {'eta': eta, 'phases': phase_summary(rows), 'workers': workers if live else None}


def passive_alerts(task, live):
    """Read-only warnings: a dead lock of this task and registered worktrees whose task has no live owner."""
    alerts = []
    _, exists = read_record(H / 'state' / (task['id'] + '.lock'))
    if task.get('status') == 'active' and exists and not live:
        alerts.append({'kind': 'dead-lock', 'message': 'lock sin proceso vivo: la ejecución se interrumpió; relanzar con harness:run o limpiar con harness:hygiene'})
    orphans = []
    try:
        names = sorted(n for n in os.listdir(H / 'runtime' / 'worktrees') if n.endswith('.json'))
    except OSError:
        names = []
    for name in names:
        entry, _ = read_record(H / 'runtime' / 'worktrees' / name)
        owner = entry.get('task') if isinstance(entry, dict) else None
        if isinstance(owner, str) and re.fullmatch(r'[a-zA-Z0-9_-]+', owner):
            _, active = read_record(H / 'tasks' / 'active' / (owner + '.json'))
            if not (active and lock_live(owner)):
                orphans.append(owner + '/' + str(entry.get('name', name[:-5])))
    threshold = (policy().get('parallel') or {}).get('longNodeWarningMs', 900000)
    if live and isinstance(threshold, (int, float)) and threshold > 0:
        for node in task.get('dag', []):
            if node.get('status') != 'running':
                continue
            started = parse_time(node.get('activeStartedAt') or node.get('startedAt'))
            if started and (time.time() - started) * 1000 > threshold:
                alerts.append({'kind': 'long-node', 'message':
                               'Nodo ' + str(node.get('id')) +
                               ' supera el umbral; considerar dividir el trabajo en unidades independientes'})
    if orphans:
        alerts.append({'kind': 'orphan-worktrees', 'message': f'{len(orphans)} worktree(s) huérfano(s): ' + ', '.join(orphans[:3]) +
                       ('…' if len(orphans) > 3 else '') + '; pnpm harness:hygiene -- --prune-worktrees --yes'})
    return alerts


def cause_of(task, rows, handoffs):
    if task.get('scopeViolation'):
        violation = task['scopeViolation']
        return limit('Scope violation: ' + str(violation.get('reason') if isinstance(violation, dict) else violation))
    if task.get('aborted'):
        aborted = task['aborted']
        return limit('Aborted: ' + str(aborted.get('reason') if isinstance(aborted, dict) else aborted))
    for row in reversed(rows):
        if row['status'] in ('failed', 'blocked'):
            mine = [h for h in handoffs if h.get('node', h['agent']) == row['id'] and h.get('status') in ('failed', 'blocked')]
            if mine:
                last = max(mine, key=lambda h: (h.get('attempt', 0), h['time'] or 0))
                text = '; '.join(str(r) for r in (last.get('risks') or [])[:2]) or str(last.get('nextAction') or '')
                if text:
                    return limit(row['id'] + ': ' + text)
    return None


def last_event(handoffs, gates):
    event = None
    if handoffs:
        last = max(handoffs, key=lambda h: h['time'] or 0)
        event = {'kind': 'handoff', 'agent': last.get('node', last['agent']), 'status': last.get('status'), 'attempt': last.get('attempt'),
                 'at': last.get('at')}
    if gates and (not event or (parse_time(gates.get('updatedAt')) or 0) >= (parse_time(event['at']) or 0)):
        event = {'kind': 'gate', 'agent': gates.get('node'), 'status': 'running', 'attempt': None, 'at': gates.get('updatedAt'),
                 'gate': {'done': gates['done'], 'total': gates['total'], 'current': gates.get('current')}}
    return event


def percent(done, total, status):
    if status == 'completed':
        return 100
    return min(99, int(100 * done / total)) if total else 0


def build_single(task, now, live):
    handoffs = task_handoffs(task['id'])
    gates = read_gates(task['id']) if live else None
    rows, done = node_rows(task, handoffs, live, now, gates)
    total = len(rows)
    extra = insight(task, rows, handoffs, live, now, gates)
    return {'id': task['id'], 'domain': task['domain'], 'title': short_title(task), 'status': task['status'], 'live': live,
            'done': sum(r['status'] == 'passed' for r in rows), 'total': total, 'progress': done,
            'percent': percent(done, total, task['status']), 'nodes': rows, 'lastEvent': last_event(handoffs, gates),
            'cause': cause_of(task, rows, handoffs), 'failure': next((r['failure'] for r in rows if r['failure']), None),
            **extra, '_handoffs': handoffs}


def elapsed_ms(task, now):
    created = parse_time(task.get('createdAt'))
    if created is None:
        return None
    end = (parse_time(task.get('updatedAt')) or now) if task.get('status') != 'active' else now
    return max(0, round((end - created) * 1000))


def build_multi(task, now, live):
    gates = read_gates(task['id']) if live else None
    children, missing = [], []
    for child_id in task.get('children', []):
        try:
            child = find_task(child_id)
        except ValueError:
            missing.append(child_id)
            continue
        view = build_single(child, now, live)
        view['elapsedMs'] = elapsed_ms(child, now)
        children.append(view)
    final = {'done': gates['done'], 'total': gates['total'], 'current': gates.get('current')} if gates and gates.get('node') == 'final-gates' else None
    # Each node weighs 1; the combined final gates are one more step of the multi (k/n while they run).
    total = sum(c['total'] for c in children) + 1
    done = sum(c['progress'] for c in children) + (1 if task['status'] == 'completed' else min(final['done'] / final['total'], 0.99) if final else 0)
    handoffs = [h for c in children for h in c.pop('_handoffs')]
    rows = [r for c in children for r in c['nodes']]
    cause = cause_of(task, rows, handoffs) or next((c['cause'] for c in children if c['cause']), None)
    if missing and not cause:
        cause = limit('Children not readable yet: ' + ', '.join(missing))
    return {'id': task['id'], 'domain': 'multi', 'title': short_title(task), 'status': task['status'], 'live': live,
            'done': sum(c['done'] for c in children) + (1 if task['status'] == 'completed' else 0), 'total': total, 'progress': done,
            'percent': percent(done, total, task['status']), 'nodes': [], 'children': children, 'finalGates': final,
            'lastEvent': last_event(handoffs, gates), 'cause': cause, 'failure': next((c['failure'] for c in children if c.get('failure')), None),
            'eta': None, 'phases': [], 'workers': None}


def build(task_id, now=None):
    now = time.time() if now is None else now
    task = find_task(task_id)
    live = task['status'] == 'active' and lock_live(task_id)
    view = build_multi(task, now, live) if task.get('domain') == 'multi' else build_single(task, now, live)
    view.pop('_handoffs', None)
    view.pop('progress', None)
    blocked = any(n['status'] == 'blocked' for n in view['nodes']) or any(n['status'] == 'blocked' for c in view.get('children', []) for n in c['nodes'])
    view['state'] = task['status'] if task['status'] != 'active' else 'running' if live else 'stalled'
    view['blocked'] = blocked
    view['elapsedMs'] = elapsed_ms(task, now)
    view['alerts'] = passive_alerts(task, live)
    view['generatedAt'] = datetime.fromtimestamp(now, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    return view


def pick_task():
    """Active task with a live lock, else the most recent active one (a multi is preferred over its own children)."""
    directory = H / 'tasks' / 'active'
    try:
        ids = sorted(n[:-5] for n in os.listdir(directory) if n.endswith('.json'))
    except OSError:
        ids = []
    ids = [i for i in ids if re.fullmatch(r'[a-zA-Z0-9_-]+', i)]
    if not ids:
        raise ValueError('No active task; pass a <task-id> (pnpm harness:list shows every task)')
    children = set()
    for identity in ids:
        value, _ = read_record(directory / (identity + '.json'))
        if isinstance(value, dict) and value.get('domain') == 'multi' and isinstance(value.get('children'), list):
            children.update(c for c in value['children'] if isinstance(c, str))
    candidates = [i for i in ids if i not in children] or ids
    return next((i for i in reversed(candidates) if lock_live(i)), candidates[-1])


# --- rendering ------------------------------------------------------------------------------------------------------

def duration(ms):
    if ms is None:
        return '-'
    seconds = ms // 1000
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f'{hours}h {minutes:02d}m {secs:02d}s' if hours else f'{minutes}m {secs:02d}s' if minutes else f'{secs}s'


def bar(percent_value):
    filled = BAR_WIDTH * percent_value // 100
    return '█' * filled + '░' * (BAR_WIDTH - filled)


def gate_text(gates):
    return f'gates {gates["done"]}/{gates["total"]}' + (f' · {gates["current"]}' if gates.get('current') else '')


def paint(text, key, color):
    return f'\x1b[{COLORS[key]}m{text}\x1b[0m' if color else text


def minutes_text(eta):
    return f'faltan ~{eta["minutes"]} min' if eta else None


def workers_text(workers):
    if not workers or not (workers['active'] or workers['queued']):
        return None
    return f'workers {workers["active"]}/{workers["recommended"]}' if workers['recommended'] else f'workers {workers["active"]}'


def node_line(row, indent, color=False):
    detail = duration(row['durationMs']) if row['durationMs'] is not None else '-'
    if row['running']:
        detail += ' corriendo'
    if row['interrupted']:
        detail += ' (interrumpido)'
    extra = f'  intento {max(row["attempt"], 1)}/{row["maxAttempts"]}' if row['attempt'] else ''
    gates = f'  [{gate_text(row["gates"])}]' if row['gates'] else ''
    tags = ''.join(f'  [{label}]' for key, label in (('critical', 'ruta crítica'), ('bottleneck', 'cuello de botella'), ('queued', 'en cola')) if row.get(key))
    icon = paint(ICONS[row['status']], row['status'], color)
    return f'{indent}{icon} {row["id"]:<18} {detail if row["status"] != "pending" else "-":<22}{extra}{gates}{paint(tags, "warn", color) if tags else ""}'.rstrip()


def node_lines(row, indent, color=False):
    """The node line plus its optional details: slow gate alert, failure cause/action and the previous attempt's reason."""
    lines, gates, detail = [node_line(row, indent, color)], row.get('gates') or {}, row.get('gateDetail') or {}
    if detail.get('slow'):
        lines.append(paint(f'{indent}  ⚠ gate lento: {gates.get("current")} lleva {duration(detail["elapsedMs"])} (típico {duration(detail["typicalMs"])})', 'warn', color))
    if row.get('failure'):
        lines.append(f'{indent}  ↳ {row["failure"]["category"]}: {row["failure"]["cause"]} → {row["failure"]["action"]}')
    if row.get('previousAttempt'):
        lines.append(f'{indent}  ↳ intento anterior: {row["previousAttempt"]}')
    return lines


def phase_lines(rows, indent, color=False):
    """Nodes grouped by phase (código, pruebas, revisión, verificación), each group headed by its own state."""
    lines = []
    for item in phase_summary(rows):
        lines.append(f'{indent}{paint(ICONS[item["state"]] + " " + item["label"], "bold", color)} {item["done"]}/{item["total"]}')
        for row in (r for r in rows if r.get('phase') == item['id']):
            lines += node_lines(row, indent + '  ', color)
    return lines


STATE_META = {'running': 'en ejecución', 'stalled': 'bloqueada / sin ejecución viva', 'completed': 'completada', 'failed': 'fallida'}


def render_compact(view, color=False):
    """One line: id, percent, steps, state, node in flight, workers, eta and alert count."""
    nodes = view['nodes'] or [n for c in view.get('children', []) for n in c['nodes']]
    current = next((n for n in nodes if n['status'] in ('running', 'failed', 'blocked')), None)
    parts = [view['id'], f'{view["percent"]}%', f'{view["done"]}/{view["total"]}', STATE_META[view['state']]]
    if current:
        parts.append(paint(f'{ICONS[current["status"]]} {current["id"]}', current['status'], color))
    parts += [p for p in (workers_text(view.get('workers')), minutes_text(view.get('eta'))) if p]
    if view.get('alerts'):
        parts.append(paint(f'⚠ {len(view["alerts"])} alerta(s)', 'warn', color))
    return ' · '.join(parts)


def render(view, color=False):
    meta = STATE_META[view['state']]
    state_key = {'running': 'running', 'completed': 'passed', 'failed': 'failed'}.get(view['state'], 'blocked')
    bar_line = f'[{paint(bar(view["percent"]), state_key, color)}] {view["percent"]}%  {view["done"]}/{view["total"]} pasos  {duration(view["elapsedMs"])}  · {meta}'
    bar_line += ''.join('  · ' + p for p in (workers_text(view.get('workers')), minutes_text(view.get('eta'))) if p)
    lines = [f'{paint(view["id"], "bold", color)}  [{view["domain"]}]  {view["title"]}', bar_line]
    for child in view.get('children', []):
        lines.append(f'  {child["domain"]} {child["id"]}  [{bar(child["percent"])}] {child["percent"]}%  {child["done"]}/{child["total"]}  · {child["status"]}')
        lines += phase_lines(child['nodes'], '    ', color)
    if view.get('children'):
        final = view.get('finalGates')
        lines.append('  gates finales del multi' + (': ' + gate_text(final) if final else ''))
    lines += phase_lines(view['nodes'], '  ', color)
    event = view.get('lastEvent')
    if event:
        what = gate_text(event['gate']) if event['kind'] == 'gate' else f'{event["agent"]} {event["status"]}' + (f' (intento {event["attempt"]})' if event.get('attempt') else '')
        lines.append(f'Último evento: {what}' + (f' · {event["at"]}' if event.get('at') else ''))
    if view.get('cause'):
        lines.append(paint('Causa: ' + view['cause'], 'failed', color))
    failure = view.get('failure')
    if failure:
        lines.append(f'Acción sugerida ({failure["category"]}): {failure["action"]}')
    lines += [paint('⚠ ' + a['message'], 'warn', color) for a in view.get('alerts', [])]
    return '\n'.join(lines)


def signature(view):
    """What a non-TTY consumer cares about: elapsed time and running durations alone are not a change."""
    def strip(value):
        if isinstance(value, dict):
            return {k: strip(v) for k, v in value.items() if k not in ('durationMs', 'elapsedMs', 'generatedAt', 'eta')}
        return [strip(v) for v in value] if isinstance(value, list) else value
    return json.dumps(strip(view), sort_keys=True, ensure_ascii=False)


# --- stderr line emitted by `execute` -------------------------------------------------------------------------------

_seen = {}


def announce(task, stream=None):
    """Prints `[harness] 3/7 43% reviewer ⟳` when a node of `task` changes state. Never raises, never touches stdout."""
    try:
        seen = _seen.setdefault(task['id'], {})
        first = not seen
        changed = []
        for node in task.get('dag', []):
            status = node.get('status')
            if seen.get(node['id']) != status:
                if status in ('running', 'passed', 'failed', 'blocked') and not (first and status != 'running'):
                    changed.append(node)
                seen[node['id']] = status
        if not changed:
            return
        total = len(task['dag'])
        gates = read_gates(task['id'])
        for node in changed:
            done = sum(n['status'] == 'passed' for n in task['dag'])
            partial = min(gates['done'] / gates['total'], 0.99) if gates and gates.get('node') == node['id'] and node['status'] == 'running' else 0
            line = f'[harness] {done}/{total} {percent(done + partial, total, "active")}% {node["id"]} {ICONS[node["status"]]}'
            if node.get('attempts', 0) > 1:
                line += f' (intento {node["attempts"]}/{retries() + 1})'
            print(line, file=stream or sys.stderr, flush=True)
    except Exception:
        pass


# --- command --------------------------------------------------------------------------------------------------------

def parse_args(args):
    options = {'id': None, 'watch': False, 'json': False, 'compact': False, 'interval': 3.0}
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ('--watch', '--json', '--compact'):
            options[arg[2:]] = True
        elif arg == '--interval' or arg.startswith('--interval='):
            raw = arg.split('=', 1)[1] if '=' in arg else args[i + 1] if i + 1 < len(args) else ''
            i += 0 if '=' in arg else 1
            try:
                options['interval'] = float(raw)
            except ValueError:
                raise UsageError('--interval requiere segundos (número positivo)') from None
            if not 0.05 <= options['interval'] <= 3600:
                raise UsageError('--interval debe estar entre 0.05 y 3600 segundos')
        elif arg.startswith('-'):
            raise UsageError('Opción inválida para progress: ' + arg)
        elif options['id'] is None:
            options['id'] = arg
        else:
            raise UsageError('Uso: harness:progress [<task-id>] [--watch] [--interval N] [--json] [--compact]')
        i += 1
    if options['id'] is not None:
        try:
            assert_task_id(options['id'])
        except ValueError as error:
            raise UsageError(str(error)) from None
    return options


def sample(identity, attempts=3, pause=0.15):
    """One reading; a record caught mid-write is retried briefly, then reported as Transient."""
    for attempt in range(attempts):
        try:
            return build(identity)
        except Transient:
            if attempt == attempts - 1:
                raise
            time.sleep(pause)


def main(args, out=None):
    out = out or sys.stdout
    options = parse_args(args)
    identity = options['id'] or pick_task()
    tty = hasattr(out, 'isatty') and out.isatty()
    color = tty and 'NO_COLOR' not in os.environ  # https://no-color.org: any value, even empty, disables colors
    show = (lambda v: render_compact(v, color)) if options['compact'] else (lambda v: render(v, color))
    if not options['watch']:
        try:
            view = sample(identity)
        except Transient as error:
            raise ValueError(str(error) + '; retry in a moment') from None
        print(json.dumps(view, ensure_ascii=False, indent=2) if options['json'] else show(view), file=out)
        return 0
    last, stalled = None, 0
    try:
        while True:
            try:
                view = sample(identity, attempts=1)
            except Transient:
                time.sleep(options['interval'])
                continue
            current = signature(view)
            if current != last or (tty and not options['json']):
                if options['json']:
                    print(json.dumps(view, ensure_ascii=False, separators=(',', ':')), file=out, flush=True)
                else:
                    print(('\x1b[2J\x1b[H' if tty else ('\n' if last else '')) + show(view), file=out, flush=True)
                last = current
            if view['state'] in ('completed', 'failed'):
                return EXIT[view['state']]
            stalled = stalled + 1 if view['state'] == 'stalled' else 0
            if stalled >= STALL_SAMPLES:
                return EXIT['stalled']
            time.sleep(options['interval'])
    except KeyboardInterrupt:
        return 130
