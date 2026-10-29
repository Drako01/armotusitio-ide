"""Pre-flight review of a task specification: deterministic questions, read-only environment warnings and a receipt.

`harness:preflight` answers "is this spec safe to launch?" before any agent is paid for. It never mutates product code or
lifecycle state; the only things it writes are its receipt (state/preflight/) and, with `--fix`, the removal of orphan
worktrees through the same guarded path as `harness:hygiene --prune-worktrees`.
"""
import json
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from . import config, envcheck, hygiene, planner, tasks, worktree
from .config import H, ROOT, UsageError, digest, now, read_json, write_json
from .routing import MUTATION
from .state import Lock, log

RECEIPT_TTL_S = 3600
LARGE_CHARS = 3000
TRIVIAL_CHARS = 400
UNIT_ANY = re.compile(r'^\s*(?:[-*]\s*)?unit:\s*\S', re.I | re.M)
CARD = re.compile(r'\bRED-\d{3}-\d+\b')
DEPENDENCY = re.compile(r'(?:depende\s+de|dependencias?\s*:?|requiere|despu[eé]s\s+de|bloquead[oa]\s+por|necesita)\s+(?:la\s+|las\s+)?(?:cards?\s+)?((?:RED-\d{3}-\d+[\s,y/]*)+)', re.I)
ACCEPTANCE = re.compile(r'criterio|aceptaci|\bdebe(?:n|rá|ría)?\b|\bdone\b|acceptance|\bmust\b|definici[oó]n de (?:hecho|terminado)|verific', re.I)
E2E = re.compile(r'e2e|postgres(?:ql)?|REDEVENT_E2E_DSN', re.I)
E2E_DB = re.compile(r'\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_e2e\b')
MIGRATION = re.compile(r'migraci[oó]n|migration', re.I)
MIGRATION_NUMBER = re.compile(r'\b\d{3,}[_-][a-z]|(?:n[úu]mero|nro\.?|n[°º]|#)\s*\d+|\bversi[oó]n\s+\d{3,}', re.I)
PROPOSAL = re.compile(r'\bPROPUESTA\b|pendiente\s+de\s+ratificaci', re.I)
CLOSED = re.compile(r'cerrad|mergead|entregad|merged|closed|done', re.I)


def question(identity, text, why, options=None):
    item = {'id': identity, 'question': text, 'why': why}
    if options:
        item['options'] = options
    return item


def warning(identity, severity, message, action):
    return {'id': identity, 'severity': severity, 'message': message, 'action': action}


def safe_preview(domain, text):
    """(preview, error): planning rejections (bad unit lines, unknown domain) are reported, never raised."""
    try:
        return tasks.preview(domain, text), None
    except Exception as error:  # planning is advisory here; the real ingestion repeats and enforces it
        return [], str(error)


def domain_rules(names):
    out = []
    for name in names:
        try:
            from .context import get_domain
            out.append(get_domain(name))
        except Exception:
            pass
    return out


def mutating_path_bullets(text):
    count = 0
    for line in text.splitlines():
        bullet = planner.BULLET.match(line)
        if bullet and re.search(MUTATION, bullet[1], re.I) and planner.PATH.search(bullet[1]):
            count += 1
    return count


