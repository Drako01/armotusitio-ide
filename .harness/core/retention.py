"""Automatic cleanup of regenerable artifacts. Completed tasks keep only a minimal audit manifest; failed evidence
expires after the retention window. Every deletion is allowlisted, symlink-safe, dry-run capable and never raises."""
import json
import os
import re
import shutil
import stat
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from .config import H, ROOT, STATUSES, now, policy, read_json, setting, write_json
from . import worktree

MANIFESTS = 'state/manifests'
CHECKPOINTS = 'state/checkpoints'
DEFAULTS = {'enabled': True, 'failedDays': 7, 'graceMinutes': 10, 'seedDays': 7, 'completedLogKinds': ['execution', 'errors']}
SENSITIVE = re.compile(r'\.env(\..*)?$|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519)$|^\.netrc$', re.I)
ID = re.compile(r'[a-zA-Z0-9_-]+')


# -- configuration -------------------------------------------------------------------------------------------------
def disabled():
    return os.environ.get('HARNESS_KEEP_ARTIFACTS', '') in ('1', 'true', 'TRUE', 'yes')


def settings():
    """Policy `retention` over DEFAULTS; HARNESS_RETENTION_DAYS overrides the failed-evidence window."""
    try:
        values = {**DEFAULTS, **(policy().get('retention') or {})}
    except (OSError, ValueError):
        values = dict(DEFAULTS)
    try:
        values['failedDays'] = setting('HARNESS_RETENTION_DAYS', values['failedDays'], 0, 3650)
    except ValueError:
        values['failedDays'] = DEFAULTS['failedDays']
    return values


# -- path safety ---------------------------------------------------------------------------------------------------
def plain(path):
    """Strips the Windows extended-length prefix so comparisons and messages use ordinary paths."""
    text = str(path)
    if text.startswith('\\\\?\\UNC\\'):
        return '\\\\' + text[8:]
    return text[4:] if text.startswith('\\\\?\\') else text


def real(path):
    return os.path.normcase(plain(os.path.realpath(path)))


def is_link(path):
    """Symlinks and Windows junctions: neither may be followed or removed as if they were plain data."""
    path = Path(path)
    try:
        if path.is_symlink():
            return True
        junction = getattr(os.path, 'isjunction', None)
        return bool(junction and junction(path))
    except OSError:
        return True


def inside(path, base):
    child, parent = real(path), real(base)
    return child != parent and child.startswith(parent.rstrip('\\/') + os.sep)


def clean_chain(path):
    """True when the leaf is not a link and its real parent is the lexical parent: no `..`, link or junction escape."""
    path = Path(path)
    if '..' in path.parts or is_link(path):
        return False
    return real(path) == os.path.normcase(os.path.join(real(path.parent), path.name))


def roots():
    """Allowlisted managed directories. Anything outside them is never deleted."""
    found = [H / 'runtime', H / 'logs/execution', H / 'logs/errors', H / 'handoffs', H / 'tasks/sources', H / CHECKPOINTS]
    try:
        found.append(worktree.base_dir())
    except (ValueError, OSError):
        pass
    return found


def tracked():
    """Git-tracked paths under .harness (posix, relative to ROOT). Not a repository means nothing is tracked."""
    try:
        run = subprocess.run(['git', '-C', str(ROOT), 'ls-files', '-z', '--', '.harness'], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=60)
        if run.returncode:
            return set()
        return {name for name in run.stdout.decode('utf-8', 'replace').split('\0') if name}
    except (OSError, subprocess.SubprocessError):
        return set()


def is_tracked(path, index):
    try:
        rel = Path(plain(os.path.abspath(path))).relative_to(Path(plain(os.path.abspath(ROOT)))).as_posix()
    except ValueError:
        return False
    return rel in index or any(name.startswith(rel + '/') for name in index)


def mtime(path):
    try:
        return max([os.lstat(path).st_mtime] + [os.lstat(Path(c) / n).st_mtime for c, _, ns in os.walk(path) for n in ns]
                   if Path(path).is_dir() and not is_link(path) else [os.lstat(path).st_mtime])
    except OSError:
        return time.time()


def checkpoint_dir(task_id):
    return H / CHECKPOINTS / task_id


def checkpoints_valid(task_id, window_days, at):
    """Resumable evidence: the task has checkpoints and the newest one is younger than the retention window."""
    directory = checkpoint_dir(task_id)
    return directory.is_dir() and at - mtime(directory) < window_days * 86400


