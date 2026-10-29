"""Environment checks for `harness:preflight`: cheap, read-only questions answered BEFORE any agent or gate is paid for.

Every check is {id, severity: blocking|warning|optional, status: ok|fail|skipped, message, action}. Only a `fail` of a
`blocking` check makes preflight not ready. Checks run only for the needs a task declares (db, docker, ports, provider,
node, go), so a docs-only task never demands PostgreSQL or Docker. Nothing here creates databases, kills processes or
prints credentials; DSNs are reduced to host:port/database before they reach a message.
"""
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

NEEDS = ('db', 'docker', 'ports', 'provider', 'node', 'go')
DOMAIN_NEEDS = {'api': {'go', 'db', 'ports'}, 'workers': {'go'}, 'backoffice': {'node', 'ports'}, 'marketplace': {'node', 'ports'},
                'planner-portal': {'node', 'ports'}, 'provider-portal': {'node', 'ports'}, 'sales-portal': {'node', 'ports'},
                'infra': {'docker'}, 'repo': {'node'}, 'docs': set(), 'n8n': set()}
SOCKET_TIMEOUT_S = 0.5
PROBE_TIMEOUT_S = 2.5
MIGRATIONS = 'apps/api/internal/platform/database/migrations'
MIGRATION_FILE = re.compile(r'^(\d{6})_([a-z0-9_]+)\.(up|down)\.sql$')
VERSION = re.compile(r'(\d+)(?:\.(\d+))?(?:\.(\d+))?')
QUOTA = re.compile(r'rate.?limit|quota|usage limit|credit balance|limit reached|insufficient_quota|429', re.I)
DEFAULT_MIN = {'python': (3, 11), 'git': (2, 17)}
DEFAULT_FREE_MB = {'worktree': (200, 2048), 'state': (50, 200), 'temp': (50, 200)}  # (blocking below, warning below)
TOOL_VERSION_ARGS = {'node': ['--version'], 'pnpm': ['--version'], 'go': ['version'], 'git': ['--version'], 'docker': ['--version'], 'bash': ['--version']}


def check(identity, severity, status, message, action=''):
    return {'id': identity, 'severity': severity, 'status': status, 'message': message, 'action': action}


def ok(identity, message, severity='optional'):
    return check(identity, severity, 'ok', message)


def skipped(identity, message, severity='optional'):
    return check(identity, severity, 'skipped', message)


def blocking_failures(checks):
    return [c for c in checks if c['severity'] == 'blocking' and c['status'] == 'fail']


def derive_needs(domains, trivial=False):
    """Needs implied by the domains a plan touches. Unknown domains demand nothing; non-trivial work needs an agent provider."""
    needs = set()
    for name in domains:
        needs |= DOMAIN_NEEDS.get(name, set())
    if not trivial:
        needs.add('provider')
    return needs


def parse_needs(raw):
    names = {n.strip() for n in str(raw).split(',') if n.strip()}
    unknown = sorted(names - set(NEEDS))
    if unknown:
        raise ValueError('needs inválidos: ' + ', '.join(unknown) + ' (válidos: ' + ', '.join(NEEDS) + ')')
    return names


def parse_version(text):
    match = VERSION.search(text or '')
    return tuple(int(p) for p in match.groups() if p is not None) if match else None


def fmt(version):
    return '.'.join(str(p) for p in version)


def read_text(path):
    try:
        return Path(path).read_text(encoding='utf-8-sig')
    except OSError:
        return ''


