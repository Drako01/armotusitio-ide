"""Operational hygiene report and guarded quarantine of invalid failed evidence. Report mode never writes."""
import contextlib
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from .config import H, ROOT, STATUSES, UsageError, read_json
from .state import Lock, alive, assert_task_id, log, validate_task
from . import worktree

QUARANTINE_COMMAND = 'pnpm harness:hygiene -- --quarantine-invalid --yes'
PRUNE_COMMAND = 'pnpm harness:hygiene -- --prune-worktrees --yes'
DAY_MS = 86400000


def parse_args(args):
    options, rest, index = {'json': False, 'staleDays': 7, 'quarantine': False, 'yes': False, 'pruneWorktrees': False,
                          'applyRetention': False, 'retentionReport': False}, list(args), 0
    while index < len(rest):
        arg = rest[index]
        if arg == '--json':
            options['json'] = True
        elif arg == '--quarantine-invalid':
            options['quarantine'] = True
        elif arg == '--prune-worktrees':
            options['pruneWorktrees'] = True
        elif arg == '--apply-retention':
            options['applyRetention'] = True
        elif arg == '--retention-report':
            options['retentionReport'] = True
        elif arg == '--yes':
            options['yes'] = True
        elif arg == '--stale-days':
            index += 1
            value = rest[index] if index < len(rest) else ''
            if not re.fullmatch(r'\d+', value) or not 0 <= int(value) <= 3650:
                raise UsageError('--stale-days requiere un entero entre 0 y 3650')
            options['staleDays'] = int(value)
        else:
            raise UsageError('Opción inválida para hygiene: ' + arg)
        index += 1
    if options['yes'] and not (options['quarantine'] or options['pruneWorktrees'] or options['applyRetention']):
        raise UsageError('--yes sólo aplica junto con --quarantine-invalid, --prune-worktrees o --apply-retention')
    if options['quarantine'] and options['pruneWorktrees']:
        raise UsageError('--quarantine-invalid y --prune-worktrees se ejecutan por separado')
    if options['applyRetention'] + options['retentionReport'] + (options['quarantine'] or options['pruneWorktrees']) > 1:
        raise UsageError('--apply-retention y --retention-report se ejecutan por separado de los demás modos')
    return options