def protected(path, at=None, grace=None, index=None, done=False):
    """True when `path` must never be deleted: unmanaged, escaping, a link, .env/credentials, locks, tracked, still
    inside a valid checkpoint (unless the owner task is `done`) or younger than the grace period."""
    at = time.time() if at is None else at
    try:
        path = Path(path)
        cfg = settings()
        grace = cfg['graceMinutes'] * 60 if grace is None else grace
        if not any(inside(path, base) for base in roots()) or not clean_chain(path):
            return True
        if SENSITIVE.search(path.name) or path.name == 'workspace.lock' or path.suffix in ('.lock', '.recover') or path.name == '.gitkeep':
            return True
        if is_tracked(path, tracked() if index is None else index):
            return True
        base = real(H / CHECKPOINTS)
        if not done and real(path).startswith(base + os.sep):
            owner = Path(real(path)[len(base):].lstrip('\\/')).parts
            if owner and checkpoints_valid(owner[0], cfg['failedDays'], at):
                return True
        return at - mtime(path) < grace
    except (OSError, ValueError):
        return True


# -- deletion ------------------------------------------------------------------------------------------------------
def size_of(path):
    path = Path(path)
    if path.is_dir() and not is_link(path):
        return sum(os.lstat(Path(c) / n).st_size for c, _, ns in os.walk(path) for n in ns if not is_link(Path(c) / n))
    return os.lstat(path).st_size


def has_link_inside(path):
    path = Path(path)
    if not path.is_dir():
        return False
    return any(is_link(Path(c) / n) for c, ds, ns in os.walk(path) for n in ds + ns)


def force_remove(path):
    """rmtree with read-only repair and the extended-length prefix on Windows (long worktree paths)."""
    def repair(function, target, _):
        os.chmod(target, stat.S_IWRITE)
        function(target)
    target = str(path)
    if os.name == 'nt' and not target.startswith('\\\\?\\'):
        target = '\\\\?\\' + os.path.abspath(target)
    if os.path.isdir(target) and not os.path.islink(target):
        shutil.rmtree(target, onerror=repair)
    else:
        try:
            os.unlink(target)
        except PermissionError:
            os.chmod(target, stat.S_IWRITE)
            os.unlink(target)


# -- collection ----------------------------------------------------------------------------------------------------
def owned(name, task_id):
    return name.startswith(task_id + '-') or name.startswith(task_id + '.')


def active_ids():
    directory = H / 'tasks/active'
    return {f.stem for f in directory.glob('*.json')} if directory.is_dir() else set()


def active_sources():
    """Files referenced by an active task (declared source or sourceRef): never removed."""
    found = set()
    for file in (H / 'tasks/active').glob('*.json') if (H / 'tasks/active').is_dir() else []:
        try:
            task = read_json(file)
        except (OSError, ValueError):
            continue
        for value in (task.get('source'), (task.get('sourceRef') or {}).get('path')):
            if isinstance(value, str):
                found.add(real(ROOT / value.removeprefix('file:')))
    return found


def collect(task_id, task, status, cfg, completed):
    """Regenerable artifacts of one task as [{'cls','path','worktree'}]. Names must start with the task id."""
    items = []

    def add(cls, directory, predicate, **extra):
        if directory.is_dir():
            for entry in sorted(directory.iterdir()):
                if predicate(entry.name):
                    items.append({'cls': cls, 'path': entry, **extra})
    runtime = H / 'runtime'
    add('detailed-logs', runtime / 'output', lambda n: owned(n, task_id))
    add('intermediate-results', runtime, lambda n: owned(n, task_id) and n.endswith('.json'))
    add('temporary-seeds', runtime, lambda n: n.startswith('seeds-') and task_id in n)
    add('temporary-specs', runtime, lambda n: owned(n, task_id) and not n.endswith('.json') and n != 'output')
    source = task.get('source')
    if isinstance(source, str) and source.startswith('file:.harness/runtime/'):
        items.append({'cls': 'temporary-specs', 'path': ROOT / source[5:]})
    for kind in cfg['completedLogKinds']:
        add('execution-logs', H / 'logs' / kind, lambda n: owned(n, task_id))
    add('handoffs', H / 'handoffs', lambda n: owned(n, task_id))
    if completed:  # sources are only dispensable once the manifest recorded their hash
        add('task-sources', H / 'tasks/sources', lambda n: owned(n, task_id))
    if checkpoint_dir(task_id).is_dir():
        items.append({'cls': 'checkpoints', 'path': checkpoint_dir(task_id), 'done': completed})
    for entry in worktree.list_registry(task_id):
        items.append({'cls': 'worktrees', 'path': Path(entry.get('path', '')), 'worktree': entry})
    seen, unique = set(), []
    for item in items:
        key = (item['cls'], str(item['path']))
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def orphan_seeds(cfg, at, ids):
    """Temporary seeds not associated with any task id: removed after `seedDays`."""
    runtime = H / 'runtime'
    found = []
    for entry in sorted(runtime.glob('seeds-*')) if runtime.is_dir() else []:
        if not any(i in entry.name for i in ids) and at - mtime(entry) >= cfg['seedDays'] * 86400:
            found.append({'cls': 'orphan-seeds', 'path': entry})
    return found


