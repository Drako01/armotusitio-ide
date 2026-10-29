"""Scope snapshots including ignored secrets, plus persistent restoration latches."""
import hashlib
import hmac
import json
import os
import re
import sys
import time
from pathlib import Path
from .config import ROOT, H, read_json, write_json, READ_ONLY, now, policy, root
from .changes import git
from .security import allowed_path, matches_path, PROTECTED, LOCK

ARTIFACTS = {'.next', '.turbo', 'dist', 'build', 'coverage', '.cache', '.artifacts', '__pycache__'}
SKIP = {'.git', 'node_modules'}
MANAGED_ROOT = '.harness/runtime/python'
# Ephemeral, git-ignored artifacts the Harness itself writes when an agent runs its gates.
EPHEMERAL = re.compile(r'^\.harness/state/(telemetry/events\.jsonl(\.1)?|lessons-observed\.json)(\.[0-9a-f]+\.tmp)?$|^\.harness/runtime/(context-index\.json|verify-last\.json(\.[0-9a-f]+\.tmp)?|output/.+|change-refs/[^/]+\.json|progress/[^/]+\.json(\.[0-9a-f]+\.tmp)?|worktrees/[^/]+\.json(\.[0-9a-f]+\.tmp)?|integration/[^/]+\.(json|patch)(\.[0-9a-f]+\.tmp)?|runs/[^/]+\.json(\.[0-9a-f]+\.tmp)?)$|^\.claude/scheduled_tasks\.lock$|^apps/api/tmp/air/.+$')


def build_info_patterns():
    """`*.tsbuildinfo` entries of policies.json `generatedArtifacts`: rewritten by every TypeScript gate run."""
    return [p for p in policy().get('generatedArtifacts', []) if p.endswith('.tsbuildinfo')]


def regenerated(file, ignored, patterns):
    """Only git-ignored build info is exempt; tracked generated files (next-env.d.ts) remain agent writes."""
    return file in ignored and any(matches_path(file, pattern) for pattern in patterns)


