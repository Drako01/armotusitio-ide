"""One Git change detector for routing, context, reports and verification.

Rename detection is disabled (`--no-renames`): a moved file reports both its old and new path.
"""
import subprocess
from .config import ROOT, UsageError, root
from .security import valid_path


def git(*args):
    run = subprocess.run(['git', *args], cwd=root(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if run.returncode:
        raise ValueError('Git query failed: ' + ' '.join(args[:3]))
    if len(run.stdout) > 33554432:
        raise ValueError('Git output limit exceeded')
    return [s for s in run.stdout.decode('utf-8', errors='strict').split('\0') if s]


def check_ref(base, label='HARNESS_BASE'):
    """One validation for every base ref (HARNESS_BASE, --base): no option injection, NUL or newline."""
    if base and (base.startswith('-') or '\x00' in base or '\n' in base):
        raise UsageError('Invalid ' + label + ': a ref cannot start with "-" or contain control characters')
    return base


def branch():
    try:
        return git('symbolic-ref', '--short', '-q', 'HEAD')[0].strip()
    except (ValueError, IndexError, OSError):
        return None


def exists_ref(ref):
    try:
        git('rev-parse', '--verify', '--quiet', ref + '^{commit}')
        return True
    except (ValueError, OSError):
        return False


def existing_base(ref, label):
    """(ref, note): `ref` when it resolves; otherwise `origin/<ref>` when only the remote-tracking ref exists (noted explicitly,
    for clones that have no local `qa`); anything else is a usage error, not a verification failure."""
    check_ref(ref, label)
    if exists_ref(ref):
        return ref, ''
    remote = 'origin/' + ref
    if not ref.startswith(('refs/', 'origin/')) and exists_ref('refs/remotes/' + remote):
        return remote, f' (local ref {ref!r} does not exist; using {remote!r})'
    raise UsageError(f'{label}: the ref {ref!r} does not exist in this repository (in a clone with only origin/qa use --base origin/qa)')


def resolve_base(explicit=None):
    """(ref, source) the change set is measured against, or (None, 'local changes only').
    Precedence: --base > HARNESS_BASE > merge-base with origin/qa (when that ref exists and HEAD is not qa) > local only.
    An explicit ref that does not exist is a usage error; `qa` falls back to `origin/qa` with a notice in the source."""
    import os
    if explicit:
        ref, note = existing_base(explicit, '--base')
        return ref, '--base' + note
    env = os.environ.get('HARNESS_BASE')
    if env:
        ref, note = existing_base(env, 'HARNESS_BASE')
        return ref, 'HARNESS_BASE' + note
    try:
        git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/qa^{commit}')
        if branch() != 'qa':
            return git('merge-base', 'refs/remotes/origin/qa', 'HEAD')[0].strip(), 'merge-base with origin/qa'
    except (ValueError, IndexError, OSError):
        pass
    return None, 'local changes only'


def changed_files(base=None, allow_unversioned=False):
    import os
    from pathlib import Path
    base = os.environ.get('HARNESS_BASE') if base is None else base
    names = set()
    check_ref(base)
    try:
        workspace_root = Path(git('rev-parse', '--show-toplevel')[0].strip()).resolve()
    except ValueError:
        if allow_unversioned and not base:
            return []  # Explicit ephemeral/non-Git workspaces still run their declared domain gates.
        raise
    if workspace_root != root(ROOT).resolve():
        if allow_unversioned and not base:
            return []  # Never use parent-repository paths as this workspace's changes.
        raise ValueError('Git worktree root differs from Harness workspace; parent repository cannot supply changes')
    if base:
        git('rev-parse', '--verify', base + '^{commit}')
        names.update(git('diff', '--name-only', '--no-renames', '-z', base + '...HEAD', '--'))
    names.update(git('diff', '--name-only', '--no-renames', '-z', '--'))
    names.update(git('diff', '--cached', '--name-only', '--no-renames', '-z', '--'))
    names.update(git('ls-files', '--others', '--exclude-standard', '-z'))
    if any(not valid_path(p) for p in names):
        raise ValueError('Unsafe changed file path')
    return sorted(names)


def existed_at(path, base=None):
    """True when `path` is tracked in `base` (HEAD when there is no base). Used to tell a removed workspace from a placeholder."""
    check_ref(base)
    run = subprocess.run(['git', 'cat-file', '-e', (base or 'HEAD') + ':' + path], cwd=root(ROOT),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    return run.returncode == 0


def head():
    """Current HEAD commit, or None when the workspace has no commit/Git."""
    try:
        return git('rev-parse', 'HEAD')[0].strip()
    except (ValueError, IndexError, OSError):
        return None