# -- manifest ------------------------------------------------------------------------------------------------------
def manifest_file(task_id):
    return H / MANIFESTS / (task_id + '.json')


def head_commit():
    try:
        run = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
        text = run.stdout.decode().strip()
        return text if run.returncode == 0 and re.fullmatch(r'[0-9a-f]{40}', text) else None
    except (OSError, subprocess.SubprocessError):
        return None


def build_manifest(task):
    metrics = task.get('metrics') or {}
    nodes = [{k: n.get(k) for k in ('id', 'agent', 'status', 'attempts', 'wallMs') if n.get(k) is not None} for n in task.get('dag', [])]
    meta = task.get('metadata') if isinstance(task.get('metadata'), dict) else {}
    start, end = _stamp(task.get('createdAt')), _stamp(task.get('updatedAt'))
    return {'schemaVersion': 1, 'taskId': task['id'], 'status': task.get('status'), 'aborted': bool(task.get('aborted')),
            'domain': task.get('domain'), 'title': str(task.get('task', ''))[:160], 'createdAt': task.get('createdAt'),
            'finishedAt': task.get('updatedAt'), 'recordedAt': now(),
            'durationMs': metrics.get('durationMs') if metrics.get('durationMs') is not None else (int((end - start) * 1000) if start and end else None),
            'workers': metrics.get('workers'), 'agents': task.get('agents', []), 'gates': nodes,
            'result': 'passed' if task.get('status') == 'completed' else task.get('status'),
            'commit': head_commit(), 'pr': task.get('pr') or meta.get('pr'), 'source': task.get('source'),
            'sourceRef': task.get('sourceRef'), 'cleanups': []}