def parse_time(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def scan_tasks():
    """Raw view of every lifecycle record: {'id','status','file','task','invalid'}; invalid holds the rejection reason."""
    rows = []
    for status in STATUSES:
        directory = H / 'tasks' / status
        if not directory.is_dir():
            continue
        for file in sorted(directory.glob('*.json')):
            row = {'id': file.stem, 'status': status, 'file': file, 'task': None, 'invalid': None}
            try:
                row['task'] = read_json(file)
                if not isinstance(row['task'], dict):
                    raise ValueError('record is not an object')
                validate_task(row['task'], status)
            except (ValueError, KeyError, TypeError) as error:
                row['invalid'] = str(error)
            rows.append(row)
    return rows


def lock_state(identity):
    file = H / 'state' / (identity + '.lock')
    if not file.exists():
        return 'missing'
    try:
        info = read_json(file)
        pid = info.get('pid')
        if not isinstance(pid, int) or pid <= 0:
            return 'malformed'
        return 'alive' if alive(pid) else 'dead'
    except (ValueError, OSError):
        return 'malformed'


def dir_size(path):
    total = 0
    for current, _, names in os.walk(path):
        for name in names:
            try:
                total += (Path(current) / name).stat().st_size
            except OSError:
                pass
    return total


def finding(kind, task, detail, action):
    return {'kind': kind, 'task': task, 'detail': detail, 'action': action}


def report(stale_days=7):
    rows, findings, ids = scan_tasks(), [], set()
    ids = {row['id'] for row in rows}
    cutoff = time.time() - stale_days * DAY_MS / 1000
    for row in rows:
        task = row['task']
        if row['invalid']:
            if row['status'] == 'failed':
                findings.append(finding('invalid-evidence', row['id'], row['invalid'], QUARANTINE_COMMAND))
            continue
        if row['status'] == 'active':
            stamp = parse_time(task.get('updatedAt') or task.get('createdAt'))
            if stamp is None or stamp.timestamp() < cutoff:
                findings.append(finding('stale-active', row['id'], 'sin actualización desde ' + str(task.get('updatedAt') or task.get('createdAt')),
                                        f'pnpm harness:abort -- {row["id"]} "tarea estancada"'))
            if task.get('domain') != 'multi':
                lock = lock_state(row['id'])
                if lock != 'alive':
                    findings.append(finding('active-without-live-lock', row['id'], 'lock ' + lock,
                                            f'pnpm harness:execute -- {row["id"]} (reanudar) o pnpm harness:abort -- {row["id"]} "sin ejecución"'))
        else:
            running = [n['id'] for n in task.get('dag', []) if n.get('status') == 'running']
            if running:
                action = (f'pnpm harness:retry -- {row["id"]} "nodos interrumpidos"' if row['status'] == 'failed'
                          else 'inspeccionar manualmente: tarea completed con nodos running')
                findings.append(finding('running-in-terminal', row['id'], f'{row["status"]}: nodos running ' + ', '.join(running), action))
    state_dir = H / 'state'
    if state_dir.is_dir():
        for file in sorted(state_dir.glob('*.json')):
            try:
                data = read_json(file)
            except (ValueError, OSError):
                data = {}
            linked = {file.stem}
            if isinstance(data, dict):
                linked |= {data[k] for k in ['id', 'taskId'] if isinstance(data.get(k), str)}
            if not linked & ids and not any(file.stem.startswith(i + '-') for i in ids):
                findings.append(finding('orphan-state', file.stem, 'state/' + file.name + ' sin tarea asociada',
                                        'revisar y eliminar manualmente (hygiene no borra state/)'))
    status_of = {row['id']: row for row in rows}
    for entry in worktree.list_registry():
        row = status_of.get(entry.get('task'))
        removable = row is None or row['status'] == 'completed' or (row['task'] or {}).get('aborted')
        findings.append(finding('leftover-worktree', entry.get('task', '?'),
                                f'{entry.get("state")} {entry.get("node")}#{entry.get("attempt")} {entry.get("path")}',
                                PRUNE_COMMAND if removable else 'conservado como evidencia de un intento; inspeccionar, luego harness:retry/abort y prune'))
    runtime = H / 'runtime'
    return {'staleDays': stale_days, 'findings': findings, 'runtimeBytes': dir_size(runtime) if runtime.is_dir() else 0,
            'summary': {k: sum(1 for f in findings if f['kind'] == k) for k in sorted({f['kind'] for f in findings})}}


def sha256(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def plan_quarantine(file):
    legacy = H / 'tasks/legacy'
    target = legacy / file.name
    if not target.exists():
        return {'file': file.name, 'action': 'move', 'to': target}
    if sha256(target) == sha256(file):
        return {'file': file.name, 'action': 'remove-duplicate', 'to': target}
    digest = sha256(file)[:8]
    for counter in range(100):
        suffix = '.' + digest + ('' if counter == 0 else '-' + str(counter))
        candidate = legacy / (file.stem + suffix + file.suffix)
        if not candidate.exists():
            return {'file': file.name, 'action': 'move-suffixed', 'to': candidate}
        if sha256(candidate) == sha256(file):
            return {'file': file.name, 'action': 'remove-duplicate', 'to': candidate}
    raise ValueError('Sin nombre libre en tasks/legacy para ' + file.name)


def invalid_candidates():
    from .security import contained
    candidates = [r for r in scan_tasks() if r['status'] == 'failed' and r['invalid']]
    for row in candidates:
        assert_task_id(row['id'], 'Evidencia con nombre inválido; inspeccionar manualmente: ' + row['id'])
        if not contained(row['file'].relative_to(ROOT).as_posix()) or not contained('.harness/tasks/legacy'):
            raise ValueError('Task storage symlink rejected')
    return candidates


def quarantine(apply):
    """Plan (and with apply=True execute) the move of failed evidence rejected as invalid; valid tasks are never touched.
    The candidates are scanned again once the workspace lock is held: a task that changed meanwhile is not acted upon."""
    if not apply:
        plans = [plan_quarantine(r['file']) for r in invalid_candidates()]
        return [{**p, 'to': p['to'].relative_to(ROOT).as_posix(), 'applied': False} for p in plans]
    results = []
    with Lock(H / 'state/workspace.lock'):
        candidates = invalid_candidates()
        (H / 'tasks/legacy').mkdir(parents=True, exist_ok=True)
        for row in candidates:
            file = row['file']
            plan = plan_quarantine(file)
            if plan['action'] != 'remove-duplicate':
                content = file.read_bytes()
                with plan['to'].open('xb') as stream:  # 'x' guarantees an existing legacy file is never overwritten
                    stream.write(content)
            file.unlink()
            relative = plan['to'].relative_to(ROOT).as_posix()
            log('audit', row['id'], 'quarantined-invalid-evidence', {'action': plan['action'], 'to': relative, 'reason': row['invalid']})
            results.append({**plan, 'to': relative, 'applied': True})
    return results


def prune_worktrees(apply):
    """Removes isolated checkouts of completed (or operator-aborted) tasks. Patches, journals and handoffs stay."""
    rows = {row['id']: row for row in scan_tasks()}
    results = []
    with (Lock(H / 'state/workspace.lock') if apply else contextlib.nullcontext()):
        for entry in worktree.list_registry():
            row = rows.get(entry.get('task'))
            if row is not None and not (row['status'] == 'completed' or (row['task'] or {}).get('aborted')):
                continue
            item = {'name': entry['name'], 'task': entry['task'], 'state': entry.get('state'), 'applied': apply}
            if apply:
                worktree.Worktree(entry['task'], entry['node'], entry['attempt'], entry['runId']).discard()
                log('audit', entry['task'], 'worktree-pruned', {'name': entry['name'], 'state': entry.get('state')})
            results.append(item)
    return results


def retention_pass(apply):
    """Retention sweep (see core/retention.py): the report is a dry run; apply holds the workspace lock like prune does."""
    from . import retention
    with (Lock(H / 'state/workspace.lock') if apply else contextlib.nullcontext()):
        return retention.sweep(apply=apply)


def render_retention(data):
    if data['disabled']:
        return 'Retención desactivada (HARNESS_KEEP_ARTIFACTS o policy retention.enabled).'
    lines = [('Aplicado' if data['apply'] else 'Dry-run (usar --apply-retention)') + f': {data["files"]} artefactos, {data["bytes"]} bytes (fallidas > {data["retentionDays"]} días)']
    for task in data['tasks']:
        lines.append(f'- {task["id"]} ({task["status"]}): ' + (', '.join(f'{k}={v["files"]}/{v["bytes"]}B' for k, v in sorted(task['classes'].items())) or 'sin cambios'))
        lines.extend(f'    omitido: {s}' for s in task['skipped'])
    return '\n'.join(lines)


def render(data):
    lines = [f'Harness hygiene (stale > {data["staleDays"]} días) — runtime/: {data["runtimeBytes"]} bytes']
    if not data['findings']:
        lines.append('Sin hallazgos.')
    for item in data['findings']:
        lines.append(f'- [{item["kind"]}] {item["task"]}: {item["detail"]}\n    acción: {item["action"]}')
    return '\n'.join(lines)


def main(args):
    options = parse_args(args)
    if options['quarantine']:
        results = quarantine(options['yes'])
        if options['json']:
            print(json.dumps({'applied': options['yes'], 'results': results}, ensure_ascii=False, indent=2))
        elif not results:
            print('Sin evidencia inválida en tasks/failed.')
        else:
            for item in results:
                print(('Aplicado' if item['applied'] else 'Dry-run (usar --yes)') + f': {item["action"]} {item["file"]} -> {item["to"]}')
        return 0
    if options['applyRetention'] or options['retentionReport']:
        data = retention_pass(options['applyRetention'])
        print(json.dumps(data, ensure_ascii=False, indent=2) if options['json'] else render_retention(data))
        return 0
    if options['pruneWorktrees']:
        results = prune_worktrees(options['yes'])
        if options['json']:
            print(json.dumps({'applied': options['yes'], 'results': results}, ensure_ascii=False, indent=2))
        elif not results:
            print('Sin worktrees removibles.')
        else:
            for item in results:
                print(('Eliminado' if item['applied'] else 'Dry-run (usar --yes)') + f': {item["name"]} ({item["state"]})')
        return 0
    data = report(options['staleDays'])
    print(json.dumps(data, ensure_ascii=False, indent=2) if options['json'] else render(data))
    return 0
