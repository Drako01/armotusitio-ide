"""Provider quota/authentication failures must not trigger costly corrective loops."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from core.scheduler import Scheduler


class RetryProviderFailureTests(unittest.TestCase):
    def test_provider_failure_blocks_without_reopening_implementers(self):
        for category in ("host-quota", "host-authentication", "host-unavailable"):
            with self.subTest(category=category):
                node = {"id": "review", "agent": "reviewer", "status": "failed",
                        "attempts": 1, "failureCategory": category}
                scheduler = Scheduler.__new__(Scheduler)
                scheduler.retries = 2
                scheduler.task = {"id": "test-task", "dag": [node]}
                scheduler.metrics = {"retries": 0, "throttled": 0}
                with patch("core.scheduler.log") as audit, patch("core.scheduler.BUDGET.throttle", return_value=False):
                    scheduler.after(node)
                self.assertEqual(node["status"], "blocked")
                self.assertEqual(scheduler.metrics["retries"], 0)
                audit.assert_called_once()
                self.assertEqual(audit.call_args.args[2], "retry-blocked-host")

    def test_failed_implementer_with_provider_failure_stays_blocked(self):
        node = {"id": "backend", "agent": "backend", "status": "failed",
                "attempts": 1, "failureCategory": "host-quota"}
        scheduler = Scheduler.__new__(Scheduler)
        scheduler.retries = 2
        scheduler.task = {"id": "test-task", "dag": [node]}
        scheduler.metrics = {"retries": 0, "throttled": 0}
        with patch("core.scheduler.log"):
            scheduler.after(node)
        self.assertEqual(node["status"], "blocked")
        self.assertEqual(scheduler.metrics["retries"], 0)

    def test_normal_failure_still_retries(self):
        node = {"id": "backend", "agent": "backend", "status": "failed",
                "attempts": 1, "failureCategory": "agent-result"}
        scheduler = Scheduler.__new__(Scheduler)
        scheduler.retries = 2
        scheduler.task = {"id": "test-task", "dag": [node]}
        scheduler.metrics = {"retries": 0, "throttled": 0}
        with patch("core.scheduler.log"):
            scheduler.after(node)
        self.assertEqual(node["status"], "pending")
        self.assertEqual(scheduler.metrics["retries"], 1)


if __name__ == "__main__":
    unittest.main()
