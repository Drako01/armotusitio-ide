"""Per-unit checkpoints: resume only what failed, reuse what is still valid, never repeat side effects blindly.

A checkpoint is written when an implementer unit (a node that exclusively `owns` paths) finishes. It stores a digest of
every input that could change its outcome: the content of the owned paths, HEAD, lockfiles, a small env allowlist, the
Harness manifests, the unit spec and the task text. On the next execution a `passed` checkpoint whose digest still
matches restores the node as passed WITHOUT running the agent again; any change invalidates it and the unit reruns.
Reviewers, security auditors, verifiers and other nodes without ownership are never reused: they judge the whole tree.
Units with external effects are never rerun silently: they need an explicit `harness:resume <id> --reconcile <unit>`.
"""
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from .config import H, ROOT, NON_IMPLEMENTERS, now, read_json, write_json, digest

ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]*')
LOCKFILES = ('pnpm-lock.yaml', 'apps/api/go.sum', 'package.json', 'apps/api/go.mod')
ENV_ALLOWLIST = ('NODE_ENV', 'GOFLAGS', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'HARNESS_BASE')  # HARNESS_HOST left out on purpose
MANIFESTS = ('manifests/policies.json', 'manifests/agents.json', 'manifests/domains.json')
MAX_OWNED_FILES = 2000


def storage(task_id, unit=None):
    """Checkpoint path under the managed root; ids are validated so a crafted id can never escape it."""
    root = (H / 'state' / 'checkpoints').resolve()
    for part in filter(None, [task_id, unit]):
        if not ID.fullmatch(str(part)):
            raise ValueError('Invalid checkpoint id: ' + str(part))
    path = (root / task_id / (unit + '.json')) if unit else (root / task_id)
    if root not in path.resolve().parents and path.resolve() != root:
        raise ValueError('Checkpoint path escapes managed storage')
    return path


def reusable(node):
    """Only implementer units with exclusive ownership are checkpointed: everything else judges the whole tree."""
    return bool(node.get('owns')) and node['agent'] not in NON_IMPLEMENTERS


def has_effects(node):
    return bool(node.get('effects') == 'external' or node.get('sideEffects') or node.get('kind') == 'external')


def git(*args):
    try:
        return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return ''


def owned_files(owns):
    files = []
    for pattern in owns:
        base = pattern.rstrip('*').rstrip('/') if pattern.endswith('*') else pattern
        for path in ([ROOT / base] if (ROOT / base).is_file() else sorted((ROOT / base).rglob('*')) if (ROOT / base).is_dir() else []):
            if path.is_file():
                files.append(path)
            if len(files) > MAX_OWNED_FILES:
                raise ValueError('owned scope too large to checkpoint')
    return sorted(set(files))


def inputs_digest(task, node):
    """Digest of everything that can change the unit's outcome. Any failure to compute it means 'not reusable'."""
    parts = {'head': git('rev-parse', 'HEAD').strip(), 'task': digest(task['task']),
             'node': digest(json.dumps({k: node.get(k) for k in ('id', 'agent', 'owns', 'reads', 'dependsOn', 'kind')}, sort_keys=True)),
             'env': digest(json.dumps({k: os.environ.get(k, '') for k in ENV_ALLOWLIST}, sort_keys=True))}
    hasher = hashlib.sha256()
    for path in owned_files(node['owns']):
        hasher.update(path.relative_to(ROOT).as_posix().encode() + b'\0' + path.read_bytes())
    parts['code'] = hasher.hexdigest()
    parts['deps'] = digest(''.join(digest((ROOT / f).read_bytes()) for f in LOCKFILES if (ROOT / f).is_file()))
    parts['config'] = digest(''.join(digest((H / m).read_bytes()) for m in MANIFESTS if (H / m).is_file()))
    return digest(json.dumps(parts, sort_keys=True))


def read(task_id, unit):
    try:
        return read_json(storage(task_id, unit))
    except (OSError, ValueError):
        return None


def begin(task, node):
    """Marks a unit as started. Units with external effects are marked as possibly done from this moment on."""
    if not reusable(node):
        return
    effects = has_effects(node)
    write_json(storage(task['id'], node['id']), {
        'unit': node['id'], 'agent': node['agent'], 'phase': 'run', 'status': 'running', 'attempt': node.get('attempts', 0),
        'startedAt': now(), 'pid': os.getpid(), 'sideEffects': {'declared': effects, 'done': effects, 'reconciled': False}})


