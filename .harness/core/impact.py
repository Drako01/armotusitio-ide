"""Dependency-graph impact analysis: changed paths -> targeted verification checks. Stdlib only, no network."""
import json
import os
import re
from pathlib import PurePosixPath
from . import config
from .security import contained, matches_path

SCRIPT_ORDER = ['lint', 'typecheck', 'test', 'test:critical', 'build']
DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies']
GLOBAL_JS = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', '.npmrc', 'tsconfig*.json']
CONFIG_PACKAGES = ['packages/typescript-config', 'packages/eslint-config']
AGENT_PATHS = ['AGENTS.md', 'CLAUDE.md', '.claude/**', '.codex/**', '.agents/**', 'scripts/check-agent-config-sync.mjs', '.gitignore']
DEFAULT_WORKSPACE_GLOBS = ['apps/*', 'packages/*']
PNPM = ['pnpm', 'node_modules']
COVERED_BY = 'verify-enterprise.sh'
ENTERPRISE_WORKSPACE_BASES = ('apps', 'packages')  # the directories verify-enterprise.sh walks; tooling/* is not one of them
GO_ROOT = 'apps/api'
GO_LIST = ['-C', GO_ROOT, 'list', '-deps', '-test', '-json=ImportPath,Dir,Deps,DepOnly,ForTest']


def check(command, tier, reason, requires=None, **extra):
    return {'command': command, 'tier': tier, 'reason': reason, 'requires': requires or [], **extra}


def exists(file):
    return contained(file) and (config.ROOT / file).is_file()


def read_package(directory):
    file = directory + '/package.json'
    if not exists(file):
        return None
    try:
        value = json.loads((config.ROOT / file).read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) and isinstance(value.get('name'), str) else None


def workspace_globs():
    """`packages:` globs of pnpm-workspace.yaml (negations dropped); apps/* and packages/* when the file is absent."""
    file = config.ROOT / 'pnpm-workspace.yaml'
    if not file.is_file() or file.is_symlink():
        return list(DEFAULT_WORKSPACE_GLOBS)
    globs, inside = [], False
    for line in file.read_text(encoding='utf-8-sig').splitlines():
        stripped = line.split(' #')[0].strip()
        if not stripped or stripped.startswith('#'):
            continue
        if not line[:1].isspace() and not stripped.startswith('-'):
            inside = stripped == 'packages:'
            continue
        if inside and stripped.startswith('- '):
            value = stripped[2:].strip().strip('"\'').rstrip('/')
            if value and not value.startswith('!'):
                globs.append(value)
    return globs or list(DEFAULT_WORKSPACE_GLOBS)


def workspace_bases():
    """Parent directories of the single-level `<base>/*` workspace globs (the only form this engine understands)."""
    return [g[:-2] for g in workspace_globs() if g.endswith('/*') and '*' not in g[:-2] and valid_base(g[:-2])]


def valid_base(base):
    return bool(base) and all(part not in ['', '.', '..'] for part in base.split('/')) and not base.startswith('/') and '\\' not in base


def js_workspaces():
    """Workspaces discovered from the pnpm-workspace.yaml globs, e.g. apps/*/package.json (apps/api excluded)."""
    found = {}
    for base in workspace_bases():
        directory = config.ROOT / base
        if not directory.is_dir() or directory.is_symlink():
            continue
        with os.scandir(directory) as entries:
            for entry in sorted(entries, key=lambda e: e.name):
                relative = base + '/' + entry.name
                if relative == GO_ROOT or not entry.is_dir(follow_symlinks=False):
                    continue
                package = read_package(relative)
                if package:
                    scripts = package.get('scripts') if isinstance(package.get('scripts'), dict) else {}
                    deps = {name for section in DEP_SECTIONS if isinstance(package.get(section), dict) for name in package[section]}
                    found[relative] = {'dir': relative, 'name': package['name'], 'scripts': scripts, 'deps': deps}
    return found


def dependents_closure(workspaces, seeds):
    """seeds: {dir: reason}. Adds reverse-dependency closure; returns {dir: reason}."""
    by_name = {w['name']: d for d, w in workspaces.items()}
    affected = dict(seeds)
    queue = list(seeds)
    while queue:
        current = queue.pop(0)
        for directory, workspace in workspaces.items():
            if directory not in affected and workspaces[current]['name'] in workspace['deps'] and workspaces[current]['name'] in by_name:
                affected[directory] = f'depends on {workspaces[current]["name"]} ({affected[current]})'
                queue.append(directory)
    return affected