def spec_questions(domain, text, previews):
    """Deterministic rules over the specification text. A clear specification yields no question at all."""
    found, has_units = [], bool(UNIT_ANY.search(text))
    if not has_units and (len(text) > LARGE_CHARS or mutating_path_bullets(text) >= 3):
        found.append(question('large-without-units', '¿Cómo se parte esta tarea extensa en unidades paralelas?',
                              'La tarea es grande y no declara líneas `unit:`; sin ellas corre como cadena secuencial.',
                              ['Agregar líneas `unit: <id> | owns=<globs>` por área independiente', 'Ejecutar secuencial a propósito']))
    units = []
    if has_units:
        try:
            units = planner.parse_units(text, 'backend')
        except ValueError:
            units = []  # the invalid-plan warning carries the parse error
    for unit in units:
        if not unit['owns']:
            found.append(question('unit-without-owns-' + unit['unit'], f'¿Qué rutas posee la unidad {unit["unit"]}?',
                                  'Una unidad sin `owns` no puede aislarse ni paralelizarse con seguridad.'))
    rules = domain_rules([p['domain'] for p in previews] or ([] if domain == 'auto' else [domain]))
    if rules:
        for unit in units:
            outside = [o for o in unit['owns'] if not any(planner.covered(o, allowed) for r in rules for allowed in r['paths'])]
            if outside:
                found.append(question('owns-outside-domain-' + unit['unit'], f'La unidad {unit["unit"]} posee rutas fuera del dominio: {", ".join(outside)}. ¿Es correcto?',
                                      'Las rutas fuera de los paths del dominio serán rechazadas al crear la tarea.',
                                      ['Mover la unidad al dominio dueño de esas rutas', 'Ajustar `owns` dentro del dominio']))
    if E2E.search(text) and not E2E_DB.search(text):
        found.append(question('e2e-database', '¿Qué base dedicada `*_e2e` usan las pruebas E2E/PostgreSQL?',
                              'Las pruebas con base real sólo pueden apuntar a una base cuyo nombre termine en `_e2e`.'))
    if MIGRATION.search(text) and not MIGRATION_NUMBER.search(text):
        found.append(question('migration-number', '¿Qué número de migración está reservado para esta tarea?',
                              'Sin número reservado, dos tareas paralelas pueden crear migraciones en colisión.'))
    if len(text) >= TRIVIAL_CHARS and not ACCEPTANCE.search(text):
        found.append(question('acceptance-criteria', '¿Cuáles son los criterios de aceptación?',
                              'La spec no indica cuándo la tarea está terminada; el reviewer no tiene contra qué validar.'))
    if PROPOSAL.search(text):
        found.append(question('contract-ratification', 'El contrato figura como PROPUESTA / pendiente de ratificación. ¿Está ratificado?',
                              'Implementar sobre un contrato no ratificado obliga a rehacer el trabajo si cambia.',
                              ['Está ratificado', 'Implementar bajo la propuesta asumiendo el riesgo']))
    cards = []
    for match in DEPENDENCY.finditer(text):
        cards += CARD.findall(match[1])
    for card in dict.fromkeys(cards):
        near = ' '.join(line for line in text.splitlines() if card in line)
        if not CLOSED.search(near):
            found.append(question('dependency-' + card.lower(), f'La spec depende de {card}. ¿Está cerrada y mergeada?',
                                  'Trabajar sobre una dependencia abierta produce conflictos y supuestos falsos.'))
    return found


def dag_width(dag):
    """Widest level of implementer nodes (read-only/deterministic roles do not need their own worker)."""
    names = {n['id']: n for n in dag}
    depth = {}

    def level(identity, trail=()):
        if identity not in depth:
            deps = [d for d in names[identity].get('dependsOn', []) if d in names and d not in trail]
            depth[identity] = 1 + max([level(d, trail + (identity,)) for d in deps], default=0)
        return depth[identity]

    counts = {}
    for node in dag:
        if node.get('agent') not in config.NON_IMPLEMENTERS:
            counts[level(node['id'])] = counts.get(level(node['id']), 0) + 1
    return max(counts.values(), default=1)


def recommend(previews):
    best, why = 1, 'plan legacy o secuencial: un worker alcanza'
    for item in previews:
        if isinstance(item.get('recommendedWorkers'), int):
            value, reason = item['recommendedWorkers'], item.get('workerRationale') or 'recomendado por el planificador'
        elif (item.get('plan') or {}).get('parallel'):
            value = dag_width(item.get('dag', []))
            reason = f'ancho máximo del DAG paralelo: {value} nodos implementadores simultáneos'
        else:
            continue
        if value > best:
            best, why = value, reason
    return best, why