def min_versions(root, policy_min=None):
    """Minimums from the repo itself (package.json engines/packageManager, .nvmrc, go.mod) unless the policy overrides them."""
    found = dict(DEFAULT_MIN)
    try:
        package = json.loads(read_text(Path(root) / 'package.json') or '{}')
    except ValueError:
        package = {}
    node = parse_version((package.get('engines') or {}).get('node', '')) or parse_version(read_text(Path(root) / '.nvmrc').lstrip('vV'))
    if node:
        found['node'] = node[:1]
    manager = str(package.get('packageManager', ''))
    if manager.startswith('pnpm@') and parse_version(manager):
        found['pnpm'] = parse_version(manager)[:1]
    elif (package.get('engines') or {}).get('pnpm') and parse_version(package['engines']['pnpm']):
        found['pnpm'] = parse_version(package['engines']['pnpm'])[:1]
    go = re.search(r'^go\s+(\d+\.\d+)', read_text(Path(root) / 'apps/api/go.mod'), re.M)
    if go:
        found['go'] = parse_version(go[1])
    for name, raw in (policy_min or {}).items():
        if parse_version(str(raw)):
            found[name] = parse_version(str(raw))
    return found


def tool_version(binary):
    """(path, version|None): output of `<binary> --version` with a hard timeout; None when it cannot be read."""
    path = shutil.which(binary)
    if not path:
        return None, None
    try:
        done = subprocess.run([path, *TOOL_VERSION_ARGS.get(binary, ['--version'])], capture_output=True, text=True, timeout=PROBE_TIMEOUT_S)
        return path, parse_version(done.stdout or done.stderr)
    except (OSError, subprocess.SubprocessError):
        return path, None


def tool_check(name, needed, minimum, probe):
    identity = 'tool-' + name
    if not needed:
        return skipped(identity, f'{name} no es necesario para esta tarea')
    path, version = probe(name)
    if not path:
        return check(identity, 'blocking', 'fail', f'{name} no está instalado o no está en PATH', f'Instalar {name}' + (f' >= {fmt(minimum)}' if minimum else ''))
    if version is None:
        return check(identity, 'warning', 'fail', f'No se pudo leer la versión de {name}', f'Ejecutar `{name} --version` a mano')
    if minimum and version[:len(minimum)] < minimum:
        return check(identity, 'blocking', 'fail', f'{name} {fmt(version)} es menor que el mínimo {fmt(minimum)}', f'Actualizar {name} a >= {fmt(minimum)}')
    return ok(identity, f'{name} {fmt(version)}', 'blocking')


def tool_checks(needs, minimum, probe=tool_version):
    required = {'git': True, 'node': 'node' in needs, 'pnpm': 'node' in needs, 'go': 'go' in needs, 'docker': 'docker' in needs}
    names = list(required)
    with ThreadPoolExecutor(max_workers=len(names)) as pool:  # version probes are independent; run them side by side
        futures = {n: pool.submit(tool_check, n, required[n], minimum.get(n), probe) for n in names}
        out = [futures[n].result() for n in names]
    python = sys.version_info[:3]
    wanted = minimum.get('python')
    bad = wanted and python[:len(wanted)] < wanted
    out.insert(1, check('tool-python', 'blocking', 'fail' if bad else 'ok', f'python {fmt(python)}' + (f' es menor que el mínimo {fmt(wanted)}' if bad else ''),
                        f'Usar python >= {fmt(wanted)} (HARNESS_PYTHON)' if bad else ''))
    if {'go', 'db', 'docker'} & set(needs):
        out.append(ok('tool-bash', 'bash disponible', 'warning') if shutil.which('bash') else
                   check('tool-bash', 'warning', 'fail', 'bash no está en PATH (verify-enterprise.sh lo necesita)', 'Instalar Git Bash o WSL'))
    return out


def parse_dsn(dsn):
    """(host, port, database) of a URL or key=value DSN. Credentials are never returned."""
    if '://' in dsn:
        try:
            parts = urlsplit(dsn)
            return parts.hostname or 'localhost', parts.port or 5432, parts.path.lstrip('/').split('?')[0] or None
        except ValueError:
            return None, None, None
    pairs = dict(re.findall(r'\b(host|port|dbname)\s*=\s*(\S+)', dsn))
    port = pairs.get('port', '5432')
    return pairs.get('host', 'localhost'), int(port) if port.isdigit() else 5432, pairs.get('dbname', '').strip('\'"') or None


