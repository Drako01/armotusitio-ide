"""Isolated Git worktrees, deterministic file integration with explicit conflicts, and abandoned-run recovery.

A delegated node of a parallel run never touches the main checkout while it works. It runs in a throw-away detached
worktree (HEAD plus a copy of the main checkout's uncommitted state) outside the repository, so snapshots of one node
cannot observe the writes of another. Only after the result is validated against the node's scope are the declared
files integrated into the main checkout, under one lock, and only when the main checkout still holds exactly the
content the worktree started from. A mismatch is an explicit conflict: nothing is merged, nothing is overwritten and
the worktree is preserved as evidence.
"""
import hashlib
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from .config import ROOT, H, read_json, write_json, now, workspace, digest

GIT_LOCK = threading.Lock()    # `git worktree add/remove` share .git metadata: never concurrent inside one process.
MAIN_LOCK = threading.RLock()  # Serializes integration and any gate that reads the integrated main checkout.
INTEGRATED = set()           # files applied to main since the scheduler last cleared it (even if the node's result is later discarded)
REGISTRY = 'runtime/worktrees'
JOURNALS = 'runtime/integration'
OPERATIONAL = re.compile(r'^\.harness/(tasks|state|handoffs|logs|runtime)/')


class IntegrationConflict(ValueError):
    def __init__(self, message, conflicts):
        super().__init__(message)
        self.conflicts = conflicts


def git(cwd, *args, check=True, timeout=120, text=False):
    run = subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.longpaths=true', *args], cwd=cwd, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, timeout=timeout)
    if check and run.returncode:
        raise ValueError('Git failed (' + ' '.join(args[:3]) + '): ' + run.stderr.decode('utf-8', 'replace').strip()[-300:])
    return run.stdout.decode('utf-8', 'replace') if text else run.stdout