def topological(workspaces, selected):
    order, pending = [], sorted(selected)
    while pending:
        ready = [d for d in pending if not any(workspaces[o]['name'] in workspaces[d]['deps'] for o in pending if o != d)]
        ready = ready or pending  # cycles keep deterministic name order
        order.append(ready[0])
        pending.remove(ready[0])
    return order


def had_package(workspace, base=None):
    """Whether `<workspace>/package.json` existed in the base (HEAD without one); False where Git cannot answer."""
    from .changes import existed_at
    try:
        return existed_at(workspace + '/package.json', base)
    except (ValueError, OSError):
        return False


def js_checks(files, base=None):
    workspaces = js_workspaces()
    seeds, everything = {}, None
    for file in files:
        if any(matches_path(file, p) for p in GLOBAL_JS):
            everything = everything or f'{file} changed (root workspace configuration)'
            continue
        owner = next((d for d in sorted(workspaces, key=len, reverse=True) if file.startswith(d + '/')), None)
        if owner:
            seeds.setdefault(owner, f'{file} changed')
            continue
        shared = next((p for p in CONFIG_PACKAGES if file.startswith(p + '/')), None)
        if shared:
            # A shared config without its own package.json cannot be traced to consumers: fail wide.
            everything = everything or f'{file} changed (shared config; consumers cannot be determined)'
            continue
        glob_base = next((b for b in workspace_bases() if file.startswith(b + '/') and file.count('/') > b.count('/') + 1), None)
        workspace = '/'.join(file.split('/')[:glob_base.count('/') + 2]) if glob_base else None
        if workspace and workspace != GO_ROOT and workspace not in workspaces:
            # Not a workspace now. It only widens the selection when it used to be one: its package.json is the changed
            # file, or existed in the base. A README under a placeholder directory without an app selects nothing.
            if file == workspace + '/package.json':
                reason = ('removed with its workspace directory' if not (config.ROOT / workspace).exists()
                          else 'is a workspace package.json that no longer exists or is invalid')
            elif had_package(workspace, base):
                reason = ('removed with its workspace directory' if not (config.ROOT / workspace).exists()
                          else 'is under a workspace whose package.json no longer exists or is invalid')
            else:
                continue
            everything = everything or f'{file} {reason} (dependents unknown)'
    if everything:
        affected = {d: everything for d in workspaces}
    else:
        affected = dependents_closure(workspaces, seeds)
    checks = []
    for directory in topological(workspaces, affected):
        scripts, previous = workspaces[directory]['scripts'], None
        for name in SCRIPT_ORDER:
            command = scripts.get(name)
            if not isinstance(command, str) or (name == 'test:critical' and command == scripts.get('test')):
                continue
            covered = {'coveredBy': COVERED_BY} if directory.split('/')[0] in ENTERPRISE_WORKSPACE_BASES else {}
            checks.append(check(['pnpm', '--filter', './' + directory, name], 'targeted',
                                f'{workspaces[directory]["name"]}: {affected[directory]}', PNPM, **covered))
    return checks


def parse_go_list(text):
    decoder, packages, index = json.JSONDecoder(), [], 0
    while True:
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            return packages
        value, index = decoder.raw_decode(text, index)
        packages.append(value)


def base_import(path):
    path = re.sub(r' \[.*\]$', '', path)
    return path[:-5] if path.endswith('.test') else path[:-5] if path.endswith('_test') else path


def go_list_json():
    """Raw `go list` JSON. The environment is inherited exactly as the later `go test` check sees it (toolchain
    switching included). GOPROXY=off is only a default: the graph is computed offline from the module cache and, when
    that is not enough, `go_checks` falls back to ./... declaring why. Output is parsed in memory, never redacted."""
    from .runner import spawn_run
    env = {k: v for k, v in {'GOPROXY': 'off'}.items() if k not in os.environ}
    run = spawn_run('go', GO_LIST + ['./...'], {'trusted': True, 'timeoutMs': 120000, 'persist': False, 'structured': True,
                                                 'raw': True, 'env': env})
    if run['code']:
        raise ValueError('go list failed with exit ' + str(run['code']) + last_line(run['err']))
    return run['out']


