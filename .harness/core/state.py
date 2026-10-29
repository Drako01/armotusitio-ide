"""Validated lifecycle records, compact handoffs and cross-platform exclusive locks."""
import errno
import os
import re
import secrets
import socket
import sys
import time
from pathlib import Path
from .config import H, ROOT, STATUSES, now, read_json, jread, write_json, validate_schema, local_hook


def assert_task_id(value, message='Task id invalid'):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9_-]+', value):
        raise ValueError(message)


def platform():
    return 'win32' if os.name == 'nt' else sys.platform


def alive(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if handle:
            kernel.CloseHandle(handle)
            return True
        return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER is the only dead-process proof.
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class Lock:
    def __init__(self, file):
        self.file, self.token = Path(file), secrets.token_hex(16)

    def __enter__(self):
        file = self.file
        from .security import contained
        if not contained(file.relative_to(ROOT).as_posix()):
            raise ValueError('Lock storage symlink rejected')
        file.parent.mkdir(parents=True, exist_ok=True)
        recovery = file.with_name(file.name + '.recover')
        for _ in range(3):
            if recovery.exists():
                raise ValueError('Task is already executing (lock recovery)')
            try:
                with file.open('x', encoding='utf-8') as stream:
                    import json
                    json.dump({'pid': os.getpid(), 'token': self.token, 'at': int(time.time()*1000),
                               'platform': platform(), 'host': socket.gethostname()}, stream)
                return self
            except FileExistsError:
                pass
            try:
                guard = recovery.open('x')
            except FileExistsError:
                raise ValueError('Task is already executing (lock recovery)') from None
            try:
                info = read_json(file)
                if not isinstance(info.get('pid'), int) or info['pid'] <= 0:
                    raise ValueError('Malformed lock; inspect owner before recovery')
                if info.get('platform') and (info['platform'] != platform() or info.get('host') != socket.gethostname()):
                    raise ValueError('Lock owned by another environment; confirm no execute running and delete ' + file.name)
                if alive(info['pid']):
                    raise ValueError('Task is already executing (lock: ' + file.name + ')')
                if read_json(file) != info:
                    raise ValueError('Lock owner changed during recovery')
                file.unlink()
            finally:
                guard.close()
                recovery.unlink()
        raise ValueError('Could not acquire task lock')

    def __exit__(self, *_):
        if self.file.exists() and read_json(self.file).get('token') == self.token:
            self.file.unlink()


def reopen_nodes(task):
    for node in task.get('dag', []):
        if node['status'] in ['failed', 'blocked', 'running']:
            node['status'] = 'pending'


def validate_task(task, expected_status=None):
    errors = validate_schema(task, jread('manifests/task.schema.json'))
    def bad(reason):
        raise ValueError(f'Invalid task {task.get("id", "?")}: {reason}; inspect then quarantine legacy evidence')
    if errors:
        bad('; '.join(errors))
    assert_task_id(task['id'])
    if expected_status and task['status'] != expected_status:
        bad('directory/status mismatch')
    if task['status'] == 'completed' and task.get('scopeViolation'):
        bad('completed with unresolved scope violation')
    if task['domain'] == 'multi':
        children = task.get('children')
        if not isinstance(children, list) or not children or len(set(children)) != len(children) or task['id'] in children:
            bad('children')
        for child in children:
            assert_task_id(child)
        if task.get('bootstrap') and task['bootstrap'] not in children:
            bad('bootstrap')
        return task
    dag = task.get('dag')
    if not isinstance(dag, list) or not dag:
        bad('missing DAG')
    nodes = {}
    for node in dag:
        # Legacy nodes have id == agent; planned nodes separate node id (unique, filesystem-safe) from the agent contract.
        if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not re.fullmatch(r'[a-zA-Z0-9_-]+', node['id']) or node['id'] in nodes or not isinstance(node.get('agent'), str) or not node['agent'] or (node['agent'] != node['id'] and not node.get('unit')) or not isinstance(node.get('dependsOn'), list) or len(set(node['dependsOn'])) != len(node['dependsOn']) or node.get('status') not in ['pending', 'running', 'passed', 'failed', 'blocked'] or type(node.get('attempts')) is not int or node['attempts'] < 0:
            bad('malformed DAG node')
        if 'owns' in node and (not isinstance(node['owns'], list) or any(not isinstance(p, str) or not p for p in node['owns'])):
            bad('malformed node ownership')
        nodes[node['id']] = node
    agents = task.get('agents', [])
    if all(n['agent'] == n['id'] for n in nodes.values()):
        if len(agents) != len(nodes) or set(agents) != set(nodes):
            bad('agents/DAG mismatch')
    elif set(agents) != {n['agent'] for n in nodes.values()} or len(set(agents)) != len(agents):
        bad('agents/DAG mismatch')
    visited, visiting = set(), set()
    def visit(node):
        if node['id'] in visiting:
            bad('DAG cycle')
        if node['id'] in visited:
            return
        visiting.add(node['id'])
        for dep in node['dependsOn']:
            if dep not in nodes:
                bad('missing dependency')
            if node['status'] == 'passed' and nodes[dep]['status'] != 'passed':
                bad('passed node with unpassed dependency')
            visit(nodes[dep])
        visiting.remove(node['id'])
        visited.add(node['id'])
    for node in dag:
        visit(node)
    if task['status'] == 'completed' and any(n['status'] != 'passed' for n in dag):
        bad('completed with unpassed nodes')
    return task


def persist_task(task):
    # A parallel worker persists through the scheduler, which merges its node into the authoritative task under a lock.
    sink = local_hook('persist')
    if sink is not None:
        return sink(task)
    return write_task(task)


def write_task(task):
    from .security import contained
    validate_task(task)
    assert_task_id(task['id'])
    if task['status'] not in STATUSES:
        raise ValueError('Invalid lifecycle status')
    for directory in ['inbox', *STATUSES]:
        if not contained(f'.harness/tasks/{directory}'):
            raise ValueError('Task storage symlink rejected')
        (H / 'tasks' / directory).mkdir(parents=True, exist_ok=True)
    write_json(H / 'tasks' / task['status'] / (task['id'] + '.json'), task, durable=True)
    write_json(H / 'state' / (task['id'] + '.json'),
               {'id': task['id'], 'status': task['status'], 'domain': task['domain'], 'updatedAt': now(),
                'current': [n['id'] for n in task.get('dag', []) if n['status'] == 'running'],
                'scope': task.get('contextSlice', {}).get('paths', []), 'refs': [task['sourceRef']] if task.get('sourceRef') else [],
                'nextStep': next((n['id'] for n in task.get('dag', []) if n['status'] in ['pending', 'blocked']), None)})


def move_task(task, next_status):
    transitions = {'active': ['active', 'failed', 'completed'], 'failed': ['active', 'failed'], 'completed': ['completed']}
    if next_status not in transitions.get(task['status'], []):
        raise ValueError('Invalid lifecycle transition')
    if next_status == 'completed' and task.get('scopeViolation'):
        raise ValueError('Task cannot complete with an unresolved scope violation')
    if next_status == 'completed':
        validate_task({**task, 'status': next_status})
    old = H / 'tasks' / task['status'] / (task['id'] + '.json')
    task['status'], task['updatedAt'] = next_status, now()
    persist_task(task)
    if old != H / 'tasks' / next_status / (task['id'] + '.json'):
        old.unlink(missing_ok=True)


def log(kind, task_id, event, data=None):
    assert_task_id(task_id)
    if kind not in ['execution', 'errors', 'audit', 'completed']:
        raise ValueError('Invalid log kind')
    write_json(H / 'logs' / kind / f'{task_id}-{int(time.time()*1000)}-{secrets.token_hex(3)}.json',
               {'taskId': task_id, 'event': event, 'at': now(), **(data or {})})


def handoff(task, node, status, extra=None):
    extra = extra or {}
    result = {'schemaVersion': 1, 'taskId': task['id'], 'domain': task['domain'], 'agent': node['agent'],
              **({'node': node['id']} if node['id'] != node['agent'] else {}), **({'runId': node['runId']} if node.get('runId') else {}),
              'status': status, 'attempt': node['attempts'],
              **{k: extra.get(k, []) for k in ['changes', 'files', 'decisions', 'risks', 'verification']},
              'nextAction': extra.get('nextAction'), 'at': now()}
    errors = validate_schema(result, jread('manifests/handoff.schema.json'))
    if errors:
        raise ValueError('Invalid handoff: ' + '; '.join(errors))
    # Full records are still bounded; context carries a reference, never the full body.
    from .config import dumps
    if len(dumps(result).encode('utf-8')) > 131072:
        raise ValueError('Handoff output limit exceeded; return artifact references')
    write_json(H / 'handoffs' / handoff_name(task, node), result, durable=True)
    return result


def handoff_name(task, node, attempt=None):
    # The node id is the agent name for legacy nodes, so historical handoff paths are unchanged.
    return f'{task["id"]}-{node["id"]}-{node["attempts"] if attempt is None else attempt}.json'
