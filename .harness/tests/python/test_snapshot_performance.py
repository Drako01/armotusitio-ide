"""Regression tests for streaming scope fingerprints and opt-in timing."""
import hashlib
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from core import snapshot as module


class SnapshotFingerprintPerformanceTests(unittest.TestCase):
    def test_streaming_fingerprint_matches_original_sha256_format(self):
        with tempfile.TemporaryDirectory() as temp:
            location = Path(temp)
            data = b"redevent-scope-guard" * 100000
            (location / "sample.bin").write_bytes(data)
            with patch.object(module, "ROOT", location):
                observed = module.fingerprint("sample.bin")
            expected = str((location / "sample.bin").stat().st_mode) + ":" + hashlib.sha256(data).hexdigest()
            self.assertEqual(observed, expected)

    def test_modified_content_with_same_length_changes_fingerprint(self):
        with tempfile.TemporaryDirectory() as temp:
            location = Path(temp)
            file = location / "sample.bin"
            with patch.object(module, "ROOT", location):
                file.write_bytes(b"AAAA")
                before = module.fingerprint("sample.bin")
                file.write_bytes(b"BBBB")
                after = module.fingerprint("sample.bin")
            self.assertNotEqual(before, after)

    def test_exempt_transient_artifacts_are_not_hashed(self):
        transient = ".harness/runtime/verify-last.json"
        tracked = "apps/api/main.go"
        with patch.object(module, "git", side_effect=[[transient, tracked], []]), \
             patch.object(module, "walk"), \
             patch.object(module, "build_info_patterns", return_value=[]), \
             patch.object(module, "fingerprint", return_value="hash") as fingerprint:
            observed = module.snapshot()
        self.assertNotIn(transient, observed)
        self.assertIn(tracked, observed)
        fingerprint.assert_called_once_with(tracked)

    def test_profile_off_produces_no_diagnostics(self):
        with patch.dict(os.environ, {"HARNESS_SNAPSHOT_PROFILE": "0"}), \
             patch.object(module, "git", return_value=[]), \
             patch.object(module, "walk"), \
             patch.object(module, "build_info_patterns", return_value=[]):
            output = io.StringIO()
            with redirect_stderr(output):
                module.snapshot()
            self.assertEqual(output.getvalue(), "")

    def test_profile_on_emits_aggregate_metrics_only(self):
        with patch.dict(os.environ, {"HARNESS_SNAPSHOT_PROFILE": "1"}), \
             patch.object(module, "git", return_value=[]), \
             patch.object(module, "walk"), \
             patch.object(module, "build_info_patterns", return_value=[]):
            output = io.StringIO()
            with redirect_stderr(output):
                module.snapshot()
            self.assertIn("files=0 duration_ms=", output.getvalue())
            self.assertNotIn("sample.bin", output.getvalue())


if __name__ == "__main__":
    unittest.main()
