"""Fail-closed paths, secrets and command policy shared by every entry point."""
import json
import os
import re
from pathlib import Path
from .config import ROOT, H, policy, root

PATH_RULE = "Paths use POSIX repository-relative globs: * matches one root filename (including dotfiles), never '/'; ** matches descendants. No absolute paths, '..', or symlink escapes. Domain paths intersect allowedPaths; excludes and forbiddenPaths always win."
PROTECTED = re.compile(r'^\.harness/(tasks|state|handoffs|logs)/')
LOCK = re.compile(r'^\.harness/state/[^/]+\.lock$')


def valid_path(file):
    return isinstance(file, str) and bool(file) and not any(c in file for c in '\\:\x00\r\n') and not file.startswith('/') and all(p not in ['', '.', '..'] and not (os.name == 'nt' and (p.endswith(('.', ' ')) or re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', p, re.I))) for p in file.split('/'))


def matches_path(file, pattern):
    if not valid_path(file):
        return False
    if os.name == 'nt':
        file, pattern = file.casefold(), pattern.casefold()
    expression = '.*'.join('[^/]*'.join(re.escape(p) for p in part.split('*')) for part in pattern.split('**'))
    return re.fullmatch(expression, file) is not None


def contained(file):
    if not valid_path(file):
        return False
    base = root(ROOT)
    absolute = base / file
    # Reject symlinks anywhere in the path, including dangling links and ancestors.
    current = absolute
    while current != base:
        if current.is_symlink() or getattr(current, 'is_junction', lambda: False)():
            return False
        try:
            if os.name == 'nt' and current.lstat().st_file_attributes & 0x400:
                return False
        except FileNotFoundError:
            pass
        current = current.parent
    try:
        absolute.resolve().relative_to(base.resolve())
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def sensitive_path(file):
    file = file.casefold() if os.name == 'nt' else file
    if file.endswith('.env.example'):
        return False
    return any(matches_path(file, p) for p in policy()['sensitivePaths'])


def allowed_path(file, domain, agent):
    if not agent or agent.get('name') in ['reviewer', 'security-auditor']:
        return False
    if PROTECTED.search(file.casefold() if os.name == 'nt' else file) or sensitive_path(file):
        return False
    owned = agent.get('ownedPaths')
    if owned and not any(matches_path(file, p) for p in owned):
        return False  # a planned node writes only inside the paths it exclusively owns
    return contained(file) and any(matches_path(file, p) for p in domain['paths']) and any(matches_path(file, p) for p in agent['allowedPaths']) and not any(matches_path(file, p) for p in domain['exclude'] + agent['forbiddenPaths'])


def read_source(ref):
    from .config import digest
    if not re.fullmatch(r'\.harness/tasks/sources/[a-zA-Z0-9_-]+\.txt', ref['path']) or not contained(ref['path']):
        raise ValueError('Invalid source path / Source symlink rejected')
    text = (ROOT / ref['path']).read_bytes().decode('utf-8')
    if digest(text) != ref['sha256']:
        raise ValueError('Source integrity mismatch')
    return text


def redact(text, environment=None):
    text = str(text)
    text = re.sub(r'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----.*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)', '[REDACTED PRIVATE KEY]', text, flags=re.S)
    text = re.sub(r'\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b', '[REDACTED]', text)
    text = re.sub(r'(?i)(\b[a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@', r'\1[REDACTED]@', text)
    text = re.sub(r'(?im)(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)(\b[\w.-]*(?:token|password|passwd|secret|api[_-]?key|credential)[\w.-]*\s*[=:]\s*)(?:"[^"\r\n]*"|\x27[^\x27\r\n]*\x27|[^\s,;\r\n]+)', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)("[^"\r\n]*(?:password|passwd|secret|api[_-]?key|credential|authorization|cookie|token)[^"\r\n]*"\s*:\s*)"(?:\\.|[^"\\])*"', r'\1"[REDACTED]"', text)
    # Exact environment values catch custom variable names and .env output too.
    for name, value in (environment if environment is not None else os.environ).items():
        if re.search(r'token|password|passwd|secret|api.?key|credential|dsn|database_url', name, re.I) and len(value) >= 4:
            text = text.replace(value, '[REDACTED]')
    return text


def redact_value(value):
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_value(v) for v in value]
    if isinstance(value, dict):
        return {k: '[REDACTED]' if re.search(r'password|passwd|secret|api[_-]?key|credential|authorization|cookie|(?:^|_)token(?:$|_)', k, re.I) else redact_value(v) for k, v in value.items()}
    return value


