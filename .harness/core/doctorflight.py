"""Read-only preflight overview for Harness task planning."""
import hashlib
import json
import subprocess
from pathlib import Path

from .config import ROOT, H
from . import check, envcheck, preflight, tasks


def row(component, status, message, **extra):
    return {'component': component, 'status': status, 'message': message, **extra}


def git(*args, timeout=12):
    try:
        p = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        return p.stdout.strip() if p.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def doctor(domain=None, spec=None):
    results = check.doctor()
    lock = H / 'state/workspace.lock'
    try:
        from .state import alive
        data = json.loads(lock.read_text(encoding='utf-8')) if lock.exists() else {}
        busy = bool(isinstance(data.get('pid'), int) and alive(data['pid']))
        results.append(row('workspace-lock', 'FAIL' if busy else 'PASS',
                           'Existe un execute activo' if busy else 'No hay execute activo'))
    except (OSError, ValueError):
        results.append(row('workspace-lock', 'FAIL', 'No se pudo inspeccionar el lock'))
    baselines = list((H / 'runtime').glob('*-baseline.json'))
    results.append(row('pending-baselines', 'FAIL' if baselines else 'PASS',
                       f'{len(baselines)} baselines pendientes'))
    dirty = git('status', '--porcelain', '--untracked-files=all')
    if dirty is None:
        results.append(row('dirty-backup', 'FAIL', 'Git status no disponible'))
    else:
        hashes = {}
        for line in dirty.splitlines():
            relative = line[3:].split(' -> ')[-1]
            path = ROOT / relative
            if path.is_file() and not path.is_symlink():
                hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        # Hash manifest only: never duplicate untracked .env or other secrets.
        results.append(row('dirty-backup', 'PASS',
                           'Manifest de huellas SHA-256 (sin copiar contenido sensible)',
                           hashes=hashes))
    for item in ['AGENTS.md', 'CLAUDE.md', '.harness/README.md', '.harness/INSTRUCTIONS.md']:
        file = ROOT / item
        if file.is_file():
            crlf = b'\r\n' in file.read_bytes()
            results.append(row('line-endings:' + item, 'FAIL' if crlf else 'PASS',
                               'CRLF detectado' if crlf else 'LF confirmado'))
    remote = git('ls-remote', 'origin', 'refs/heads/qa', timeout=8)
    local = git('rev-parse', 'refs/remotes/origin/qa')
    remote_sha = remote.split()[0] if remote else None
    results.append(row('origin-qa', 'FAIL' if not remote_sha or remote_sha != local else 'PASS',
                       'origin/qa no actualizado o remoto inaccesible' if not remote_sha or remote_sha != local
                       else 'origin/qa está actualizado; no se realizó fetch'))
    migration = envcheck.migration_report(ROOT)
    results.append(row('migration-reservations', 'FAIL' if migration['collisions'] else
                       'WARN' if migration['openPrs'] is None else 'PASS',
                       'Numeración revisada', report=migration))
    if domain and spec is not None:
        try:
            previews = tasks.preview(domain, spec)
            results.append(row('plan', 'PASS', 'Plan estructural válido', units=len(previews)))
            questions = preflight.spec_questions(domain, spec, previews)
            checks = preflight.environment_checks(previews, False)
            blockers = envcheck.blocking_failures(checks)
            ready = not questions and not blockers
            results.append(row('preflight', 'PASS' if ready else 'FAIL',
                               'Diagnóstico del entorno y preguntas de especificación',
                               checks=checks, questions=questions))
            if ready:
                baseline = preflight.baseline_gates(domain, spec)
                failures = [x for x in baseline if x['status'] != 'PASS']
                results.append(row('baseline-gates', 'FAIL' if failures else 'PASS',
                                   'Gates autoritativos evaluados', gates=baseline))
        except Exception as error:
            results.append(row('plan', 'FAIL', type(error).__name__ + ': ' + str(error)[:250]))
    return results