def last_line(stderr):
    """': <last stderr line>' sanitized (redacted, single line, bounded), or '' when there is none."""
    from .security import redact
    lines = [line.strip() for line in str(stderr).splitlines() if line.strip()]
    return ': ' + redact(re.sub(r'[\x00-\x1f\x7f]', ' ', lines[-1]))[:200] if lines else ''


def go_graph(text=None):
    """{dir relative to apps/api: set of base import paths in its deps incl. test deps} for packages matched by ./..."""
    packages = parse_go_list(go_list_json() if text is None else text)
    dirs, deps, targets = {}, {}, set()
    for package in packages:
        base = base_import(package.get('ImportPath', ''))
        directory = package.get('Dir')
        if not package.get('DepOnly'):
            targets.add(base)
        if directory:
            try:
                relative = os.path.relpath(directory, config.ROOT / GO_ROOT).replace(os.sep, '/')
            except ValueError:
                continue
            if not relative.startswith('..'):
                dirs.setdefault(base, relative)
        deps.setdefault(base, {base}).update(base_import(d) for d in package.get('Deps') or [])
    local = {base: relative for base, relative in dirs.items() if base in targets}
    return {'dirs': local, 'deps': {base: deps.get(base, {base}) for base in local}}


def go_checks(files):
    changed = [f[len(GO_ROOT) + 1:] for f in files if f.startswith(GO_ROOT + '/')]
    if not changed:
        return []
    go_files = [GO_ROOT + '/' + f for f in changed if f.endswith('.go') and exists(GO_ROOT + '/' + f)]
    checks = []
    if go_files:
        checks.append(check(['gofmt', '-l', '--', *go_files], 'targeted', 'gofmt on changed Go files: ' + ', '.join(go_files), ['gofmt'],
                            failOnOutput=True, coveredBy=COVERED_BY))
    patterns, explanation = ['./...'], None
    everything = next((f for f in changed if f in ['go.mod', 'go.sum']), None)
    try:
        if everything:
            explanation = f'apps/api/{everything} changed: every package is affected'
        else:
            graph = go_graph()
            known = set(graph['dirs'].values())
            seeds, unmapped = set(), None
            for file in changed:
                if file.endswith('.md'):
                    continue
                current = str(PurePosixPath(file).parent)
                while current not in known and current != '.':
                    current = str(PurePosixPath(current).parent)
                if current in known:
                    seeds.add(current)
                else:
                    unmapped = unmapped or file
            if unmapped:
                explanation = f'apps/api/{unmapped} does not belong to a Go package: falling back to ./...'
            else:
                affected = sorted(graph['dirs'][b] for b, d in graph['deps'].items()
                                  if any(graph['dirs'].get(x) in seeds for x in d))
                patterns = ['./' + d if d != '.' else '.' for d in affected]
                explanation = f'{len(patterns)} package(s) depend on changed package(s) ' + ', '.join(sorted(seeds))
                if not patterns:
                    return checks
    except (ValueError, OSError) as error:
        explanation = f'Go dependency graph unavailable ({error}); falling back to ./...'
    reason = 'apps/api changed: ' + explanation
    # verify-enterprise.sh already runs `go vet ./...` and `go test ./...`: these only matter for --fast or when it is skipped.
    for verb in ['vet', 'test']:
        checks.append(check(['go', '-C', GO_ROOT, verb, *patterns], 'targeted', reason, ['go'], coveredBy='verify-enterprise.sh'))
    return checks


def infra_checks(files):
    checks = []
    for file in files:
        if file.endswith('.sh') and exists(file):
            checks.append(check(['bash', '-n', '--', file], 'targeted', f'{file} changed: shell syntax', ['bash']))
        elif matches_path(file, 'infra/docker/compose*.yml') and exists(file):
            checks.append(check(['docker', 'compose', '-f', './' + file, 'config', '--quiet'], 'targeted', f'{file} changed: compose validation', ['docker']))
        elif (matches_path(file, '.github/workflows/*.yml') or matches_path(file, '.github/workflows/*.yaml')) and exists(file):
            # Prettier parses the YAML and fails on structural errors; no extra dependency.
            checks.append(check(['pnpm', 'exec', 'prettier', '--check', '--', file], 'targeted', f'{file} changed: workflow YAML structure', PNPM))
    agent = next((f for f in files if any(matches_path(f, p) for p in AGENT_PATHS)), None)
    if agent:
        checks.append(check(['pnpm', 'agent-config:check'], 'targeted', f'{agent} changed: agent configuration parity', ['pnpm']))
    return checks


