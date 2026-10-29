"""Regression coverage for content-addressed cache input streaming."""
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from core import gatecache


class GateCacheStreamingTests(unittest.TestCase):
    def test_cache_digest_matches_previous_format_for_large_file(self):
        with tempfile.TemporaryDirectory() as temp:
            relative = "large.bin"
            data = b"redevent" * 280000
            (Path(temp) / relative).write_bytes(data)
            expected = hashlib.sha256(
                relative.encode() + bytes([0]) + hashlib.sha256(data).hexdigest().encode() + bytes([0])
            ).hexdigest()
            with patch.object(gatecache.config, "policy", return_value={}):
                self.assertEqual(gatecache.digest_paths([relative], root=temp), expected)

    def test_changed_file_invalidates_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "data.txt"
            with patch.object(gatecache.config, "policy", return_value={}):
                path.write_text("A")
                before = gatecache.digest_paths(["data.txt"], root=temp)
                path.write_text("B")
                after = gatecache.digest_paths(["data.txt"], root=temp)
            self.assertNotEqual(before, after)

    def test_unenumerated_input_keeps_existing_digest_behavior(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(gatecache.config, "policy", return_value={}):
                self.assertEqual(
                    gatecache.digest_paths(["missing.txt"], root=temp),
                    hashlib.sha256().hexdigest(),
                )

if __name__ == "__main__":
    unittest.main()
