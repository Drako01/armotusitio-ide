"""Process-wide admission control for delegated runs: total workers plus independent per-role and per-host limits.

Every delegated node in a parallel context holds one slot while its agent runs. The scheduler asks without blocking
(`try_acquire`) so a node that cannot start simply waits in the queue; legacy sequential children running in worker
threads block (`slot`) until capacity is free. Capacity can be lowered at runtime (`throttle`) when a host reports
quota or availability problems, which is the backpressure path.
"""
import os
import threading
from contextlib import contextmanager
from .config import effective_limits


def host_name():
    if os.environ.get('HARNESS_AGENT_COMMAND'):
        return 'custom'
    return os.environ.get('HARNESS_HOST', '').lower() or 'none'


class Budget:
    def __init__(self):
        self.condition = threading.Condition()
        self.total = None  # configured lazily so importing this module never reads (or rejects) the environment

    def _ensure(self):
        if self.total is None:
            self.configure()

    def configure(self, workers=None, width=None):
        """`width` (plan parallel width) sizes the pool when HARNESS_MAX_WORKERS is not pinned; `workers` overrides everything."""
        total, source, role_default, roles, host = effective_limits(width)
        with self.condition:
            self.total = workers or total
            self.source = 'explicit' if workers else source
            self.configured = self.total
            self.role_default, self.roles = role_default, roles
            self.host = host
            self.used_total, self.used_roles, self.used_hosts = 0, {}, {}
            self.peak = 0
            self.condition.notify_all()

    def _fits(self, role, host):
        return (self.used_total < self.total and self.used_roles.get(role, 0) < self.roles.get(role, self.role_default)
                and self.used_hosts.get(host, 0) < self.host)

    def try_acquire(self, role, host):
        self._ensure()
        with self.condition:
            if not self._fits(role, host):
                return False
            self._take(role, host)
            return True

    def _take(self, role, host):
        self.used_total += 1
        self.used_roles[role] = self.used_roles.get(role, 0) + 1
        self.used_hosts[host] = self.used_hosts.get(host, 0) + 1
        self.peak = max(self.peak, self.used_total)

    def release(self, role, host):
        with self.condition:
            self.used_total -= 1
            self.used_roles[role] -= 1
            self.used_hosts[host] -= 1
            self.condition.notify_all()

    @contextmanager
    def slot(self, role, host):
        self._ensure()
        with self.condition:
            while not self._fits(role, host):
                self.condition.wait(0.5)
            self._take(role, host)
        try:
            yield
        finally:
            self.release(role, host)

    def throttle(self):
        self._ensure()
        """Backpressure: one worker less (never below 1) after a host-side availability or timeout failure."""
        with self.condition:
            if self.total > 1:
                self.total -= 1
                return True
            return False

    def snapshot(self):
        self._ensure()
        with self.condition:
            return {'workers': self.total, 'configured': self.configured, 'source': self.source, 'active': self.used_total, 'peak': self.peak,
                    'roles': dict(self.used_roles), 'hosts': dict(self.used_hosts)}


BUDGET = Budget()