def targeted_checks(files, base=None):
    """Files include deleted/renamed paths: the old path still maps to its workspace/package. `base` is the ref the change set is measured against."""
    return js_checks(files, base) + go_checks(files) + infra_checks(files)


CRITICAL_PATHS = ['.github/**', 'verify-enterprise.sh', 'docker-verify-enterprise.sh', '.harness/**', 'infra/**', '**/migrations/**',
                  'docs/api/openapi*', 'docs/api/**/openapi*']
SENSITIVE_WORDS = ('auth', 'rbac', 'tenan', 'migration', 'identity', 'openapi')
QUIET = ('.harness/tasks/', '.harness/state/', '.harness/handoffs/', '.harness/logs/', '.harness/runtime/')
CACHEABLE_SCRIPTS = ('lint', 'typecheck', 'test')  # `build` produces artifacts and `test:critical` may need services: never skipped by cache


def escalation(files, extra=()):
    """(file, reason) of the first change that makes a partial verification unsafe, else None: root workspace/package-manager
    configuration, CI workflows, the enterprise verifier, the Harness itself, infrastructure, migrations, API contracts and
    auth/RBAC/tenancy code. Harness operational state never escalates."""
    for file in files:
        if file.startswith(QUIET):
            continue
        if any(matches_path(file, p) for p in GLOBAL_JS):
            return file, 'root workspace or package-manager configuration'
        if any(file.startswith(p + '/') for p in CONFIG_PACKAGES):
            return file, 'shared tooling configuration'
        if any(matches_path(file, p) for p in [*CRITICAL_PATHS, *extra]):
            return file, 'cross-cutting infrastructure, Harness, migration or contract file'
        if file.startswith(('apps/api/', 'docs/api/')) and any(word in file.lower() for word in SENSITIVE_WORDS):
            return file, 'auth/RBAC/tenancy/migration/OpenAPI sensitive path'
    return None


def root_files():
    """Regular files directly under the repository root (configuration that any check may read); secrets (.env*) excluded."""
    try:
        return sorted(e.name for e in os.scandir(config.ROOT) if e.is_file(follow_symlinks=False) and not e.name.startswith('.env'))
    except OSError:
        return []


def workspace_closure(directory, workspaces):
    """`directory` plus every workspace it depends on, transitively."""
    by_name = {w['name']: d for d, w in workspaces.items()}
    seen, queue = {directory}, [directory]
    while queue:
        for name in sorted(workspaces[queue.pop()]['deps']):
            target = by_name.get(name)
            if target and target not in seen:
                seen.add(target)
                queue.append(target)
    return sorted(seen)


def gate_inputs(command):
    """Repo-relative files/directories whose content decides this check's outcome, or None when that cannot be stated
    (the check is then never cached). Deliberately conservative: whole workspaces plus their dependencies and root config."""
    c = list(command)
    if c[:2] == ['pnpm', '--filter'] and len(c) == 4 and c[2].startswith('./') and c[3] in CACHEABLE_SCRIPTS:
        workspaces = js_workspaces()
        if c[2][2:] not in workspaces:
            return None
        return [*workspace_closure(c[2][2:], workspaces), *CONFIG_PACKAGES, *root_files()]
    if c[:3] == ['go', '-C', GO_ROOT] and len(c) > 3 and c[3] == 'vet':
        return [GO_ROOT, *root_files()]
    if c[:3] == ['gofmt', '-l', '--'] and len(c) > 3:
        return c[3:]
    if c[:3] == ['bash', '-n', '--'] and len(c) == 4:
        return [c[3]]
    if c[:5] == ['pnpm', 'exec', 'prettier', '--check', '--'] and len(c) > 5:
        return [*c[5:], *root_files()]
    return None


def analyze(files, base=None, extra=()):
    """Incremental decision for a change set: {'full': bool, 'reason': str|None, 'failClosed': bool}. Never raises: an
    analysis that cannot be completed asks for the full verification instead of guessing."""
    try:
        found = escalation(files, extra)
        if found:
            return {'full': True, 'reason': f'{found[0]}: {found[1]}', 'failClosed': False}
        return {'full': False, 'reason': None, 'failClosed': False}
    except Exception as error:  # fail closed: broader verification, with the cause
        return {'full': True, 'reason': 'impact analysis failed (' + type(error).__name__ + ': ' + str(error)[:120] + '); verifying everything', 'failClosed': True}
