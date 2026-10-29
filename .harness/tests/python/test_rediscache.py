"""Redis gate cache against an in-process fake RESP server: no Docker, no network beyond loopback."""
import json
import socket
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from core import gatecache, rediscache  # noqa: E402
from core.config import UsageError  # noqa: E402

PASS = {'status': 'PASS', 'command': ['x'], 'stdoutTail': 'ok'}


def dead_port():
    """A loopback port with no listener, identical on Windows and Linux (closing a listening socket is not)."""
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class FakeRedis:
    """Just enough of RESP: PING, GET, SET key value EX n, DEL, SCAN."""

    def __init__(self):
        self.data, self.ttl, self.server = {}, {}, socket.socket()
        self.server.bind(('127.0.0.1', 0))
        self.server.listen(8)
        self.port = self.server.getsockname()[1]
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def serve(self, conn):
        with conn, conn.makefile('rwb') as stream:
            try:
                command = rediscache.read_reply(stream)
            except Exception:
                return
            name, args = command[0].decode().upper(), [a.decode() for a in command[1:]]
            if name == 'PING':
                stream.write(b'+PONG\r\n')
            elif name == 'SET':
                self.data[args[0]], self.ttl[args[0]] = args[1], args[3]
                stream.write(b'+OK\r\n')
            elif name == 'GET':
                value = self.data.get(args[0])
                stream.write(b'$-1\r\n' if value is None else b'$' + str(len(value.encode())).encode() + b'\r\n' + value.encode() + b'\r\n')
            elif name == 'DEL':
                stream.write(b':' + str(sum(self.data.pop(k, None) is not None for k in args)).encode() + b'\r\n')
            elif name == 'SCAN':
                keys = [k for k in self.data if k.startswith(args[2][:-1])]
                stream.write(b'*2\r\n$1\r\n0\r\n*' + str(len(keys)).encode() + b'\r\n'
                             + b''.join(b'$' + str(len(k)).encode() + b'\r\n' + k.encode() + b'\r\n' for k in keys))
            stream.flush()

    def close(self):
        # shutdown wakes the thread blocked in accept(): on Linux close() alone keeps the port listening
        try:
            self.server.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.server.close()


class MemoryLayer(gatecache.GateCache):
    def __init__(self):
        self.d = {}

    def get(self, key):
        return self.d.get(key)

    def put(self, key, entry):
        self.d[key] = entry
        return True

    def invalidate(self, key=None):
        return 0


class RedisCacheTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeRedis()
        self.cache = rediscache.RedisCache('127.0.0.1', self.fake.port, ttl=60)
        rediscache._DOWN_UNTIL['at'] = 0.0

    def tearDown(self):
        self.fake.close()

    def test_roundtrip_namespace_and_ttl(self):
        self.assertTrue(self.cache.put('k1', PASS))
        self.assertEqual(self.cache.get('k1'), PASS)
        self.assertIn(rediscache.PREFIX + 'k1', self.fake.data)
        self.assertEqual(self.fake.ttl[rediscache.PREFIX + 'k1'], '60')

    def test_failures_are_never_stored(self):
        self.assertFalse(self.cache.put('bad', {'status': 'FAIL'}))
        self.assertIsNone(self.cache.get('bad'))

    def test_tampered_value_is_a_miss(self):
        self.cache.put('k', PASS)
        record = json.loads(self.fake.data[rediscache.PREFIX + 'k'])
        record['entry']['stdoutTail'] = 'forged'
        self.fake.data[rediscache.PREFIX + 'k'] = json.dumps(record)
        self.assertIsNone(self.cache.get('k'))
        self.fake.data[rediscache.PREFIX + 'k'] = 'not json'
        self.assertIsNone(self.cache.get('k'))

    def test_invalidate_one_and_all(self):
        self.cache.put('a', PASS)
        self.cache.put('b', PASS)
        self.assertEqual(self.cache.invalidate('a'), 1)
        self.assertEqual(self.cache.invalidate(), 1)
        self.assertEqual(self.fake.data, {})

    def test_create_when_up_and_when_down(self):
        url = {'HARNESS_REDIS_URL': f'redis://127.0.0.1:{self.fake.port}', 'HARNESS_REDIS': ''}  # independent of an exported opt-out
        with patch.dict('os.environ', url):
            self.assertIsInstance(rediscache.create(), rediscache.RedisCache)
        rediscache._DOWN_UNTIL['at'] = 0.0
        with patch.dict('os.environ', {'HARNESS_REDIS_URL': f'redis://127.0.0.1:{dead_port()}', 'HARNESS_REDIS': ''}):
            self.assertIsNone(rediscache.create())
            self.assertGreater(rediscache._DOWN_UNTIL['at'], 0)  # negative cache: no connect penalty on the next gate

    def test_only_loopback_hosts_and_opt_out(self):
        with self.assertRaises(UsageError):
            rediscache.endpoint('redis://10.0.0.5:6379')
        with self.assertRaises(UsageError):
            rediscache.endpoint('http://127.0.0.1:6379')
        with patch.dict('os.environ', {'HARNESS_REDIS': '0'}):
            self.assertIsNone(rediscache.create())

    def test_layered_cache_survives_redis_dying(self):
        local = MemoryLayer()
        layered = gatecache.LayeredCache(local, self.cache)
        layered.put('k', PASS)
        self.assertEqual(self.cache.get('k'), PASS)
        self.fake.close()
        self.assertEqual(layered.get('k'), PASS)  # served by the local layer; the dead remote is ignored
        self.assertTrue(layered.put('k2', PASS))

    def test_remote_hit_populates_local(self):
        self.cache.put('shared', PASS)
        local = MemoryLayer()
        self.assertEqual(gatecache.LayeredCache(local, self.cache).get('shared'), PASS)
        self.assertEqual(local.d['shared'], PASS)

    def test_default_remote_uses_redis_only_when_no_explicit_module(self):
        with patch.dict('os.environ', {'HARNESS_GATE_CACHE_REMOTE': ''}), patch.object(rediscache, 'create', return_value='REDIS'):
            self.assertEqual(gatecache.load_remote(), 'REDIS')


if __name__ == '__main__':
    unittest.main()