class Snapshot(dict):
    def __init__(self, *args, ignored=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.ignored = set(ignored or [])


def walk(directory, names, skip=None):
    skip = SKIP if skip is None else skip
    base = root(ROOT) / directory
    if not base.exists():
        return
    for file in base.iterdir():
        relative = file.relative_to(root(ROOT)).as_posix()
        if file.name in skip:
            continue
        if file.is_dir() and not file.is_symlink():
            walk(relative, names, skip)
        else:
            names.add(relative)


def fingerprint(file):
    absolute = root(ROOT) / file
    try:
        stat = absolute.lstat()
        if absolute.is_symlink():
            return 'link:' + os.readlink(absolute)
        hasher = hashlib.sha256()
        with absolute.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                hasher.update(chunk)
        return str(stat.st_mode) + ':' + hasher.hexdigest()
    except FileNotFoundError:
        return None
    except OSError as error:
        return 'unreadable:' + str(error.errno)


def snapshot():
    started = time.monotonic() if os.environ.get('HARNESS_SNAPSHOT_PROFILE') == '1' else None
    names, ignored = set(), set()
    try:
        names.update(git('ls-files', '-z', '--cached', '--others', '--exclude-standard'))
        for entry in git('ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'):
            if not entry.endswith('/'):
                ignored.add(entry)
            elif not any(part in SKIP | ARTIFACTS for part in entry.split('/')):
                walk(entry.rstrip('/'), ignored, SKIP | ARTIFACTS)
        walk('.harness', names, SKIP | {'__pycache__'})
    except ValueError:
        # Isolated fixtures without Git retain full-tree security coverage.
        walk('', names, SKIP | {'__pycache__'})
    patterns = build_info_patterns()
    ignored = {f for f in ignored if not regenerated(f, ignored, patterns)}
    result = Snapshot(ignored=ignored)
    for file in sorted(names | ignored):
        # These internal transient files are excluded from scope comparisons; hashing
        # them adds I/O without improving write-guard coverage.
        if '/__pycache__/' in file or EPHEMERAL.search(file.casefold() if os.name == 'nt' else file):
            continue
        value = fingerprint(file)
        if value is not None:
            result[file] = value
    if started is not None:
        elapsed_ms = round((time.monotonic() - started) * 1000, 1)
        print(f'[harness:snapshot] files={len(result)} duration_ms={elapsed_ms}', file=sys.stderr)
    return result


def serialize_snapshot(value):
    return json.dumps({'files': list(value.items()), 'ignored': sorted(value.ignored)})


def parse_snapshot(text):
    value = json.loads(text)
    if not isinstance(value.get('files'), list) or not isinstance(value.get('ignored'), list):
        raise ValueError('Malformed snapshot')
    return Snapshot(value['files'], ignored=value['ignored'])


class ScopeError(ValueError):
    def __init__(self, message, files):
        super().__init__(message)
        self.scope_files = files


def compare_snapshots(before, after, domain, contract, ignored=None):
    patterns, gitignored = build_info_patterns(), before.ignored | after.ignored
    files = sorted(f for f in before.keys() | after.keys() if before.get(f) != after.get(f) and f not in (ignored or [])
                   and not EPHEMERAL.search(f.casefold() if os.name == 'nt' else f)
                   and not regenerated(f, gitignored, patterns))
    violations = []
    for file in files:
        canonical = file.casefold() if os.name == 'nt' else file
        if contract['name'] in READ_ONLY:
            violations.append('Read-only agent changed ' + file)
        elif PROTECTED.search(canonical):
            violations.append('Agent changed protected operational state: ' + file)
        elif not allowed_path(file, domain, contract):
            violations.append('Actual write outside allowed scope: ' + file)
    if violations:
        raise ScopeError('; '.join(violations), files)
    return files


def salt(create=False):
    file = H / 'runtime/fingerprint.salt'
    if file.exists():
        return file.read_bytes()
    if not create:
        return None
    file.parent.mkdir(parents=True, exist_ok=True)
    value = os.urandom(32)
    with file.open('xb') as stream:
        stream.write(value)
    return value


def seal(key, value):
    return 'hmac:' + hmac.new(key, value.encode('utf-8'), hashlib.sha256).hexdigest()


def record_scope_violation(task, node, before, files, reason, contained=False):
    from .state import persist_task, log
    key = salt(True)
    # A violation inside an isolated worktree never reached the main checkout: nothing to restore, evidence is kept.
    task['scopeViolation'] = {'agent': node['agent'], 'attempt': node['attempts'], 'reason': reason, 'at': now(),
                             'protectedState': False if contained else any(PROTECTED.search(f.casefold() if os.name == 'nt' else f) for f in files),
                             'restoration': [] if contained else [{'file': f, 'fingerprint': seal(key, before[f]) if f in before and f in before.ignored else before.get(f)} for f in files]}
    if contained:
        task['scopeViolation'].update({'node': node['id'], 'contained': True, 'files': sorted(files)})
    node['status'] = 'failed'
    persist_task(task)
    log('audit', task['id'], 'scope-violation', task['scopeViolation'])


def verify_scope_restoration(task):
    violation = task.get('scopeViolation')
    if not violation:
        return
    prefix = 'Unresolved scope violation in ' + task['id'] + ': '
    if violation['protectedState']:
        raise ValueError(prefix + 'protected operational state requires manual audit; use a new task after repair')
    current, key = snapshot(), salt()
    unrestored = []
    for entry in violation['restoration']:
        fingerprint_value, value = entry['fingerprint'], current.get(entry['file'])
        if fingerprint_value and fingerprint_value.startswith('hmac:'):
            match = value is not None and key is not None and hmac.compare_digest(seal(key, value), fingerprint_value)
        else:
            match = value == fingerprint_value
        if not match:
            unrestored.append(entry['file'])
    if unrestored:
        raise ValueError(prefix + 'restore pre-attempt content/mode or absence for ' + ', '.join(unrestored))


def clear_restored_scope(task):
    from .state import log
    if task.get('scopeViolation'):
        verify_scope_restoration(task)
        log('audit', task['id'], 'scope-restored', {'violation': task['scopeViolation']})
        del task['scopeViolation']


def baseline_file(task, node):
    return H / 'runtime' / f'{task["id"]}-{node["id"]}-{node["attempts"]}-baseline.json'


def verify_interrupted(task):
    from .context import manifests, get_domain
    from .state import handoff
    for node in task['dag']:
        if node['status'] != 'running' or node.get('isolation'):
            continue  # isolated nodes never touched the main checkout; worktree.recover() owns their evidence
        file = baseline_file(task, node)
        if not file.exists():
            # Legacy deterministic nodes have no child writes; non-deterministic missing baseline fails closed.
            from .config import DETERMINISTIC
            if node['agent'] not in DETERMINISTIC and node['attempts'] > 0:
                # Legacy tasks created before persisted baselines retain explicit compatibility, never a scope latch bypass.
                if task.get('runtimeVersion') == 2:
                    raise ValueError('Interrupted agent baseline missing; inspect workspace before new task')
            continue
        saved = json.loads(file.read_text(encoding='utf-8'))
        owned = saved.get('owned', [file.relative_to(ROOT).as_posix()])
        expected_result = f'.harness/runtime/{task["id"]}-{node["id"]}-{node["attempts"]}-result.json'
        if any(name != file.relative_to(ROOT).as_posix() and name != expected_result and not __import__('re').fullmatch(__import__('re').escape('.harness/runtime/output/' + file.stem + '-') + r'[a-f0-9]{12}\.log', name) for name in owned):
            raise ValueError('Interrupted baseline contains invalid owned artifact references')
        before, after = parse_snapshot(json.dumps(saved)), snapshot()
        for entry in [before, after]:
            for name in list(entry):
                if LOCK.search(name):
                    del entry[name]
        contract = next((a for a in manifests()['agents'] if a['name'] == node['agent']), task.get('temporaryAgent'))
        try:
            compare_snapshots(before, after, get_domain(task['domain']), contract, owned)
        except ScopeError as error:
            reason = 'Interrupted attempt: ' + str(error)
            record_scope_violation(task, node, before, error.scope_files, reason)
            handoff(task, node, 'failed', {'risks': [reason]})
            file.unlink()  # Persisted restoration latch is now the authoritative pre-attempt evidence.
            return
        file.unlink()
