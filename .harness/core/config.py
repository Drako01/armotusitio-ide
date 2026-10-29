"""Central configuration, atomic persistence and the supported schema contract."""
import hashlib
import json
import math
import os
import re
import secrets
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path.cwd()
H = ROOT / '.harness'
_LOCAL = threading.local()


def root(default=None):
    """Workspace the current thread operates in: an isolated worktree for a delegated node, else `default` (the caller's
    module-level ROOT, so fixtures that patch it keep working) or the main checkout."""
    return getattr(_LOCAL, 'root', None) or default or ROOT


@contextmanager
def workspace(path):
    """Run the block (in this thread only) against another checkout; Harness state (`H`) always stays in the main one."""
    previous = getattr(_LOCAL, 'root', None)
    _LOCAL.root = Path(path)
    try:
        yield
    finally:
        _LOCAL.root = previous


def isolated():
    return bool(getattr(_LOCAL, 'isolated', False))


@contextmanager
def isolation(enabled=True):
    """Marks the current thread as a parallel worker: every delegated node runs in its own worktree."""
    previous = getattr(_LOCAL, 'isolated', False)
    _LOCAL.isolated = enabled
    try:
        yield
    finally:
        _LOCAL.isolated = previous


def local_hook(name, value=None, clear=False):
    """Thread-local callbacks (persist sink, cancel event) so shared lifecycle code needs no extra parameters."""
    if clear:
        _LOCAL.__dict__.pop(name, None)
    elif value is not None:
        setattr(_LOCAL, name, value)
    return getattr(_LOCAL, name, None)
READ_ONLY = ['reviewer', 'security-auditor']
DOWNSTREAM = READ_ONLY + ['verifier', 'logger']
NON_IMPLEMENTERS = ['context-manager'] + DOWNSTREAM
DETERMINISTIC = ['context-manager', 'verifier', 'logger']
FIXED = ['context-manager', 'architect', 'backend', 'backoffice', 'n8n', 'infra', 'tester',
         'reviewer', 'security-auditor', 'documentation', 'logger', 'verifier']
STATUSES = ['active', 'completed', 'failed']


def env_file_ignored():
    """HARNESS_IGNORE_ENV_FILE=1: tests and CI must not inherit the operator's .harness/.env."""
    return os.environ.get('HARNESS_IGNORE_ENV_FILE') == '1'


def read_json(file):
    return json.loads(Path(file).read_text(encoding='utf-8-sig'))


def jread(file):
    return read_json(H / file)


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def task_id():
    return datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S') + '-' + secrets.token_hex(3)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode('utf-8')).hexdigest()


def tokenize(value):
    # UTF-8 bytes / 3 is deliberately conservative, not provider billing.
    return math.ceil(len(str(value).encode('utf-8')) / 3)


def terms(value):
    return re.findall(r'[a-záéíóúñ0-9_-]+', str(value).lower())


def setting(name, default, minimum=1, maximum=86400000):
    raw = os.environ.get(name, str(default))
    if not re.fullmatch(r'\d+', raw) or not minimum <= int(raw) <= maximum:
        raise ValueError(f'{name} must be an integer {minimum}..{maximum}')
    return int(raw)


def policy():
    return jread('manifests/policies.json')


def gate_timeout_ms():
    return setting('HARNESS_GATE_TIMEOUT_MS', policy()['gateTimeoutMs'])


def agent_timeout_ms():
    return setting('HARNESS_AGENT_TIMEOUT_MS', policy()['agentTimeoutMs'], 0)


def max_retries():
    return setting('HARNESS_MAX_RETRIES', policy()['maxRetries'], 0, 10)


def max_workers():
    """Active delegated workers. 1 keeps the historical strictly sequential behavior (conservative default: 2)."""
    return setting('HARNESS_MAX_WORKERS', policy().get('parallel', {}).get('maxWorkers', 2), 1, 16)


def auto_workers():
    """True when the operator did not pin HARNESS_MAX_WORKERS: the worker count is then derived from the task plan."""
    return 'HARNESS_MAX_WORKERS' not in os.environ


def recommended_workers(width):
    """Minimum workers that still saturate the plan: its parallel width, never above policies.json parallel.autoMaxWorkers."""
    cap = policy().get('parallel', {}).get('autoMaxWorkers', 8)
    return max(1, min(int(width or 1), cap, 16))


def worker_rationale(plan, workers):
    """One short sentence explaining the recommendation (shown by plan, preflight and progress)."""
    if not plan or not plan.get('parallel'):
        return '1 worker: sin unidades independientes demostrables, no se reparte por repartir'
    estimate = plan.get('estimate', {})
    return (f"{workers} workers: ancho del plan {plan.get('width', 1)}, speedup estimado {estimate.get('speedup', 1.0)}x; "
            f"tope automático {policy().get('parallel', {}).get('autoMaxWorkers', 8)}")