def env_value(name):
    if name in os.environ:
        return os.environ[name]
    try:
        for line in (H / '.env').read_text(encoding='utf-8-sig').splitlines():
            key, sep, value = line.partition('=')
            if sep and key.strip() == name:
                return value.strip().strip('"\'')
    except OSError:
        pass
    return None


def e2e_database(dsn):
    """Database name of a URL or key=value DSN, or None when it cannot be read."""
    if '://' in dsn:
        return urlsplit(dsn).path.lstrip('/').split('?')[0] or None
    match = re.search(r'\bdbname\s*=\s*(\S+)', dsn)
    return match[1].strip('\'"') if match else None


def orphan_entries(rows=None, live=()):
    """Registered worktrees nobody can resume: task missing, completed/aborted, or active with a dead lock.
    Failed (not aborted) attempts stay: they are evidence that `harness:retry` and the operator still need."""
    rows = {r['id']: r for r in (rows if rows is not None else hygiene.scan_tasks())}
    out = []
    for entry in worktree.list_registry():
        identity = entry.get('task')
        if identity in live:
            continue
        row = rows.get(identity)
        if row is None or row['status'] == 'completed' or (row['task'] or {}).get('aborted'):
            out.append(entry)
        elif row['status'] == 'active' and hygiene.lock_state(identity) != 'alive':
            out.append(entry)
    return out


def live_task_ids():
    """Ids of tasks whose lock is held by a running process."""
    directory = H / 'state'
    if not directory.is_dir():
        return []
    return [f.stem for f in sorted(directory.glob('*.lock')) if f.stem != 'workspace' and hygiene.lock_state(f.stem) == 'alive']


def cleanup_orphan_worktrees(live_task_ids=()):
    """Best effort removal of orphan worktrees; never touches live tasks, skips silently when the workspace lock is busy."""
    cleaned = []
    try:
        live = set(live_task_ids) | set(globals()['live_task_ids']())
        with Lock(H / 'state/workspace.lock'):
            for entry in orphan_entries(live=live):
                try:
                    worktree.Worktree(entry['task'], entry['node'], entry['attempt'], entry['runId']).discard()
                    log('audit', entry['task'], 'worktree-pruned', {'name': entry['name'], 'state': entry.get('state'), 'by': 'preflight'})
                    cleaned.append(f'{entry["name"]} ({entry.get("state")})')
                except Exception:
                    continue
    except Exception:  # busy workspace lock, unreadable state: cleanup is an optimisation, never a failure
        pass
    return cleaned