def command_policy(cmd, args, trusted=False):
    if not isinstance(cmd, str) or not cmd or any(not isinstance(a, str) or '\x00' in a for a in args):
        raise ValueError('security denial: invalid subprocess arguments')
    base = Path(cmd).name.lower().removesuffix('.exe').removesuffix('.cmd')
    denied = [word.lower() for word in policy()['deniedCommands']]
    if base in denied or any(a.lower() in denied for a in args):
        raise ValueError('security denial: destructive command')
    if any(re.search(r'(?i)(?<![\w.-])' + re.escape(word) + r'(?:\s|$|["\x27])', ' '.join(args)) for word in policy()['deniedCommands']):
        raise ValueError('security denial: destructive command embedded in arguments')
    if base == 'git' and any(a in ['reset', 'clean', 'checkout', 'switch', 'push', 'commit', 'merge', 'rebase', 'restore'] for a in args):
        raise ValueError('security denial: git mutation requires explicit delivery authorization')
    if trusted:
        return  # Only fixed manifest checks and adapter specs cross this internal boundary.
    if base not in policy()['runnerExecutables']:
        raise ValueError('security denial: executable outside command allowlist')
    text = ' '.join([cmd] + args)
    if re.search(r'[&|;<>`\r\n]|\$\(|\b(?:sudo|eval|exec)\b', text):
        raise ValueError('security denial: shell operator / command chaining')
    if base in ['node', 'python', 'python3', 'bash'] and any(re.match(r'^(?:-[A-Za-z]*[ecp]|--(?:eval|print)(?:=|$)|-(?:Command|EncodedCommand))', a, re.I) for a in args):
        raise ValueError('security denial: inline interpreter code')
    if base == 'git' and any(a in ['reset', 'clean', 'checkout', 'switch', 'push', 'commit', 'merge', 'rebase', 'restore'] for a in args):
        raise ValueError('security denial: git mutation requires explicit delivery authorization')


def orchestrator_guard(input_value):
    if not isinstance(input_value, dict) or not isinstance(input_value.get('tool_input'), dict):
        return False
    data = input_value['tool_input']
    target = data.get('file_path') or data.get('notebook_path')
    if not target:
        return False
    # Delegation identity is the existing explicit Harness contract; post-run scope remains mandatory.
    root = Path(os.environ.get('CLAUDE_PROJECT_DIR', ROOT)).resolve()
    absolute = (root / target).absolute()
    resolved = absolute.resolve()
    if not absolute.is_relative_to(root) and not resolved.is_relative_to(root):
        return True  # Actual external scratch paths preserve the existing hook contract.
    current = absolute
    while current != root and current != current.parent:
        if current.is_symlink() or getattr(current, 'is_junction', lambda: False)():
            return False
        try:
            if os.name == 'nt' and current.lstat().st_file_attributes & 0x400:
                return False
        except FileNotFoundError:
            pass
        current = current.parent
    try:
        relative = resolved.relative_to(root).as_posix()
    except ValueError:
        return False  # A lexical repository path cannot escape the guard through a link.
    # The hook governs the host only. Delegated agents operate under their own
    # scope snapshot and worktree contract; blocking them here deadlocks execution.
    if os.environ.get('HARNESS_AGENT'):
        return True
    # Protect workspace writes while an execution is live or an interrupted baseline awaits reconciliation.
    # This applies even when the host explicitly opts into writes; delegated agents remain
    # constrained by their own scope/snapshot enforcement.
    if not relative.startswith('.harness/runtime/output/'):
        workspace_lock = root / '.harness/state/workspace.lock'
        try:
            lock = json.loads(workspace_lock.read_text(encoding='utf-8')) if workspace_lock.exists() else {}
            pid = lock.get('pid')
            if isinstance(pid, int) and pid > 0:
                from .state import alive
                if alive(pid):
                    return False
        except (OSError, ValueError, TypeError):
            return False  # Unreadable lock fails closed.
        if list((root / '.harness/runtime').glob('*-baseline.json')):
            return False
    if os.environ.get('HARNESS_ALLOW_HOST_WRITES') == '1':
        return True
    operational = any(relative.startswith('.harness/' + name + '/') for name in ['tasks', 'state', 'handoffs', 'logs', 'runtime'])
    return operational and not relative.startswith('.harness/runtime/python/') and resolved.is_relative_to(root / '.harness')