def available():
    """Isolation needs a Git checkout with at least one commit; fixtures without Git fall back to sequential execution."""
    try:
        git(ROOT, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')
        return Path(git(ROOT, 'rev-parse', '--show-toplevel', text=True).strip()).resolve() == ROOT.resolve()
    except (ValueError, OSError, subprocess.SubprocessError):
        return False


def base_dir():
    configured = os.environ.get('HARNESS_WORKTREE_DIR')
    if configured:
        path = Path(configured)
        if not path.is_absolute():
            raise ValueError('HARNESS_WORKTREE_DIR must be an absolute path')
        return path / digest(str(ROOT.resolve()))[:8]
    return Path(tempfile.gettempdir()) / ('redevent-harness-wt-' + digest(str(ROOT.resolve()))[:8])


def content_fp(root, rel):
    """Content-level fingerprint (sha256 + executable bit, or symlink target); independent of umask and timestamps."""
    path = Path(root) / rel
    try:
        if path.is_symlink():
            return 'link:' + os.readlink(path)
        if path.is_dir():
            return 'dir'
        mode = path.lstat().st_mode
        return hashlib.sha256(path.read_bytes()).hexdigest() + (':x' if os.name != 'nt' and mode & 0o111 else '')
    except FileNotFoundError:
        return None


def head_fp(rel, head):
    """The same fingerprint for the committed blob, so a clean file needs no per-file bookkeeping."""
    listing = git(ROOT, 'ls-tree', '-z', head, '--', rel).decode('utf-8', 'replace')
    if not listing:
        return None
    mode = listing.partition(' ')[0]
    blob = git(ROOT, 'cat-file', 'blob', head + ':' + rel)
    if mode == '120000':
        return 'link:' + blob.decode('utf-8', 'replace')
    return hashlib.sha256(blob).hexdigest() + (':x' if mode == '100755' else '')


def process_identity(pid):
    """A value that changes when a pid is reused. None when the platform cannot tell (never kill on None)."""
    try:
        if sys.platform.startswith('linux'):
            return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
        if sys.platform == 'darwin':
            out = subprocess.run(['ps', '-o', 'lstart=', '-p', str(pid)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
            return out.stdout.decode().strip() or None
    except (OSError, IndexError, subprocess.SubprocessError):
        return None
    return None


def registry_file(name):
    return H / REGISTRY / (name + '.json')


def list_registry(task_id=None):
    directory = H / REGISTRY
    out = []
    if directory.is_dir():
        for file in sorted(directory.glob('*.json')):
            try:
                entry = read_json(file)
            except (ValueError, OSError):
                continue
            if task_id is None or entry.get('task') == task_id:
                out.append(entry)
    return out


class Worktree:
    def __init__(self, task_id, node_id, attempt, run_id):
        self.task, self.node, self.attempt, self.run_id = task_id, node_id, attempt, run_id
        self.name = f'{task_id}-{node_id}-{attempt}-{run_id[:6]}'
        # Short directory name (Windows MAX_PATH); the readable name lives in the registry, journals and patches.
        self.path = base_dir() / ('w' + digest(self.name)[:10])
        self.head, self.overlay, self.owned = None, {}, []
        self.state, self.created, self.extra = 'new', None, {}

    # -- lifecycle ---------------------------------------------------------------------------------------------
    def create(self, sources=()):
        self.head = git(ROOT, 'rev-parse', 'HEAD', text=True).strip()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with GIT_LOCK:
            git(ROOT, 'worktree', 'add', '--detach', '--quiet', str(self.path), self.head, timeout=300)
        self.state = 'active'
        try:
            self._overlay_dirty()
            self._stage(sources)
            self._record()
        except BaseException:
            self.discard()
            raise
        return self

    def _overlay_dirty(self):
        """Replicates uncommitted state of the main checkout so the node starts from what the operator really has."""
        names = set()
        for args in (('diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'), ('ls-files', '--others', '--exclude-standard', '-z')):
            names.update(n for n in git(ROOT, *args).decode('utf-8', 'replace').split('\0') if n)
        from .security import sensitive_path
        for rel in sorted(names):
            if OPERATIONAL.search(rel) or sensitive_path(rel):
                continue  # secrets never travel into a worktree an agent can read
            source, target = ROOT / rel, self.path / rel
            if source.is_symlink() or source.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.is_symlink() or target.exists():
                    target.unlink()
                if source.is_symlink():
                    try:
                        os.symlink(os.readlink(source), target)
                    except OSError as error:
                        raise ValueError(f'Cannot replicate symlink {rel} into the worktree ({error}); run with HARNESS_MAX_WORKERS=1') from error
                elif source.is_file():
                    shutil.copy2(source, target)
                self.overlay[rel] = content_fp(ROOT, rel)
            else:
                if target.is_symlink() or target.exists():
                    target.unlink()
                self.overlay[rel] = None

    def _stage(self, sources):
        """Read-only inputs the agent needs by relative path (task source, active task record). Owned by the Harness."""
        for rel in sources:
            source = ROOT / rel
            if source.is_file():
                target = self.path / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                self.owned.append(rel)

    def _record(self, **extra):
        self.created = self.created or now()
        entry = {'schemaVersion': 1, 'name': self.name, 'task': self.task, 'node': self.node, 'attempt': self.attempt,
                 'runId': self.run_id, 'path': str(self.path), 'head': self.head, 'overlay': self.overlay,
                 'state': self.state, 'pid': os.getpid(), 'host': socket.gethostname(), 'platform': sys.platform,
                 'createdAt': self.created, **self.extra, **extra}
        write_json(registry_file(self.name), entry, durable=True)

    def record_process(self, pid):
        self.extra = {**self.extra, 'agentPid': pid, 'agentIdentity': process_identity(pid)}
        self._record(updatedAt=now())

    def set_state(self, state, **extra):
        self.state = state
        self.extra = {**self.extra, **extra}
        self._record(updatedAt=now())

    def head_moved(self):
        """True when the agent committed or switched HEAD inside its worktree (delivery operations are never delegated)."""
        return git(self.path, 'rev-parse', 'HEAD', text=True).strip() != self.head

    def evidence(self, files):
        """Patch of what the node produced; written before the worktree can ever be removed."""
        if not files:
            return None
        git(self.path, 'add', '-A', '--', *files)
        patch = git(self.path, 'diff', '--cached', '--binary', '--no-renames', 'HEAD', '--', *files)
        target = H / JOURNALS / (self.name + '.patch')
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + '.' + os.urandom(3).hex() + '.tmp')
        tmp.write_bytes(patch)
        os.replace(tmp, target)
        return target.relative_to(ROOT).as_posix()

    def discard(self):
        """Removes the worktree directory. Evidence (patch, journal, handoffs) lives elsewhere and is never touched."""
        with GIT_LOCK:
            try:
                git(ROOT, 'worktree', 'remove', '--force', str(self.path), timeout=120)
            except (ValueError, OSError, subprocess.SubprocessError):
                shutil.rmtree(self.path, ignore_errors=True)
                git(ROOT, 'worktree', 'prune', check=False)
        registry_file(self.name).unlink(missing_ok=True)
        self.state = 'removed'

    # -- integration -------------------------------------------------------------------------------------------
    def base_of(self, rel):
        return self.overlay[rel] if rel in self.overlay else head_fp(rel, self.head)

    def integrate(self, files):
        """Applies `files` (repo-relative, already scope-validated) to the main checkout, all or nothing.

        A file whose main content differs from the worktree's starting point and from the produced content is a
        conflict. Conflicts are reported together, nothing is applied, nothing is overwritten.
        """
        started = time.monotonic()
        with MAIN_LOCK, workspace(ROOT):
            plan, conflicts = [], []
            for rel in sorted(files):
                new, current, base = content_fp(self.path, rel), content_fp(ROOT, rel), self.base_of(rel)
                if current == new:
                    plan.append({'file': rel, 'action': 'noop', 'base': base, 'new': new})
                elif current == base:
                    plan.append({'file': rel, 'action': 'apply', 'base': base, 'new': new})
                else:
                    conflicts.append({'file': rel, 'base': base, 'current': current, 'new': new})
            journal = H / JOURNALS / (self.name + '.json')
            record = {'schemaVersion': 1, 'task': self.task, 'node': self.node, 'attempt': self.attempt, 'runId': self.run_id,
                      'worktree': str(self.path), 'plan': plan, 'conflicts': conflicts, 'at': now()}
            if conflicts:
                write_json(journal, {**record, 'state': 'conflict'}, durable=True)
                raise IntegrationConflict('Integration conflict (nothing applied): ' + ', '.join(c['file'] for c in conflicts), conflicts)
            write_json(journal, {**record, 'state': 'applying'}, durable=True)
            INTEGRATED.update(i['file'] for i in plan if i['action'] == 'apply')
            for item in plan:
                if item['action'] == 'apply':
                    apply_file(self.path, item['file'], item['new'])
            duration = round((time.monotonic() - started) * 1000)
            write_json(journal, {**record, 'state': 'applied', 'durationMs': duration}, durable=True)
            INTEGRATED.update(i['file'] for i in plan if i['action'] == 'apply')
            return {'applied': [i['file'] for i in plan if i['action'] == 'apply'],
                    'unchanged': [i['file'] for i in plan if i['action'] == 'noop'], 'durationMs': duration}


def apply_file(source_root, rel, new):
    from .security import contained, valid_path
    target = ROOT / rel
    if not valid_path(rel) or not contained(rel):
        raise ValueError('Integration path rejected: ' + rel)
    if new is None:
        if target.is_symlink() or target.exists():
            target.unlink()
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    source = Path(source_root) / rel
    temporary = target.with_name('.' + target.name + '.harness-' + os.urandom(4).hex() + '.tmp')
    try:
        if source.is_symlink():
            os.symlink(os.readlink(source), temporary)
        else:
            shutil.copy2(source, temporary)
        os.replace(temporary, target)
    finally:
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()


# -- recovery ------------------------------------------------------------------------------------------------------

def kill_orphan(entry):
    """Terminates the agent process tree left behind by a dead scheduler, only if the pid is provably the same process."""
    pid, identity = entry.get('agentPid'), entry.get('agentIdentity')
    if not isinstance(pid, int) or pid <= 0 or not identity or entry.get('host') != socket.gethostname() or entry.get('platform') != sys.platform:
        return False
    if os.name == 'nt':
        return False  # kill-on-close Job Objects already ended the tree with its scheduler
    if process_identity(pid) != identity:
        return False
    import signal
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            return False
    return True


def resume_journals(task_id):
    """A scheduler that died while applying leaves an `applying` journal. If the main checkout still matches the plan the
    remaining files are applied; anything else is reported as inconsistent, never forced."""
    results = []
    directory = H / JOURNALS
    for file in sorted(directory.glob(task_id + '-*.json')) if directory.is_dir() else []:
        try:
            record = read_json(file)
        except (ValueError, OSError):
            continue
        if record.get('state') != 'applying' or record.get('task') != task_id:
            continue
        source, problems = Path(record['worktree']), []
        with MAIN_LOCK, workspace(ROOT):
            for item in record['plan']:
                rel, current = item['file'], content_fp(ROOT, item['file'])
                if current == item['new']:
                    continue
                if current == item['base'] and (item['new'] is None or (source / rel).exists() or (source / rel).is_symlink()):
                    apply_file(source, rel, item['new'])
                else:
                    problems.append(rel)
            write_json(file, {**record, 'state': 'inconsistent' if problems else 'applied', 'recoveredAt': now(), 'problems': problems}, durable=True)
        results.append({'node': record['node'], 'attempt': record['attempt'], 'problems': problems})
    return results


def recover(task_id):
    """Marks registered worktrees of a task that has no live owner as abandoned (kept as evidence) and returns them."""
    abandoned = []
    for entry in list_registry(task_id):
        if entry.get('state') in ('abandoned', 'removed'):
            continue
        killed = kill_orphan(entry)
        write_json(registry_file(entry['name']), {**entry, 'state': 'abandoned', 'abandonedAt': now(), 'orphanKilled': killed}, durable=True)
        abandoned.append({'name': entry['name'], 'node': entry['node'], 'attempt': entry['attempt'], 'orphanKilled': killed})
    return abandoned