def dirty_files():
    try:
        done = subprocess.run(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return []
    if done.returncode != 0:
        return []
    files = [line[3:].split(' -> ')[-1].strip().strip('"') for line in done.stdout.splitlines() if len(line) > 3]
    return [f for f in files if not f.startswith('.harness/') or f.startswith('.harness/core') or f.startswith('.harness/tests')]


def env_warnings(previews, workers):
    found = []
    rows = hygiene.scan_tasks()
    orphans = orphan_entries(rows, live_task_ids())
    if orphans:
        found.append(warning('orphan-worktrees', 'info', f'{len(orphans)} worktree(s) huérfanos de tareas no activas o sin lock vivo: ' + ', '.join(e.get('name', '?') for e in orphans[:5]),
                             hygiene.PRUNE_COMMAND))
    state_dir = H / 'state'
    dead = [f.stem for f in sorted(state_dir.glob('*.lock')) if hygiene.lock_state(f.stem) in ('dead', 'malformed')] if state_dir.is_dir() else []
    if dead:
        found.append(warning('dead-locks', 'info', 'Locks sin proceso vivo: ' + ', '.join(dead), 'pnpm harness:hygiene (se recuperan al reanudar con harness:execute)'))
    for row in rows:
        running = [n['id'] for n in (row['task'] or {}).get('dag', []) if n.get('status') == 'running'] if not row['invalid'] else []
        if row['status'] == 'failed' and running:
            found.append(warning('failed-with-running-nodes-' + row['id'], 'info', f'Tarea failed {row["id"]} con nodos running: ' + ', '.join(running),
                                 f'pnpm harness:retry -- {row["id"]} "nodos interrumpidos"'))
    dsn = env_value('REDEVENT_E2E_DSN')
    if dsn:
        database = e2e_database(dsn)
        if not database or not database.endswith('_e2e'):
            found.append(warning('e2e-dsn-not-dedicated', 'blocking', f'REDEVENT_E2E_DSN apunta a la base {database or "desconocida"}, que no termina en `_e2e`.',
                                 'Apuntar REDEVENT_E2E_DSN a una base dedicada *_e2e antes de ejecutar'))
    owns = [o for p in previews for n in p.get('dag', []) for o in n.get('owns', [])]
    files = dirty_files()
    unrelated = [f for f in files if not any(planner.covered(f, o) for o in owns)] if owns else files
    if unrelated:
        found.append(warning('dirty-tree', 'info', f'{len(unrelated)} cambio(s) sin relación con la tarea en el árbol: ' + ', '.join(unrelated[:5]),
                             'Commitear o apartar esos cambios; el Harness los verá como ruido de alcance'))
    limit = env_value('HARNESS_MAX_WORKERS')
    if limit and limit.isdigit() and int(limit) < 4 and workers > int(limit):
        found.append(warning('max-workers-low', 'info', f'HARNESS_MAX_WORKERS={limit} limita el paralelismo por debajo de los {workers} workers recomendados.',
                             'Subir HARNESS_MAX_WORKERS en .harness/.env o aceptar la ejecución más lenta'))
    if env_value('HARNESS_ALLOW_HOST_WRITES') == '1':
        found.append(warning('host-writes-enabled', 'info', 'HARNESS_ALLOW_HOST_WRITES=1: los agentes pueden escribir fuera del worktree aislado.',
                             'Quitar HARNESS_ALLOW_HOST_WRITES de .harness/.env salvo que sea imprescindible'))
    return found


def environment_checks(previews, trivial, needs=None, orphans=None, live=None):
    """Structured environment checks for the needs of the plan (or the explicit `needs`). Never raises: a failing probe is a check."""
    if env_value('HARNESS_PREFLIGHT_CHECKS') == 'off':
        return []
    if needs is None:
        needs = envcheck.derive_needs([p['domain'] for p in previews], trivial)
    try:
        directory = worktree.base_dir()
    except ValueError as error:
        directory = error
    try:
        settings = config.policy().get('preflight') or {}
    except (OSError, ValueError):
        settings = {}
    live = live_task_ids() if live is None else live
    orphans = orphan_entries(live=live) if orphans is None else orphans
    return envcheck.run_checks(needs, ROOT, H, env_value, directory, settings, live, orphans)


def run_checks_only(needs=None):
    """`harness:preflight --checks-only`: just the environment checks, no spec. Default needs: everything but docker."""
    needs = set(needs) if needs else set(envcheck.NEEDS) - {'docker'}
    checks = environment_checks([], False, needs)
    return {'ready': not envcheck.blocking_failures(checks), 'needs': sorted(needs), 'checks': checks}


def lessons_for(domain, previews):
    try:
        from . import lessons
        agents = sorted({a for p in previews for a in p.get('agents', [])})
        names = [p['domain'] for p in previews] or [domain]
        return list(lessons.relevant(names[0], agents, limit=5))
    except Exception:  # module absent or lessons unreadable: preflight must still work
        return []


def receipt_file(domain, text):
    return H / 'state/preflight' / (digest(domain + '\n' + text) + '.json')


def write_receipt(domain, text, result):
    file = receipt_file(domain, text)
    write_json(file, {'createdAt': now(), 'ready': bool(result.get('ready')), 'questions': result.get('questions', []),
                      'answers': result.get('answers', {}), 'recommendedWorkers': result.get('recommendedWorkers', 1)})
    return file


def as_epoch(value):
    if value is None:
        return time.time()
    return value.timestamp() if isinstance(value, datetime) else float(value)


def is_trivial(domain, text):
    if len(text) >= TRIVIAL_CHARS or UNIT_ANY.search(text):
        return False
    previews, error = safe_preview(domain, text)
    if error:
        return True  # short text without unit lines: nothing to plan wrongly
    return all((p.get('plan') or {}).get('source', 'legacy') == 'legacy' and not (p.get('plan') or {}).get('parallel') for p in previews)


def baseline_gates(domain, text):
    """Run authoritative gates on current checkout before task creation; reuse gate cache."""
    from .verification import verify_plan, selected, run_gates
    from .config import gate_timeout_ms
    domains = [p['domain'] for p in safe_preview(domain, text)[0]]
    domains = domains or ([domain] if domain != 'auto' else [])
    results = []
    for name in sorted(set(domains)):
        plan = verify_plan(name, files=[], task=text, targeted_checks=False, incremental=False)
        gates = selected(plan)
        results.extend(run_gates(None, gates, gate_timeout_ms(), keep_going=False))
        if any(row['status'] != 'PASS' for row in results):
            break
    return results


def require_receipt(domain, text, environ=None, now=None):
    """Raises UsageError when a non-trivial task is about to start without a fresh, ready preflight receipt."""
    environ = os.environ if environ is None else environ
    if environ.get('HARNESS_PREFLIGHT') == 'off' or is_trivial(domain, text):
        return
    hint = f'Ejecutá primero `pnpm harness:preflight -- {domain} --file <spec>` (o pasá --no-preflight bajo tu responsabilidad).'
    try:
        data = read_json(receipt_file(domain, text))
        created = hygiene.parse_time(data.get('createdAt'))
    except (OSError, ValueError):
        raise UsageError('Esta tarea no tiene preflight. ' + hint) from None
    if created is None or not data.get('ready'):
        raise UsageError('El último preflight de esta tarea no quedó listo (preguntas o bloqueos pendientes). ' + hint)
    if as_epoch(now) - created.timestamp() > RECEIPT_TTL_S:
        raise UsageError('El preflight de esta tarea tiene más de 60 minutos. ' + hint)
    if environ.get('HARNESS_PREFLIGHT_CHECKS') != 'off':
        failed = [row for row in baseline_gates(domain, text) if row.get('status') != 'PASS']
        if failed:
            first = failed[0]
            raise UsageError('Baseline de gates no válido: ' +
                             ' '.join(first.get('command', [])) + ' (' + str(first.get('status')) +
                             ') log=' + str(first.get('log')) + '. Corregir antes de crear la tarea.')


def run(domain, text, answers=None, fix=False, needs=None):
    if not text or not text.strip():
        raise UsageError('preflight requiere el texto de la tarea o --file')
    answers = {k: v for k, v in (answers or {}).items() if str(v).strip()}
    fixed = cleanup_orphan_worktrees() if fix else []
    previews, error = safe_preview(domain, text)
    raised = spec_questions(domain, text, previews)
    pending = [q for q in raised if q['id'] not in answers]
    workers, rationale = recommend(previews)
    warnings = env_warnings(previews, workers)
    if error:
        warnings.insert(0, warning('plan-invalid', 'blocking', 'El planificador rechazó la spec: ' + error, 'Corregir la spec (unidades, rutas, dominio) y repetir el preflight'))
    trivial = is_trivial(domain, text)
    checks = environment_checks(previews, trivial, needs)
    # A non-trivial task must not start from broken authoritatively-checked gates.
    # Keep preflight cheap when the caller explicitly disables environment probes.
    baseline = []
    if not trivial and not pending and not error and not envcheck.blocking_failures(checks) \
            and env_value('HARNESS_PREFLIGHT_CHECKS') != 'off':
        try:
            baseline = baseline_gates(domain, text)
            failed = next((gate for gate in baseline if gate.get('status') != 'PASS'), None)
            if failed:
                warnings.append(warning('baseline-gates', 'blocking',
                                        'Gate de baseline no válido: ' + ' '.join(failed.get('command', [])) +
                                        ' (' + str(failed.get('status')) + '), log=' + str(failed.get('log')),
                                        'Resolver el fallo en la rama base o aislarlo antes de crear una tarea'))
        except Exception as exc:
            warnings.append(warning('baseline-gates', 'blocking',
                                    'No se pudo establecer baseline: ' + type(exc).__name__,
                                    'Resolver la ejecución del gate antes de continuar'))
    result = {'mode': 'direct' if trivial else 'harness',
              'modeReason': ('tarea chica (spec corta, sin unidades, plan de una sola cadena): hacela directo, la cadena del Harness '
                             'cuesta más que el cambio' if trivial else 'tarea extensa o de riesgo: el Harness reparte unidades en paralelo'),
              'ready': not pending and not any(w['severity'] == 'blocking' for w in warnings) and not envcheck.blocking_failures(checks),
              'recommendedWorkers': workers, 'workerRationale': rationale, 'plan': previews, 'questions': pending,
              'answered': [q['id'] for q in raised if q['id'] in answers], 'answers': answers,
              'warnings': warnings, 'checks': checks, 'baseline': [
                  {'command': row.get('command'), 'status': row.get('status'), 'log': row.get('log'),
                   'cached': row.get('cached', False)} for row in baseline],
              'lessons': lessons_for(domain, previews)}
    if fix:
        result['fixed'] = fixed
    result['receipt'] = write_receipt(domain, text, result).relative_to(ROOT).as_posix()
    return result


def parse_answers(raw):
    answers = {}
    for item in re.split(r',(?=[A-Za-z0-9_-]+=)', raw):
        key, sep, value = item.partition('=')
        if not sep or not re.fullmatch(r'[A-Za-z0-9_-]+', key.strip()):
            raise UsageError('--answers/--answer requieren el formato id=respuesta')
        answers[key.strip()] = value.strip()
    return answers


def parse_args(args):
    rest, options, words, index = list(args), {'file': None, 'answers': {}, 'fix': False, 'checksOnly': False, 'needs': None}, [], 0
    while index < len(rest):
        arg = rest[index]
        if arg in ('--file', '--answers', '--answer', '--needs'):
            index += 1
            if index >= len(rest):
                raise UsageError(arg + ' requiere un valor')
            if arg == '--file':
                options['file'] = rest[index]
            elif arg == '--needs':
                try:
                    options['needs'] = envcheck.parse_needs(rest[index])
                except ValueError as error:
                    raise UsageError(str(error)) from None
            else:
                options['answers'].update(parse_answers(rest[index]))
        elif arg == '--fix':
            options['fix'] = True
        elif arg == '--checks-only':
            options['checksOnly'] = True
        elif arg == '--json':
            pass  # JSON is the only output format
        elif arg.startswith('--'):
            raise UsageError('Opción inválida para preflight: ' + arg)
        else:
            words.append(arg)
        index += 1
    if options['checksOnly']:
        return options
    if not words:
        raise UsageError('Uso: harness:preflight <dominio|auto> <tarea>|--file f [--answers id=resp,...] [--fix] [--needs db,go] [--json] | --checks-only [--needs db,go]')
    options['domain'] = words[0]
    options['text'] = ' '.join(words[1:])
    if options['file']:
        try:
            options['text'] = Path(options['file']).read_text(encoding='utf-8-sig')
        except OSError as error:
            raise UsageError('No se pudo leer --file: ' + str(error)) from None
    if not options['text'].strip():
        raise UsageError('preflight requiere el texto de la tarea o --file')
    return options


def main(args):
    options = parse_args(args)
    if options['checksOnly']:
        result = run_checks_only(options['needs'])
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result['ready'] else 1
    result = run(options['domain'], options['text'], options['answers'], options['fix'], options['needs'])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ready'] else 1
