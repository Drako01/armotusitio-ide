"""Content-addressed cache of PASSED gates, plus the single flaky retry and the quarantine hook.

Only a PASS is ever stored or reused (a failure, a skip or a not-run result is never cached). The key is a sha256 over
everything that can change a gate's outcome: the command, a content digest of the files that gate reads (not just the
changed ones, independent of HEAD), tool versions, an env allowlist, the Harness configuration and a schema version.
A check whose inputs cannot be enumerated (`impact.gate_inputs` returns None) simply has no key and always runs.
Every cache operation is best effort: it never raises and never turns a run into a failure.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from . import config, impact
from .security import matches_path

SCHEMA = 1
FILE = 'state/gate-cache.json'
DEFAULTS = {'enabled': True, 'ttlSeconds': 259200, 'maxEntries': 500, 'envAllowlist': ['CI', 'NODE_ENV', 'GOFLAGS', 'GOOS', 'GOARCH', 'CGO_ENABLED']}
SKIP_DIRS = {'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache', '__pycache__', '.artifacts'}
MAX_FILES = 20000
LOCK_STALE_S, LOCK_WAIT_S = 30, 5
_MUTEX = threading.Lock()
_VERSIONS = {}
TOOLS = {'pnpm': ['node', 'pnpm'], 'node': ['node'], 'go': ['go'], 'gofmt': ['go'], 'bash': [], 'docker': []}


def settings():
    """policies.json `gateCache` over the defaults; HARNESS_GATE_CACHE=0 disables it for one run."""
    value = {**DEFAULTS, **(config.policy().get('gateCache') or {})}
    if os.environ.get('HARNESS_GATE_CACHE', '') == '0':
        value['enabled'] = False
    return value


def telemetry(kind, **fields):
    """Optional: the telemetry module may not exist; recording never raises and never affects the gate."""
    try:
        from . import telemetry as module
        module.record(kind, **fields)
    except Exception:  # ImportError, or a recorder bug: observability must never break verification
        pass


def tool_version(name):
    """`<tool> --version` first line, cached per process; None when the tool is missing or does not answer."""
    with _MUTEX:
        if name in _VERSIONS:
            return _VERSIONS[name]
    found = shutil.which(name)
    version = None
    if found:
        try:
            run = subprocess.run([found, '--version'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
            text = run.stdout.decode('utf-8', errors='replace').strip().splitlines()
            version = text[0][:120] if run.returncode == 0 and text else None
        except (OSError, subprocess.SubprocessError):
            version = None
    with _MUTEX:
        _VERSIONS[name] = version
    return version


def config_digest():
    """Digest of policies.json and every manifest: a policy or manifest change invalidates every key."""
    digest = hashlib.sha256()
    directory = config.H / 'manifests'
    try:
        for file in sorted(directory.glob('*.json')):
            digest.update(file.name.encode() + b'\0' + file.read_bytes() + b'\0')
    except OSError:
        return None
    return digest.hexdigest()


def digest_paths(paths, root=None):
    """sha256 over the (relative path, content) of every file under `paths`; None when it cannot be done reliably."""
    root = Path(root or config.ROOT)
    skip = list(config.policy().get('generatedArtifacts', []))
    digest, count = hashlib.sha256(), 0
    files = []
    for entry in sorted(set(paths)):
        target = root / entry
        if target.is_symlink():
            return None
        if target.is_file():
            files.append(entry)
        elif target.is_dir():
            for current, dirs, names in os.walk(target):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not (Path(current) / d).is_symlink())
                for name in sorted(names):
                    relative = (Path(current) / name).relative_to(root).as_posix()
                    if not any(matches_path(relative, p) for p in skip) and not (Path(current) / name).is_symlink():
                        files.append(relative)
                if len(files) > MAX_FILES:
                    return None
    for relative in sorted(set(files)):
        count += 1
        try:
            file_hash = hashlib.sha256()
            with (root / relative).open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    file_hash.update(chunk)
            content = file_hash.hexdigest()
        except OSError:
            return None
        digest.update(relative.encode() + b'\0' + content.encode() + b'\0')
    return digest.hexdigest()


def cache_key(item, root=None):
    """The key for a check, or None when it is not cacheable (unknown inputs, unknown tool version, unreadable config)."""
    command = list(item['command'])
    inputs = impact.gate_inputs(command)
    if inputs is None:
        return None
    content, configuration = digest_paths(inputs, root), config_digest()
    wanted = TOOLS.get(command[0], [command[0]]) if command else []
    versions = {name: tool_version(name) for name in wanted}
    if content is None or configuration is None or any(v is None for v in versions.values()):
        return None
    allow = settings()['envAllowlist']
    parts = {'schema': SCHEMA, 'command': command, 'inputs': content, 'config': configuration, 'tools': versions,
             'python': tool_python(), 'env': {k: os.environ.get(k, '') for k in sorted(allow)}}
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()


def tool_python():
    import platform
    return platform.python_version()


class GateCache:
    """Interface. `get` returns the stored entry or None; `put` stores a PASS entry; `invalidate(None)` clears everything."""
    def get(self, key):
        raise NotImplementedError

    def put(self, key, entry):
        raise NotImplementedError

    def invalidate(self, key=None):
        raise NotImplementedError


class FileLock:
    """Cross-process advisory lock: exclusive create of a lock file, stale locks are broken after LOCK_STALE_S."""
    def __init__(self, path):
        self.path = Path(path)

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + LOCK_WAIT_S
        while True:
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                return self
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > LOCK_STALE_S:
                        self.path.unlink()
                        continue
                except OSError:
                    continue
                if time.monotonic() > deadline:
                    raise TimeoutError('gate cache lock busy')
                time.sleep(0.02)

    def __exit__(self, *exc):
        try:
            self.path.unlink()
        except OSError:
            pass


class LocalCache(GateCache):
    """state/gate-cache.json: {'schemaVersion', 'entries': {key: {...}}}, bounded by maxEntries and ttlSeconds, written atomically."""
    def __init__(self, path=None, ttl=None, limit=None):
        self.path = Path(path) if path else config.H / FILE
        self.ttl = ttl if ttl is not None else settings()['ttlSeconds']
        self.limit = limit if limit is not None else settings()['maxEntries']

    def load(self):
        try:
            value = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return {}
        entries = value.get('entries') if isinstance(value, dict) and value.get('schemaVersion') == SCHEMA else None
        return entries if isinstance(entries, dict) else {}

    def save(self, entries):
        temporary = self.path.with_name(self.path.name + '.' + os.urandom(4).hex() + '.tmp')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            temporary.write_text(json.dumps({'schemaVersion': SCHEMA, 'entries': entries}, sort_keys=True), encoding='utf-8')
            os.replace(temporary, self.path)  # atomic on POSIX and Windows
        finally:
            if temporary.exists():
                temporary.unlink()

    def fresh(self, entry):
        return isinstance(entry, dict) and entry.get('status') == 'PASS' and time.time() - float(entry.get('at', 0)) <= self.ttl

    def get(self, key):
        try:
            entry = self.load().get(key)
            return entry if self.fresh(entry) else None
        except Exception:
            return None

    def put(self, key, entry):
        if entry.get('status') != 'PASS':
            return False  # a failure is never reusable
        try:
            with _MUTEX, FileLock(self.path.with_name(self.path.name + '.lock')):
                entries = {k: v for k, v in self.load().items() if self.fresh(v)}
                entries[key] = {**entry, 'at': time.time()}
                for old in sorted(entries, key=lambda k: entries[k]['at'])[:max(len(entries) - self.limit, 0)]:
                    del entries[old]
                self.save(entries)
            return True
        except Exception:
            return False

    def invalidate(self, key=None):
        try:
            with _MUTEX, FileLock(self.path.with_name(self.path.name + '.lock')):
                entries = self.load()
                removed = len(entries) if key is None else int(entries.pop(key, None) is not None)
                self.save({} if key is None else entries)
                return removed
        except Exception:
            return 0


class RemoteCache(GateCache):
    """Abstract extension point for a shared cache (CI, object store). Disabled by default and NEVER required: it is
    only used when HARNESS_GATE_CACHE_REMOTE names an importable module exposing `create() -> RemoteCache`. Any error
    from a remote is swallowed, so a remote outage can only cost a cache miss. Entries must still be PASS-only."""
    def get(self, key):
        raise NotImplementedError

    def put(self, key, entry):
        raise NotImplementedError

    def invalidate(self, key=None):
        raise NotImplementedError


def load_remote():
    name = os.environ.get('HARNESS_GATE_CACHE_REMOTE', '').strip()
    if not name:
        try:
            from . import rediscache  # the local Redis container, when it is up; otherwise the file cache alone
            return rediscache.create()
        except Exception:
            return None
    try:
        import importlib
        remote = importlib.import_module(name).create()
        return remote if isinstance(remote, GateCache) else None
    except Exception:
        return None


class LayeredCache(GateCache):
    """Local first, optional remote behind it (read-through, write-through); remote failures are ignored."""
    def __init__(self, local, remote=None):
        self.local, self.remote = local, remote

    def get(self, key):
        entry = self.local.get(key)
        if entry or self.remote is None:
            return entry
        try:
            entry = self.remote.get(key)
        except Exception:
            return None
        if isinstance(entry, dict) and entry.get('status') == 'PASS':
            self.local.put(key, entry)
            return entry
        return None

    def put(self, key, entry):
        stored = self.local.put(key, entry)
        if self.remote is not None:
            try:
                self.remote.put(key, entry)
            except Exception:
                pass
        return stored

    def invalidate(self, key=None):
        removed = self.local.invalidate(key)
        if self.remote is not None:
            try:
                self.remote.invalidate(key)
            except Exception:
                pass
        return removed


def default_cache():
    """The cache a run uses, or None when disabled (policy gateCache.enabled=false or HARNESS_GATE_CACHE=0)."""
    return LayeredCache(LocalCache(), load_remote()) if settings()['enabled'] else None


def flaky_patterns():
    found = []
    for pattern in config.policy().get('flakyPatterns', []) or []:
        try:
            found.append(re.compile(pattern))
        except re.error:
            continue
    return found


def known_flaky(output):
    return any(p.search(output) for p in flaky_patterns())


def output_of(result):
    return str(result.get('stdoutTail', '')) + '\n' + str(result.get('stderrTail', ''))


def quarantine(result, item, retried_passed=False):
    """Annotates a FAIL with the sibling `flaky` analysis when that module exists. Fails closed: any doubt keeps it a failure."""
    try:
        from . import flaky
        analysis = flaky.analyze_gate_output(output_of(result), retried_passed=retried_passed)
        if not isinstance(analysis, dict):
            return result
        result['flaky'] = analysis
        if analysis.get('all_quarantined') and not analysis.get('blocking'):
            try:  # blocking already folds criticality in; re-check each failure so a registry/pattern gap cannot hide a critical test
                critical = any(flaky.is_critical(test) for test in analysis.get('failures') or [])
            except Exception:
                critical = True
            if not critical:
                result['quarantined'] = True
    except Exception:  # ImportError or any analyzer bug: the failure stays a failure
        pass
    return result


def execute(item, execute_check, cache=None):
    """Runs one check through `execute_check()` (a zero-argument callable returning a result) adding cache + flaky retry.
    The cache is consulted only for checks that have a key; a PASS is stored only if the inputs did not change meanwhile."""
    began = time.monotonic()
    key = cache_key(item) if cache is not None else None
    if key is not None:
        hit = cache.get(key)
        if hit:
            saved = int(hit.get('durationMs') or 0)
            telemetry('cache', hit=True, key=key[:12], command=' '.join(item['command'])[:120], savedMs=saved)
            return {'command': list(item['command']), 'tier': item['tier'], 'reason': item['reason'], 'requires': item.get('requires', []),
                    'status': 'PASS', 'exit': 0, 'durationMs': 0, 'log': None, 'skipReason': None, 'stdoutTail': '', 'stderrTail': '',
                    'cached': True, 'savedMs': saved}
        telemetry('cache', hit=False, key=key[:12], command=' '.join(item['command'])[:120], savedMs=0)
    result = execute_check()
    retried = False
    if result['status'] == 'FAIL' and known_flaky(output_of(result)):
        retried = True
        again = execute_check()
        again['retried'] = True
        if again['status'] == 'PASS':
            again['flakyRetry'] = True
        result = again
    if result['status'] == 'FAIL':
        quarantine(result, item, retried_passed=False)
    elif result['status'] == 'PASS' and key is not None and not retried and cache_key(item) == key:
        cache.put(key, {'status': 'PASS', 'durationMs': int(result.get('durationMs') or round((time.monotonic() - began) * 1000)), 'command': list(item['command'])})
    return result