def finish(task, node):
    """Records the outcome of a finished unit; only a passed unit becomes reusable."""
    if not reusable(node):
        return
    previous = read(task['id'], node['id']) or {}
    status = 'passed' if node.get('status') == 'passed' else 'failed'
    effects = previous.get('sideEffects') or {'declared': has_effects(node), 'done': False, 'reconciled': False}
    if node.get('failureCategory') == 'host-unavailable':
        effects['done'] = False  # the host never ran: nothing happened that could repeat
    record = {**previous, 'unit': node['id'], 'agent': node['agent'], 'phase': 'run', 'status': status, 'attempt': node.get('attempts', 0),
              'finishedAt': now(), 'sideEffects': effects, 'failureCategory': node.get('failureCategory')}
    if status == 'passed':
        record['inputsDigest'] = inputs_digest(task, node)
    write_json(storage(task['id'], node['id']), record)


def safely(function, *args):
    """Checkpointing must never break an execution; failures just mean 'no checkpoint'."""
    try:
        return function(*args)
    except Exception:
        return None


def alive(pid):
    try:
        value = int(pid)
    except (OSError, ValueError, TypeError):
        return False
    if value <= 0:
        return False
    # On Windows signal 0 is CTRL_C_EVENT, not a harmless existence probe.
    # Reuse the non-signalling OpenProcess implementation used by workspace locks.
    from .state import alive as process_alive
    return process_alive(value)


def classify(task, node):
    """('reuse'|'rerun'|'reconcile', reason) for one unit given its checkpoint."""
    record = read(task['id'], node['id'])
    if not record:
        return 'rerun', 'sin checkpoint'
    effects = record.get('sideEffects') or {}
    if record['status'] == 'running':
        if alive(record.get('pid')) and record.get('pid') != os.getpid():
            return 'rerun', 'en ejecución por otro proceso'
        return ('reconcile', 'interrumpida con efectos externos posibles') if effects.get('done') and not effects.get('reconciled') \
            else ('rerun', 'interrumpida')
    if record['status'] == 'failed':
        return ('reconcile', 'falló con efectos externos posibles') if effects.get('done') and not effects.get('reconciled') else ('rerun', 'falló')
    if record['status'] == 'passed':
        try:
            valid = record.get('inputsDigest') == inputs_digest(task, node)
        except (OSError, ValueError):
            valid = False
        return ('reuse', 'checkpoint válido') if valid else ('rerun', 'entradas cambiaron: checkpoint invalidado')
    return 'rerun', 'estado desconocido'


def plan(task):
    return [{'unit': n['id'], 'action': (classify(task, n) if reusable(n) else ('rerun', 'sin ownership: se vuelve a juzgar'))[0],
             'reason': (classify(task, n) if reusable(n) else ('rerun', 'sin ownership: se vuelve a juzgar'))[1]} for n in task['dag']]


def apply(task):
    """Restores valid units as passed and blocks units that need reconciliation. Returns what was reused and blocked."""
    reused, blocked = [], []
    for node in task['dag']:
        if not reusable(node) or node['status'] == 'passed':
            continue
        action, reason = classify(task, node)
        if action == 'reuse':
            node['status'] = 'passed'
            node['resumedFromCheckpoint'] = now()
            reused.append(node['id'])
        elif action == 'reconcile':
            node['status'] = 'blocked'
            node['blockedBy'] = 'reconcile-required'
            blocked.append(node['id'])
        elif read(task['id'], node['id']) and (read(task['id'], node['id']) or {}).get('status') == 'passed':
            # A previously passed unit whose inputs changed: everything downstream must be judged again.
            for other in task['dag']:
                if other['status'] == 'passed' and node['id'] in other.get('dependsOn', []):
                    other['status'] = 'pending'
    if reused or blocked:
        try:
            from . import telemetry
            telemetry.record('resume', key=task['id'], reused=len(reused), blocked=len(blocked))
        except Exception:
            pass
    return {'reused': reused, 'blocked': blocked}


def reconcile(task_id, unit):
    """Operator confirms the side effects of a unit were checked: the unit may run again."""
    record = read(task_id, unit)
    if not record:
        raise ValueError('No hay checkpoint para ' + unit)
    record.setdefault('sideEffects', {})['reconciled'] = True
    write_json(storage(task_id, unit), record)
    return record


def resume(task_id, dry_run=False, reconcile_units=()):
    from .tasks import load_task, retry_task
    task = load_task(task_id)
    for unit in reconcile_units:
        reconcile(task_id, unit)
    report = {'task': task_id, 'status': task['status'], 'units': plan(task)}
    if dry_run:
        return report
    if task['status'] == 'failed':
        retry_task(task_id, 'resume from checkpoints')
    from .lifecycle import execute
    result = execute(task_id)
    return {**report, 'result': result['status']}


def main(args):
    from .config import UsageError
    if not args or args[0].startswith('--'):
        raise UsageError('Uso: harness:resume <task-id> [--dry-run] [--reconcile <unit>]...')
    reconciles = [args[i + 1] for i, a in enumerate(args) if a == '--reconcile' and i + 1 < len(args)]
    print(json.dumps(resume(args[0], '--dry-run' in args, reconciles), ensure_ascii=False, indent=2))
    return 0
