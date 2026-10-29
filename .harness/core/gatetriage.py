"""Classify a failed authoritative gate against a disposable clean HEAD checkout."""
import json
import subprocess
import tempfile
from pathlib import Path

from .config import ROOT, H, gate_timeout_ms, read_json, workspace
from .state import log
from .verification import execute_check
from .gatecache import known_flaky
from .worktree import GIT_LOCK


def triage_failed_gate(task, node):
    """Return preexisting/new/unknown. Unknown never suppresses normal correction."""
    if node.get('agent') != 'verifier':
        return 'unknown'
    file = H / 'handoffs' / f'{task["id"]}-{node["id"]}-{node["attempts"]}.json'
    try:
        record = read_json(file)
        failed = []
        for value in record.get('verification', []):
            item = json.loads(value) if isinstance(value, str) else value
            if isinstance(item, dict) and item.get('status') == 'FAIL' and isinstance(item.get('command'), list):
                failed.append(item)
        if not failed:
            return 'unknown'
    except (OSError, ValueError, TypeError):
        return 'unknown'
    with tempfile.TemporaryDirectory(prefix='redevent-gate-baseline-') as directory:
        path = Path(directory) / 'checkout'
        try:
            with GIT_LOCK:
                added = subprocess.run(['git', 'worktree', 'add', '--detach', str(path), 'HEAD'],
                                       cwd=ROOT, capture_output=True, timeout=30)
            if added.returncode:
                return 'unknown'
            try:
                with workspace(path):
                    for failure in failed:
                        item = {'command': failure['command'], 'tier': 'authoritative',
                                'reason': 'clean HEAD triage'}
                        result = execute_check(item, gate_timeout_ms())
                        combined = (result.get('stdoutTail') or '') + (result.get('stderrTail') or '')
                        if result.get('status') == 'FAIL' and known_flaky(combined):
                            result = execute_check(item, gate_timeout_ms())
                            combined = (result.get('stdoutTail') or '') + (result.get('stderrTail') or '')
                        if result.get('status') == 'FAIL':
                            # Missing dependencies in disposable worktrees are inconclusive, not preexisting failures.
                            import re
                            if re.search(r'module not found|cannot find module|command not found|dependencies? missing|node_modules|ENOTFOUND', combined, re.I):
                                return 'unknown'
                            log('audit', task['id'], 'gate-preexisting',
                                {'node': node['id'], 'command': failure['command'],
                                 'baselineLog': result.get('log')})
                            return 'preexisting'
                        if result.get('status') != 'PASS':
                            return 'unknown'
                return 'new'
            finally:
                with GIT_LOCK:
                    subprocess.run(['git', 'worktree', 'remove', '--force', str(path)],
                                   cwd=ROOT, capture_output=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            return 'unknown'
