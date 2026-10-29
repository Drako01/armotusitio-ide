"""Optional Redis gate cache for the local machine: a shared, fast layer behind the file cache, never required.

The Harness always runs on the developer's PC, so a Redis container in the local compose stack (`redevent-local`) can hold
gate results across worktrees and shells. It speaks RESP directly over a socket (no dependency). Rules:
- It is only a `RemoteCache` layer: `LayeredCache` already treats every error as a cache miss, so Redis down means local cache.
- Only PASS entries are stored, each with a content digest verified on read, and keys are namespaced and expire (TTL).
- The container binds to 127.0.0.1 only; `harness:cache up` creates it when missing and reuses it when present.
"""
import hashlib
import json
import os
import socket
import subprocess
import time
from pathlib import Path
from .config import ROOT, UsageError
from .gatecache import GateCache, RemoteCache

PREFIX = 'redevent:gate:'
DEFAULT_URL = 'redis://127.0.0.1:56379'
COMPOSE = 'infra/docker/compose.api.yml'
CONNECT_TIMEOUT_S = 0.3
NEGATIVE_TTL_S = 30  # a Redis that is down is not probed again for this long (no per-gate connect penalty)
_DOWN_UNTIL = {'at': 0.0}


def endpoint(url=None):
    """(host, port) from HARNESS_REDIS_URL (redis://host:port); only loopback hosts are accepted."""
    raw = (url or os.environ.get('HARNESS_REDIS_URL') or DEFAULT_URL).strip()
    if not raw.startswith('redis://'):
        raise UsageError('HARNESS_REDIS_URL debe tener la forma redis://127.0.0.1:56379')
    host, _, port = raw[len('redis://'):].partition(':')
    if host not in ('127.0.0.1', 'localhost', '::1'):
        raise UsageError('La caché Redis del Harness solo acepta hosts locales (127.0.0.1)')
    return host, int(port or 6379)


def encode(*parts):
    out = [b'*' + str(len(parts)).encode() + b'\r\n']
    for part in parts:
        data = part if isinstance(part, bytes) else str(part).encode()
        out.append(b'$' + str(len(data)).encode() + b'\r\n' + data + b'\r\n')
    return b''.join(out)


def read_reply(stream):
    line = stream.readline()
    if not line:
        raise ConnectionError('Redis closed the connection')
    kind, rest = line[:1], line[1:].rstrip(b'\r\n')
    if kind == b'+':
        return rest.decode()
    if kind == b'-':
        raise RuntimeError(rest.decode())
    if kind == b':':
        return int(rest)
    if kind == b'$':
        size = int(rest)
        if size < 0:
            return None
        data = stream.read(size + 2)
        return data[:-2]
    if kind == b'*':
        return [read_reply(stream) for _ in range(int(rest))]
    raise ValueError('Unexpected Redis reply')


class RedisCache(RemoteCache):
    """PASS-only gate results in Redis with a per-entry TTL and a sha256 of the stored payload."""

    def __init__(self, host='127.0.0.1', port=56379, ttl=259200, timeout=CONNECT_TIMEOUT_S):
        self.host, self.port, self.ttl, self.timeout = host, port, int(ttl), timeout

    def call(self, *parts):
        with socket.create_connection((self.host, self.port), timeout=self.timeout) as conn:
            conn.settimeout(2.0)
            conn.sendall(encode(*parts))
            return read_reply(conn.makefile('rb'))

    def ping(self):
        try:
            return self.call('PING') == 'PONG'
        except Exception:
            return False

    def get(self, key):
        raw = self.call('GET', PREFIX + key)
        if raw is None:
            return None
        try:
            record = json.loads(raw)
            payload = json.dumps(record['entry'], sort_keys=True)
            if hashlib.sha256(payload.encode()).hexdigest() != record['sha256']:
                return None  # altered or truncated value: a miss, never a hit
            entry = record['entry']
        except (ValueError, KeyError, TypeError):
            return None
        return entry if isinstance(entry, dict) and entry.get('status') == 'PASS' else None

    def put(self, key, entry):
        if entry.get('status') != 'PASS':
            return False  # a failure is never reusable
        payload = json.dumps(entry, sort_keys=True)
        record = json.dumps({'entry': entry, 'sha256': hashlib.sha256(payload.encode()).hexdigest()})
        return self.call('SET', PREFIX + key, record, 'EX', self.ttl) == 'OK'

    def invalidate(self, key=None):
        if key is not None:
            return int(self.call('DEL', PREFIX + key))
        removed, cursor = 0, '0'
        while True:
            cursor, keys = self.call('SCAN', cursor, 'MATCH', PREFIX + '*', 'COUNT', 200)
            cursor = cursor.decode() if isinstance(cursor, bytes) else str(cursor)
            if keys:
                removed += int(self.call('DEL', *keys))
            if cursor == '0':
                return removed


def create():
    """Remote-cache factory (also usable through HARNESS_GATE_CACHE_REMOTE=core.rediscache). None when Redis is not up."""
    if os.environ.get('HARNESS_REDIS') == '0' or time.monotonic() < _DOWN_UNTIL['at']:
        return None
    try:
        host, port = endpoint()
        cache = RedisCache(host, port)
    except UsageError:
        return None
    if cache.ping():
        return cache
    _DOWN_UNTIL['at'] = time.monotonic() + NEGATIVE_TTL_S
    return None


def docker(*args, timeout=120):
    return subprocess.run(['docker', *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout)


def status():
    host, port = endpoint()
    cache = RedisCache(host, port)
    up = cache.ping()
    container = ''
    try:
        found = docker('ps', '--filter', 'name=redevent-local-redis', '--format', '{{.Names}} {{.Status}}', timeout=15)
        container = found.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        container = 'docker no disponible'
    return {'url': f'redis://{host}:{port}', 'reachable': up, 'container': container or 'no existe', 'compose': COMPOSE}


def up():
    """Creates the redis service of redevent-local when missing and reuses it when present (compose is idempotent)."""
    if not (ROOT / COMPOSE).is_file():
        raise UsageError('No existe ' + COMPOSE)
    result = docker('compose', '-f', COMPOSE, 'up', '-d', 'redis')
    if result.returncode:
        raise UsageError('docker compose up redis falló: ' + (result.stderr or result.stdout).strip()[-300:])
    for _ in range(20):
        if status()['reachable']:
            break
        time.sleep(0.5)
    _DOWN_UNTIL['at'] = 0.0
    return status()


def down():
    result = docker('compose', '-f', COMPOSE, 'rm', '-sf', 'redis')
    if result.returncode:
        raise UsageError('docker compose rm redis falló: ' + (result.stderr or result.stdout).strip()[-300:])
    return status()


def main(args):
    action = args[0] if args else 'status'
    if action not in ('up', 'status', 'down', 'clear'):
        raise UsageError('Uso: harness:cache [status|up|down|clear]')
    if action == 'clear':
        cache = create()
        result = {'cleared': cache.invalidate() if cache else 0, 'reachable': cache is not None}
    else:
        result = {'up': up, 'down': down, 'status': status}[action]()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0