def effective_limits(width=None):
    """(workers, source, role_default, role_overrides, host). Explicit HARNESS_* variables always win; without
    HARNESS_MAX_WORKERS the plan width sizes the pool and the unset role/host limits are raised to match it."""
    role_default, roles = role_limits()
    if width is None or not auto_workers():
        return max_workers(), ('env' if not auto_workers() else 'default'), role_default, roles, host_limit()
    workers = recommended_workers(width)
    if 'HARNESS_ROLE_LIMITS' not in os.environ:
        role_default = workers
    host = host_limit() if 'HARNESS_HOST_LIMIT' in os.environ else workers
    return workers, 'auto', role_default, roles, host


def parallel_limit(name, default, minimum=1, maximum=16):
    return setting(name, policy().get('parallel', {}).get(default, default), minimum, maximum)


def role_limits():
    """`HARNESS_ROLE_LIMITS=backend=2,tester=1`: independent per-role caps (default: policies.json parallel.roleLimit)."""
    default = policy().get('parallel', {}).get('roleLimit', 2)
    limits = {}
    for item in filter(None, os.environ.get('HARNESS_ROLE_LIMITS', '').split(',')):
        name, _, value = item.partition('=')
        if not re.fullmatch(r'[a-z0-9_-]+', name.strip()) or not re.fullmatch(r'\d+', value.strip()) or not 1 <= int(value) <= 16:
            raise ValueError('HARNESS_ROLE_LIMITS must look like role=N,role=N with N in 1..16')
        limits[name.strip()] = int(value)
    return default, limits


def host_limit():
    return setting('HARNESS_HOST_LIMIT', policy().get('parallel', {}).get('hostLimit', 2), 1, 16)


def budget(*values):
    return min(setting('HARNESS_CONTEXT_BUDGET', policy()['contextBudget']),
               setting('HARNESS_TASK_BUDGET', policy()['contextBudget']),
               *[v for v in values if v is not None])


def write_json(file, value, durable=False):
    from .security import redact_value
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + '.' + secrets.token_hex(6) + '.tmp')
    try:
        with temporary.open('w', encoding='utf-8') as stream:
            stream.write(json.dumps(redact_value(value), ensure_ascii=False, indent=2) + '\n')
            if durable:
                stream.flush()
                os.fsync(stream.fileno())  # durable before the atomic rename: a crash never exposes a torn record
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def validate_schema(value, schema, at='$'):
    supported = {'type', 'enum', 'const', 'required', 'properties', 'additionalProperties',
                 'items', 'minLength', 'minimum'}
    annotations = {'$schema', '$id', 'title', 'description'}
    errors = [f'{at}: unsupported schema keyword {key}' for key in schema if key not in supported | annotations]
    kind = ('null' if value is None else 'boolean' if isinstance(value, bool) else
            'integer' if isinstance(value, int) else 'number' if isinstance(value, float) else
            'string' if isinstance(value, str) else 'array' if isinstance(value, list) else 'object')
    def equal(a, b):
        if isinstance(a, bool) != isinstance(b, bool):
            return False
        if isinstance(a, dict) and isinstance(b, dict):
            return a.keys() == b.keys() and all(equal(a[k], b[k]) for k in a)
        if isinstance(a, list) and isinstance(b, list):
            return len(a) == len(b) and all(equal(x, y) for x, y in zip(a, b))
        return a == b
    if 'const' in schema and not equal(value, schema['const']):
        errors.append(f'{at}: expected {schema["const"]}')
    if 'enum' in schema and not any(equal(value, v) for v in schema['enum']):
        errors.append(f'{at}: not in enum {schema["enum"]}')
    allowed = schema.get('type', [])
    allowed = [allowed] if isinstance(allowed, str) else allowed
    if allowed and kind not in allowed and not (kind == 'integer' and 'number' in allowed):
        return errors + [f'{at}: expected {"|".join(allowed)}, got {kind}']
    if isinstance(value, str) and len(value) < schema.get('minLength', 0):
        errors.append(f'{at}: shorter than {schema["minLength"]}')
    if kind in ['integer', 'number'] and value < schema.get('minimum', float('-inf')):
        errors.append(f'{at}: below {schema["minimum"]}')
    if isinstance(value, list) and 'items' in schema:
        for i, item in enumerate(value):
            errors += validate_schema(item, schema['items'], f'{at}[{i}]')
    if isinstance(value, dict):
        errors += [f'{at}: missing {key}' for key in schema.get('required', []) if key not in value]
        for key, sub in schema.get('properties', {}).items():
            if key in value:
                errors += validate_schema(value[key], sub, f'{at}.{key}')
        if schema.get('additionalProperties') is False:
            errors += [f'{at}: unexpected {key}' for key in value if key not in schema.get('properties', {})]
    return errors


class UsageError(ValueError):
    """CLI usage mistake (unknown option, missing argument): exits 2, distinct from a real FAIL (1)."""