def _stamp(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(timezone.utc).timestamp()
    except (ValueError, TypeError):
        return None


def ensure_manifest(task):
    """Writes the manifest when absent and proves it is readable. Returns it, or None (then nothing may be deleted)."""
    file = manifest_file(task['id'])
    try:
        if not file.exists():
            if not (inside(file, H / 'state') and clean_chain(file)):
                return None
            write_json(file, build_manifest(task), durable=True)
        data = read_json(file)
        return data if data.get('taskId') == task['id'] else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


# -- orchestration -------------------------------------------------------------------------------------------------
def remove_item(item, at, grace, index, apply):
    """Deletes one item after re-validating it. Returns (bytes, None) or (0, reason)."""
    path = item['path']
    try:
        if not path.exists() and not is_link(path):
            return 0, 'missing'
        if item.get('worktree'):
            base = worktree.base_dir()
            if not (inside(path, base) and clean_chain(path)):
                return 0, 'worktree outside managed directory'
            amount = size_of(path) if path.exists() else 0
            if apply:
                entry = item['worktree']
                try:
                    worktree.Worktree(entry['task'], entry['node'], entry['attempt'], entry['runId']).discard()
                except (ValueError, OSError, subprocess.SubprocessError, KeyError):
                    pass
                if path.exists():
                    force_remove(path)
                    subprocess.run(['git', '-C', str(ROOT), 'worktree', 'prune'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                worktree.registry_file(entry['name']).unlink(missing_ok=True)
            return amount, None
        if item['path'].is_dir() and has_link_inside(path):
            return 0, 'contains links'
        if protected(path, at, grace, index, item.get('done', False)):
            return 0, 'protected'
        amount = size_of(path)
        if apply:
            force_remove(path)
        return amount, None
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return 0, 'error: ' + type(error).__name__


def process(task_id, task, status, apply, at, grace, cfg, extra=()):
    """Cleans one terminal task. The manifest is persisted and verified before the first deletion."""
    result = {'id': task_id, 'status': status, 'classes': {}, 'skipped': [], 'manifest': None}
    completed = status == 'completed'
    items = collect(task_id, task, status, cfg, completed) + list(extra)
    sources = active_sources()
    live = [i for i in items if real(i['path']) not in sources]
    if not live:
        return result
    index = tracked()
    manifest = None
    if apply:
        manifest = ensure_manifest({**task, 'id': task_id, 'status': status})
        if manifest is None:
            result['skipped'].append('manifest-unavailable')
            return result
        result['manifest'] = manifest_file(task_id).relative_to(ROOT).as_posix()
    for item in live:
        amount, reason = remove_item(item, at, grace, index, apply)
        if reason == 'missing':
            continue
        if reason:
            result['skipped'].append({'path': plain(item['path']), 'reason': reason})
            continue
        slot = result['classes'].setdefault(item['cls'], {'files': 0, 'bytes': 0})
        slot['files'] += 1
        slot['bytes'] += amount
    if apply and result['classes']:
        try:
            manifest['cleanups'].append({'at': now(), 'classes': result['classes']})
            write_json(manifest_file(task_id), manifest, durable=True)
        except (OSError, ValueError, KeyError, TypeError):
            pass
    return result


def on_task_finished(task):
    """Called by lifecycle once a task reached completed/failed. Completed tasks are cleaned right away (their own
    artifacts are not in flight, so the grace period does not apply); failed ones are kept until they expire.
    Never raises, idempotent."""
    outcome = {'task': None, 'disabled': False, 'removed': {}, 'skipped': [], 'manifest': None}
    try:
        task_id = task['id']
        outcome['task'] = task_id
        if disabled() or not settings()['enabled']:
            outcome['disabled'] = True
            return outcome
        if not ID.fullmatch(task_id) or task_id in active_ids() or task.get('status') != 'completed':
            outcome['skipped'].append('not-completed' if task.get('status') != 'completed' else 'active')
            return outcome
        data = process(task_id, task, 'completed', True, time.time(), 0, settings())
        outcome.update(removed=data['classes'], skipped=data['skipped'], manifest=data['manifest'])
    except Exception as error:  # cleanup must never fail the task
        outcome['skipped'].append('error: ' + type(error).__name__)
    return outcome


def sweep(apply=False, now=None):
    """Hygiene entry point: every completed task leftover, every failed/aborted task past its window and orphan seeds.
    `apply=False` is a dry run that lists what would be removed."""
    at = time.time() if now is None else now
    report = {'apply': apply, 'disabled': False, 'retentionDays': None, 'tasks': [], 'files': 0, 'bytes': 0}
    try:
        cfg = settings()
        report['retentionDays'] = cfg['failedDays']
        if disabled() or not cfg['enabled']:
            report['disabled'] = True
            return report
        from .hygiene import scan_tasks
        rows, grace, active = scan_tasks(), cfg['graceMinutes'] * 60, active_ids()
        for row in rows:
            task_id, status, task = row['id'], row['status'], row['task']
            if row['invalid'] or status == 'active' or task_id in active or not ID.fullmatch(task_id) or status not in STATUSES:
                continue
            if status == 'failed':
                stamp = _stamp(task.get('updatedAt') or task.get('createdAt')) or mtime(row['file'])
                if at - stamp < cfg['failedDays'] * 86400 or checkpoints_valid(task_id, cfg['failedDays'], at):
                    continue
            data = process(task_id, task, status, apply, at, grace, cfg)
            if data['classes'] or data['skipped']:
                report['tasks'].append(data)
        seeds = orphan_seeds(cfg, at, [r['id'] for r in rows])
        if seeds:
            data = process('orphan-seeds', {}, 'orphan', False, at, grace, cfg, extra=seeds) if not apply else _sweep_seeds(seeds, at, grace)
            report['tasks'].append(data)
        report['files'] = sum(c['files'] for t in report['tasks'] for c in t['classes'].values())
        report['bytes'] = sum(c['bytes'] for t in report['tasks'] for c in t['classes'].values())
    except Exception as error:
        report['error'] = type(error).__name__ + ': ' + str(error)[:200]
    return report


def _sweep_seeds(seeds, at, grace):
    """Orphan seeds have no task and so no manifest to write; the sweep report itself is the record."""
    result, index = {'id': 'orphan-seeds', 'status': 'orphan', 'classes': {}, 'skipped': [], 'manifest': None}, tracked()
    for item in seeds:
        amount, reason = remove_item(item, at, grace, index, True)
        if reason and reason != 'missing':
            result['skipped'].append({'path': plain(item['path']), 'reason': reason})
        elif not reason:
            slot = result['classes'].setdefault('orphan-seeds', {'files': 0, 'bytes': 0})
            slot['files'] += 1
            slot['bytes'] += amount
    return result