def tcp_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=SOCKET_TIMEOUT_S):
            return True
    except OSError:
        return False


def port_free(port):
    """Bind test on loopback; closed immediately, nothing is left listening."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.settimeout(SOCKET_TIMEOUT_S)
        if os.name != 'nt':  # on Windows SO_REUSEADDR would let the bind succeed over a live listener
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def dev_database(root):
    """Database name the dev API uses (apps/api/.env, then .env.example); None when undeclared."""
    for name in ('.env', '.env.example'):
        match = re.search(r'^\s*DB_DSN\s*=\s*(.+)$', read_text(Path(root) / 'apps/api' / name), re.M)
        if match:
            return parse_dsn(match[1].strip().strip('"\''))[2]
    return None


def db_checks(root, env, reachable=tcp_open):
    dsn = env('REDEVENT_E2E_DSN')
    if not dsn:
        return [check('db-dsn', 'warning', 'fail', 'REDEVENT_E2E_DSN no está definida: las pruebas E2E con PostgreSQL se omitirán',
                      'Definir REDEVENT_E2E_DSN apuntando a una base dedicada *_e2e (ver verify-enterprise.sh)'),
                skipped('db-reachable', 'sin DSN no hay conexión que probar'), skipped('db-exists', 'sin DSN no hay base que verificar')]
    host, port, database = parse_dsn(dsn)
    where = f'{host}:{port}' if host else 'host desconocido'
    out = [ok('db-dsn', f'REDEVENT_E2E_DSN definida ({where}/{database or "?"})', 'warning')]
    dev = dev_database(root)
    if not database or not database.endswith('_e2e'):
        out.append(check('db-isolation', 'blocking', 'fail', f'La base E2E {database or "desconocida"} no termina en `_e2e`', 'Apuntar REDEVENT_E2E_DSN a una base descartable *_e2e'))
    elif dev and database == dev:
        out.append(check('db-isolation', 'blocking', 'fail', f'La base E2E {database} coincide con la base de desarrollo', 'Usar una base distinta de DB_DSN'))
    else:
        out.append(ok('db-isolation', f'Base E2E {database} aislada de la de desarrollo' + (f' ({dev})' if dev else ''), 'blocking'))
    up = bool(host and reachable(host, port))
    out.append(ok('db-reachable', f'PostgreSQL responde en {where}', 'warning') if up else
               check('db-reachable', 'warning', 'fail', f'PostgreSQL no responde en {where} (socket, {int(SOCKET_TIMEOUT_S * 1000)} ms)', 'Levantar PostgreSQL local (docker compose / servicio) antes de correr E2E'))
    out.append(skipped('db-exists', 'la existencia de la base no se verifica: no hay driver de PostgreSQL en el Harness y no se crea ni modifica ninguna base'))
    return out


def qa_migrations(root, ref='origin/qa'):
    """Migration file names on the qa ref (local ref only, no fetch); None when the ref is unavailable."""
    try:
        done = subprocess.run(['git', 'ls-tree', '-r', '--name-only', ref, '--', MIGRATIONS], cwd=root, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return [line.rsplit('/', 1)[-1] for line in done.stdout.splitlines()] if done.returncode == 0 else None


def migration_index(names):
    """{number: set(slugs)} of up/down files that follow the NNNNNN_name.(up|down).sql convention."""
    index = {}
    for name in names:
        match = MIGRATION_FILE.match(name)
        if match:
            index.setdefault(int(match[1]), set()).add(match[2])
    return index



def open_pr_migrations(root, base='qa', exclude_branch=None):
    """Open PR migration reservations; None means GitHub is unavailable."""
    if not shutil.which('gh'):
        return None
    command = ['gh', 'pr', 'list', '--base', base, '--state', 'open',
               '--json', 'number,title,headRefName,files', '--limit', '100']
    try:
        done = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=8)
        if done.returncode:
            return None
        prs = json.loads(done.stdout)
        if not isinstance(prs, list):
            return None
        out = []
        for pr in prs:
            if pr.get('headRefName') == exclude_branch:
                continue
            names = []
            for entry in pr.get('files') or []:
                path = entry.get('path', '') if isinstance(entry, dict) else ''
                if path.startswith(MIGRATIONS + '/'):
                    names.append(path.rsplit('/', 1)[-1])
            if names:
                out.append({'number': pr.get('number'), 'title': pr.get('title', ''),
                            'headRefName': pr.get('headRefName'), 'files': names})
        return out
    except (OSError, subprocess.SubprocessError, ValueError, TypeError):
        return None


def migration_report(root, remote=qa_migrations, prs=open_pr_migrations, exclude_branch=None):
    """Compute reservations and collisions without changing the checkout."""
    directory = Path(root) / MIGRATIONS
    local = migration_index(p.name for p in directory.iterdir()) if directory.is_dir() else {}
    upstream_names = remote(root)
    qa = migration_index(upstream_names) if upstream_names is not None else {}
    current = exclude_branch or os.environ.get('GITHUB_HEAD_REF') or None
    if current is None:
        try:
            proc = subprocess.run(['git', 'branch', '--show-current'], cwd=root,
                                  capture_output=True, text=True, timeout=3)
            current = proc.stdout.strip() if proc.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            current = None
    open_prs = prs(root, exclude_branch=current)
    reservations = {}
    details = []
    for item in open_prs or []:
        numbers = migration_index(item['files'])
        details.append({'number': item['number'], 'title': item['title'],
                        'numbers': sorted(numbers)})
        for n, slugs in numbers.items():
            reservations.setdefault(n, []).append((item['number'], slugs))
    # Compare with qa, not with HEAD: once a feature migration is committed it
    # still belongs to this branch and must be checked against PR reservations.
    baseline = set(upstream_names or [])
    changed = set()
    if directory.is_dir():
        for path in directory.iterdir():
            match = MIGRATION_FILE.match(path.name)
            if match and path.name not in baseline:
                changed.add((int(match[1]), match[2]))
    pr_collisions = {n for n, slug in changed
                     if upstream_names is not None and
                     any(slug not in slugs for _, slugs in reservations.get(n, []))}
    # A migration already committed on this branch can also collide with qa itself (another feature
    # merged first and reused the same number): that is a real collision regardless of PRs, and
    # migration_report/its CLI must report and fail on it too, not only the PR case (PR157 F2).
    qa_collisions = {n for n, slug in changed if upstream_names is not None and n in qa and slug not in qa[n]}
    collisions = sorted(pr_collisions | qa_collisions)
    highest = max([*local, *qa, *reservations], default=0)
    return {'next': highest + 1, 'local': max(local, default=0),
            'qa': max(qa, default=0) if upstream_names is not None else None,
            'openPrs': details if open_prs is not None else None,
            'sources': {'local': sorted(local), 'qa': sorted(qa) if upstream_names is not None else None,
                        'openPrs': {str(n): [p for p, _ in entries] for n, entries in sorted(reservations.items())}},
            'collisions': collisions,
            'collisionSources': {str(n): sorted({s for s in
                                                 ('qa' if n in qa_collisions else None,
                                                  'pr' if n in pr_collisions else None) if s})
                                 for n in collisions}}



def migration_checks(root, remote=qa_migrations, prs=open_pr_migrations):
    directory = Path(root) / MIGRATIONS
    if not directory.is_dir():
        return [skipped('migrations-numbering', 'el repo no tiene directorio de migraciones')]
    local = migration_index(p.name for p in directory.iterdir())
    if not local:
        return [skipped('migrations-numbering', 'sin migraciones numeradas')]
    top = max(local)
    duplicates = sorted(n for n, slugs in local.items() if len(slugs) > 1)
    gaps = [n for n in range(1, top) if n not in local]
    other = remote(root)
    upstream = migration_index(other) if other is not None else {}
    collisions = sorted(n for n, slugs in local.items() if n in upstream and slugs != upstream[n])
    out = []
    if duplicates:
        out.append(check('migrations-numbering', 'blocking', 'fail', 'Números de migración duplicados: ' + ', '.join(f'{n:06d}' for n in duplicates), 'Renumerar la migración propia'))
    elif gaps:
        out.append(check('migrations-numbering', 'warning', 'fail', 'Huecos en la numeración: ' + ', '.join(f'{n:06d}' for n in gaps[:5]), 'Verificar que no falte una migración'))
    else:
        out.append(ok('migrations-numbering', f'Numeración contigua 000001..{top:06d} (siguiente local: {top + 1:06d})', 'blocking'))
    if other is None:
        out.append(skipped('migrations-origin-qa', 'origin/qa no está disponible localmente (no se hace fetch); no se pueden detectar colisiones'))
    elif collisions:
        out.append(check('migrations-origin-qa', 'blocking', 'fail', 'Colisión con origin/qa en: ' + ', '.join(f'{n:06d}' for n in collisions), 'Renumerar tras rebasar sobre origin/qa'))
    else:
        free = max(top, max(upstream, default=0)) + 1
        message = f'Sin colisiones con origin/qa; próximo número libre: {free:06d}'
        out.append(ok('migrations-origin-qa', message, 'blocking') if free == top + 1 else
                   check('migrations-origin-qa', 'warning', 'fail', f'origin/qa va por delante ({max(upstream):06d}); próximo número libre: {free:06d}', 'Rebasar sobre origin/qa antes de crear migraciones'))
    report = migration_report(root, remote=remote, prs=prs)
    if report['openPrs'] is None:
        out.append(skipped('migrations-open-prs', 'GitHub CLI no disponible o sin acceso; verificación de PRs omitida'))
    elif report['qa'] is None:
        out.append(skipped('migrations-open-prs', 'origin/qa inaccesible; no se puede distinguir una migración propia de una existente'))
    elif report['collisions']:
        out.append(check('migrations-open-prs', 'blocking', 'fail',
                         'Migraciones nuevas colisionan con PRs abiertos: ' +
                         ', '.join(f'{n:06d}' for n in report['collisions']),
                         'Reservar otro número con pnpm harness:migrations'))
    elif report['next'] > max(local, default=0) + 1:
        out.append(check('migrations-open-prs', 'warning', 'fail',
                         f'Hay números reservados; próximo libre: {report["next"]:06d}',
                         'Usar pnpm harness:migrations'))
    else:
        out.append(ok('migrations-open-prs', 'Sin colisiones con PRs abiertos', 'blocking'))
    return out


def api_ports(root):
    """Dev ports declared by the repo: HTTP_ADDR and the localhost origins in apps/api/.env.example."""
    text = read_text(Path(root) / 'apps/api/.env.example')
    found = {}
    match = re.search(r'^\s*HTTP_ADDR\s*=\s*\S*?:(\d+)\s*$', text, re.M)
    if match:
        found[int(match[1])] = 'API (HTTP_ADDR)'
    cors = re.search(r'^\s*CORS_ALLOWED_ORIGINS\s*=\s*(.+)$', text, re.M)
    for port in re.findall(r'localhost:(\d+)', cors[1] if cors else ''):
        found.setdefault(int(port), 'portal (CORS_ALLOWED_ORIGINS)')
    return found


def port_checks(root, needs, free=port_free):
    if 'ports' not in needs:
        return [skipped('ports', 'los puertos de desarrollo no son necesarios para esta tarea')]
    declared = api_ports(root)
    wanted = {p: n for p, n in declared.items() if ('go' in needs and n.startswith('API')) or ('node' in needs and n.startswith('portal'))}
    if not wanted:
        return [skipped('ports', 'no hay puertos declarados para los dominios de esta tarea')]
    return [ok(f'port-{p}', f'Puerto {p} libre ({n})', 'warning') if free(p) else
            check(f'port-{p}', 'warning', 'fail', f'Puerto {p} ocupado ({n})', 'Detener el proceso que lo usa (el Harness no lo mata) o cambiar el puerto')
            for p, n in sorted(wanted.items())]


def residual_check(h, live_ids, orphans):
    """Report-only: running Harness tasks (by lock pid) and orphan worktrees. Nothing is ever signalled or killed."""
    pids = []
    for identity in live_ids:
        try:
            pids.append(f'{identity} (pid {json.loads(read_text(Path(h) / "state" / (identity + ".lock")) or "{}").get("pid", "?")})')
        except ValueError:
            pids.append(identity)
    if not pids and not orphans:
        return ok('residual-processes', 'sin tareas ni worktrees residuales del Harness')
    parts = []
    if pids:
        parts.append('tareas del Harness en ejecución: ' + ', '.join(pids[:5]))
    if orphans:
        parts.append(f'{len(orphans)} worktree(s) huérfanos')
    return check('residual-processes', 'optional', 'fail', '; '.join(parts), 'Solo informativo: esperar a que terminen o usar harness:hygiene; el preflight no mata procesos')


def nearest_existing(path):
    path = Path(path)
    while not path.exists() and path != path.parent:
        path = path.parent
    return path


def writable(directory):
    try:
        with tempfile.NamedTemporaryFile(dir=directory, prefix='.preflight-', delete=True):
            return True
    except OSError:
        return False


def disk_checks(h, worktree_dir, free_mb=None):
    """Free space and write permission of the directories the Harness writes to (probe file removed at once)."""
    limits = {**DEFAULT_FREE_MB, **(free_mb or {})}
    targets = [('worktree', worktree_dir), ('state', Path(h) / 'state'), ('temp', Path(tempfile.gettempdir()))]
    out = []
    for label, target in targets:
        if isinstance(target, Exception):
            out.append(check('disk-' + label, 'blocking', 'fail', 'Directorio de trabajo inválido: ' + str(target), 'Corregir HARNESS_WORKTREE_DIR (ruta absoluta)'))
            continue
        base = nearest_existing(target)
        try:
            free = shutil.disk_usage(base).free // (1024 * 1024)
        except OSError:
            out.append(check('disk-' + label, 'warning', 'fail', f'No se pudo leer el espacio libre de {base}', 'Verificar el volumen'))
            continue
        hard, soft = limits[label]
        if not writable(base):
            out.append(check('disk-' + label, 'blocking', 'fail', f'Sin permiso de escritura en {base}', 'Corregir permisos o apuntar HARNESS_WORKTREE_DIR a otro volumen'))
        elif free < hard:
            out.append(check('disk-' + label, 'blocking', 'fail', f'{free} MB libres en {base} (mínimo {hard} MB)', 'Liberar espacio o mover HARNESS_WORKTREE_DIR'))
        elif free < soft:
            out.append(check('disk-' + label, 'warning', 'fail', f'Poco espacio: {free} MB libres en {base} (recomendado {soft} MB)', 'Liberar espacio'))
        else:
            out.append(ok('disk-' + label, f'{free} MB libres y escribible en {base}', 'blocking'))
    return out


def quota_hint(h, limit=5):
    """Newest state files that mention a provider quota/rate-limit failure (task ids only)."""
    directory = Path(h) / 'state'
    if not directory.is_dir():
        return []
    files = sorted((f for f in directory.glob('*.json') if f.is_file()), key=lambda f: f.stat().st_mtime, reverse=True)[:limit]
    return [f.stem for f in files if QUOTA.search(read_text(f)[:200000])]


def provider_checks(h, env, which=shutil.which):
    command, host = env('HARNESS_AGENT_COMMAND'), (env('HARNESS_HOST') or '').lower()
    if command:
        try:
            first = (shlex.split(command, posix=os.name != 'nt') or [''])[0].strip('"\'')
        except ValueError:
            first = ''
        found = bool(first) and bool(which(first) or Path(first).exists())
        out = [ok('provider', 'HARNESS_AGENT_COMMAND resuelve a un ejecutable', 'blocking') if found else
               check('provider', 'blocking', 'fail', 'HARNESS_AGENT_COMMAND no apunta a un ejecutable existente', 'Corregir o quitar HARNESS_AGENT_COMMAND')]
    elif host in ('claude', 'codex'):
        out = [ok('provider', f'CLI {host} disponible', 'blocking') if which(host) else
               check('provider', 'blocking', 'fail', f'HARNESS_HOST={host} pero `{host}` no está en PATH', f'Instalar el CLI {host} o cambiar HARNESS_HOST')]
    else:
        out = [check('provider', 'blocking', 'fail', 'No hay proveedor de agentes: HARNESS_HOST (codex|claude) ni HARNESS_AGENT_COMMAND están definidos', 'Definir HARNESS_HOST en .harness/.env')]
    hits = quota_hint(h)
    if hits:
        out.append(check('provider-quota', 'warning', 'fail', 'Tareas recientes con errores de cuota/rate limit del proveedor: ' + ', '.join(hits),
                         'Probar el otro host (HARNESS_HOST) o esperar a que se renueve la cuota'))
    return out


def interfering_process_checks(root):
    """Informational detection only: never sends signals or alters processes."""
    command = ['tasklist', '/fo', 'csv', '/nh'] if os.name == 'nt' else ['ps', '-eo', 'args=']
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=3)
        if proc.returncode:
            return [skipped('interfering-processes', 'No se pudo consultar la lista de procesos')]
        found = []
        expressions = ((r'\bair(?:\.exe)?\b', 'Air'),
                       (r'playwright\s+(?:test|open|codegen)', 'Playwright CLI'),
                       (r'\b(?:vitest|jest)\b.*(?:--watch|watchAll)', 'Test watcher'))
        for pattern, title in expressions:
            if re.search(pattern, proc.stdout, re.I):
                found.append(title)
        if found:
            return [check('interfering-processes', 'optional', 'fail',
                          'Posibles procesos que escriben durante snapshots: ' + ', '.join(found),
                          'Revisar antes de ejecutar; el Harness nunca finaliza procesos')]
        return [ok('interfering-processes', 'No se detectaron procesos interferentes conocidos')]
    except (OSError, subprocess.SubprocessError):
        return [skipped('interfering-processes', 'Inspección de procesos no disponible')]


def run_checks(needs, root, h, env, worktree_dir=None, policy=None, live_ids=(), orphans=(), probes=None):
    """All checks for `needs`; `env` is a name -> value|None callable. `probes` overrides sockets/tools in tests."""
    probes = probes or {}
    needs, policy = set(needs), policy or {}
    minimum = min_versions(root, policy.get('minVersions'))
    out = tool_checks(needs, minimum, probes.get('tool', tool_version))
    if 'db' in needs:
        out += db_checks(root, env, probes.get('tcp', tcp_open)) + migration_checks(root, probes.get('remote', qa_migrations))
    else:
        out.append(skipped('db', 'PostgreSQL no es necesario para esta tarea'))
    out += port_checks(root, needs, probes.get('port', port_free))
    out += provider_checks(h, env, probes.get('which', shutil.which)) if 'provider' in needs else [skipped('provider', 'no se lanzarán agentes para esta tarea')]
    out.append(residual_check(h, live_ids, orphans))
    out += interfering_process_checks(root)
    out += disk_checks(h, worktree_dir if worktree_dir is not None else Path(tempfile.gettempdir()), policy.get('minFreeMb'))
    return out
