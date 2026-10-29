#!/usr/bin/env python3
"""Direct debugging CLI; normal use goes through the managed Node bootstrap."""
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from core.config import ROOT, H, dumps, policy, gate_timeout_ms, UsageError
from core.security import redact, orchestrator_guard


def load_env():
    file = H / '.env'
    if not file.exists() or os.environ.get('HARNESS_IGNORE_ENV_FILE') == '1':
        return
    # Node bootstrap uses native loadEnvFile; direct debugging supports simple KEY=VALUE configuration.
    for line in file.read_text(encoding='utf-8-sig').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            raise ValueError('Malformed .harness/.env configuration')
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"\''))


def print_json(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main(command, args):
    from core import tasks, context, check
    if command == 'check':
        check.check()
    elif command in ['context', 'tokens']:
        if '--domain' in args:
            name = args[args.index('--domain')+1]
        else:
            name = args[0] if args else None
        if name is None:
            from core.verification import verify_plan
            plan = verify_plan(targeted_checks=False)  # only the domain is needed: never run `go list` to infer it
            name = plan['domains'][0] if plan['domains'] else 'repo'
        ctx = context.context(name, ' '.join(args[1:]) if command == 'context' else '')
        print_json(ctx if command == 'context' else {'domain': ctx['domain'], 'estimatedTokens': ctx['estimatedTokens'],
            'budget': ctx['tokenBudget'], 'withinBudget': True, 'reduced': ctx['reduced'], 'omitted': ctx['omitted'], 'estimateOnly': True})
    elif command == 'run':
        enabled = [d['domain'] for d in context.manifests()['domains']] + ['auto']
        environ = dict(os.environ)
        bypass = '--no-preflight' in args
        if bypass:
            args = [a for a in args if a != '--no-preflight']
            environ['HARNESS_PREFLIGHT'] = 'off'
        if args and args[0] in enabled:
            if len(args) < 2:
                raise UsageError('Uso: harness:run <domain|auto> <task>|--file <path>')
            from core import preflight
            if args[1] == '--file':
                if len(args) != 3:
                    raise UsageError('Uso: harness:run <domain|auto> --file <path>')
                text = Path(args[2]).read_bytes().decode('utf-8')
                preflight.require_receipt(args[0], text, environ)
                created = tasks.make_task(args[0], text, 'file:' + args[2])
                if bypass:
                    from core.state import log
                    log('audit', created['id'], 'preflight-bypassed', {'reason': '--no-preflight'})
                print_json(created)
            else:
                text = ' '.join(args[1:])
                preflight.require_receipt(args[0], text, environ)
                created = tasks.make_task(args[0], text)
                if bypass:
                    from core.state import log
                    log('audit', created['id'], 'preflight-bypassed', {'reason': '--no-preflight'})
                print_json(created)
        else:
            from core.runner import compact_run
            if not args:
                raise UsageError('Uso: harness:run <command> [args]')
            # Known disabled domains remain actionable errors, never commands.
            if any(d['domain'] == args[0] for d in context.manifests(True)['domains']):
                context.get_domain(args[0])
            result = compact_run(args[0], args[1:])
            print_json(result)
            return result['exit']
    elif command == 'execute':
        from core.lifecycle import execute
        task = execute(args[0])
        print_json(task)
        return 0 if task['status'] == 'completed' else 1
    elif command == 'plan':
        if not args or args[0] not in [d['domain'] for d in context.manifests()['domains']] + ['auto']:
            raise UsageError('Uso: harness:plan <domain|auto> <task>|--file <path>')
        if len(args) == 3 and args[1] == '--file':
            text = Path(args[2]).read_bytes().decode('utf-8')
        elif len(args) >= 2 and args[1] != '--file':
            text = ' '.join(args[1:])
        else:
            raise UsageError('Uso: harness:plan <domain|auto> <task>|--file <path>')
        print_json(tasks.preview(args[0], text))
    elif command == 'estimate':
        if not args or args[0] not in [d['domain'] for d in context.manifests()['domains']] + ['auto']:
            raise UsageError('Uso: harness:estimate <domain|auto> <task>|--file <path>')
        if len(args) == 3 and args[1] == '--file':
            text = Path(args[2]).read_bytes().decode('utf-8')
        elif len(args) >= 2 and args[1] != '--file':
            text = ' '.join(args[1:])
        else:
            raise UsageError('Uso: harness:estimate <domain|auto> <task>|--file <path>')
        print_json([{'domain': p['domain'], 'risk': p['risk'], 'budget': p['budget'], 'estimate': p['estimate']}
                    for p in tasks.preview(args[0], text)])
    elif command == 'migrations':
        if args != ['next']:
            raise UsageError('Uso: harness:migrations (migrations next)')
        from core.envcheck import migration_report
        report = migration_report(ROOT)
        print_json(report)
        return 1 if report['collisions'] else 0
    elif command == 'preflight':
        from core import preflight
        return preflight.main(args)
    elif command == 'cache':
        from core import rediscache
        return rediscache.main(args)
    elif command == 'resume':
        from core import checkpoint
        return checkpoint.main(args)
    elif command == 'lessons':
        from core import lessons
        return lessons.main(args)
    elif command == 'bench':
        from core import bench
        return bench.main(args)
    elif command == 'metrics':
        if len(args) != 1:
            raise UsageError('Uso: harness:metrics <task-id>')
        task = tasks.load_task(args[0])
        print_json({'id': task['id'], 'status': task['status'], 'plan': task.get('plan'), 'metrics': task.get('metrics')})
    elif command == 'source':
        print_json(tasks.expand_source(*args))
    elif command == 'status':
        print_json(tasks.load_task(args[0]))
    elif command == 'list':
        print_json(tasks.list_tasks())
    elif command == 'abort':
        task = tasks.abort_task(args[0], ' '.join(args[1:]))
        print_json({'id': task['id'], 'status': task['status'], 'aborted': task['aborted']})
    elif command == 'retry':
        task = tasks.retry_task(args[0], ' '.join(args[1:]))
        print_json({'id': task['id'], 'status': task['status'], 'reason': ' '.join(args[1:]) or 'operator retry'})
    elif command == 'dispatch':
        for task in tasks.dispatch():
            print_json(task)
    elif command == 'path-check':
        from core.security import allowed_path, PATH_RULE
        agent = next((a for a in context.manifests()['agents'] if a['name'] == args[1]), None)
        allowed = allowed_path(args[2], context.get_domain(args[0]), agent)
        print_json({'allowed': allowed, 'semantics': PATH_RULE})
        return 0 if allowed else 1
    elif command == 'agents-doc':
        check.agents_doc(True)
        print('Agent contracts regenerated')
    elif command == 'verify':
        from core import verification
        flags = {'--full', '--plan', '--keep-going', '--fast', '--explain', '--json'}
        explicit, rest, i = None, [], 0
        while i < len(args):
            if args[i] == '--base' or args[i].startswith('--base='):
                if explicit is not None:
                    raise UsageError('--base se indica una sola vez')
                inline = '=' in args[i]
                explicit = args[i].split('=', 1)[1] if inline else args[i + 1] if i + 1 < len(args) else ''
                i += 1 if inline else 2
                if not explicit:
                    raise UsageError('--base requiere una ref')
                if explicit.startswith('-'):
                    raise UsageError('--base requiere una ref, no la opción ' + explicit)
            else:
                rest.append(args[i])
                i += 1
        args = rest
        unknown = [a for a in args if a.startswith('--') and a not in flags]
        if unknown:
            raise UsageError('Opción inválida para verify: ' + ', '.join(unknown))
        if ('--explain' in args or '--json' in args) and '--plan' not in args:
            raise UsageError('--explain y --json sólo se permiten con --plan')
        if '--full' in args and '--fast' in args:
            raise UsageError('--full y --fast son incompatibles: --full es la verificación autoritativa y --fast sólo corre checks dirigidos')
        if '--plan' in args and ('--keep-going' in args or '--fast' in args):
            raise UsageError('--plan no ejecuta checks; --keep-going y --fast no aplican')
        name = next((a for a in args if not a.startswith('--')), None)
        from core.changes import resolve_base
        plan = verification.verify_plan(name, '--full' in args, base=resolve_base(explicit))
        if '--plan' in args:
            if '--explain' in args:
                print(verification.render_plan(plan))
            else:
                print_json(plan)
            return 0
        summary = verification.run_plan(plan, gate_timeout_ms(), keep_going='--keep-going' in args, fast='--fast' in args,
                                        emit=lambda r: print_json({k: r[k] for k in ['command', 'tier', 'status', 'exit', 'durationMs', 'log', 'skipReason', 'error', 'stdoutTail', 'stderrTail'] if k in r}))
        print(verification.render_report(summary))
        return verification.EXIT[summary['status']]
    elif command == 'report':
        from core import verification
        summary = verification.last_summary()
        if summary is None:
            print('No verification summary yet; run pnpm harness:verify', file=sys.stderr)
            return 1
        stale = verification.staleness(summary)
        print(verification.render_report(summary, stale))
        if summary['status'] != 'PASS':
            return verification.EXIT[summary['status']]
        # A PASS only counts when it is authoritative and describes the current HEAD and changed files.
        return verification.EXIT['STALE'] if stale else verification.EXIT['FAST'] if not summary.get('authoritative') else 0
    elif command == 'ci-gaps':
        from core import cigaps
        return cigaps.main(args)
    elif command == 'hygiene':
        from core import hygiene
        return hygiene.main(args)
    elif command == 'telemetry':
        from core import telemetry
        return telemetry.main(args)
    elif command == 'flaky':
        from core import flaky
        return flaky.main(args)
    elif command == 'progress':
        from core import progress
        return progress.main(args)
    elif command == 'doctor':
        from core.doctorflight import doctor
        domain, spec = None, None
        if args:
            if len(args) != 3 or args[1] != '--file':
                raise UsageError('Uso: harness:doctor [<domain|auto> --file <spec>]')
            domain, spec = args[0], Path(args[2]).read_text(encoding='utf-8')
        rows = doctor(domain, spec)
        print_json(rows)
        return 1 if any(r['status'] == 'FAIL' for r in rows) else 0
    elif command == 'index':
        print_json(context.context_index())
    elif command == 'changes':
        from core.changes import changed_files
        print_json(changed_files())
    elif command == 'smoke-host':
        from core.smoke import smoke_host
        result = smoke_host(args[0])
        print_json(result)
        return 0 if result['status'] == 'passed' else 1
    elif command == 'guard':
        try:
            permitted = orchestrator_guard(json.load(sys.stdin))
        except Exception:
            permitted = False
        if not permitted:
            print('RedEvent Harness: host product writes denied; delegate within contract', file=sys.stderr)
        return 0 if permitted else 2
    elif command == 'test':
        import subprocess
        # Fallbacks for the suites (an explicit value still wins): never inherit the operator's .harness/.env, do not require a
        # preflight receipt for fixture tasks, and keep the handoffs of completed tasks that lifecycle tests inspect.
        for name, value in (('HARNESS_IGNORE_ENV_FILE', '1'), ('HARNESS_PREFLIGHT', 'off'), ('HARNESS_KEEP_ARTIFACTS', '1')):
            os.environ.setdefault(name, value)
        code = subprocess.call([sys.executable, '-I', '-S', '-B', '-m', 'unittest', 'discover', '-s', str(H / 'tests/python'), '-v'])
        if code:
            return code
        from core.runner import spawn_run
        # lifecycle.test.mts and parallel.test.mts assert on real wall-clock timeouts, kill
        # deadlines and worker-overlap windows (Date.now()/HARNESS_*_TIMEOUT_MS budgets):
        # CPU-count concurrency would make sibling contention flip those deadlines, so they
        # stay at concurrency=1. The rest has no timing-sensitive assertions and is safe to
        # run with higher concurrency, bounded (not unlimited) by available cores. Discovered
        # dynamically (not hardcoded) so a new test file is never silently left unscheduled.
        TIMING_SENSITIVE_NAMES = {'lifecycle.test.mts', 'parallel.test.mts'}
        all_files = sorted(str(f) for f in (H / 'tests').glob('*.test.mts'))
        timing_sensitive = [f for f in all_files if Path(f).name in TIMING_SENSITIVE_NAMES]
        parallel_safe = [f for f in all_files if Path(f).name not in TIMING_SENSITIVE_NAMES]
        workers = max(1, min(4, os.cpu_count() or 1))
        combined_out, code = '', 0
        for concurrency, files in ((str(workers), parallel_safe), ('1', timing_sensitive)):
            if not files:
                continue
            run = spawn_run('node', ['--test', '--test-concurrency=' + concurrency, *files],
                             {'trusted': True, 'timeoutMs': gate_timeout_ms()})
            combined_out += run['out'] + run['err']
            if run['code']:
                code = run['code']
        print(combined_out)
        return code
    elif command == 'rpc':
        from core.rpc import invoke
        payload = json.load(sys.stdin)
        print_json(invoke(payload['method'], payload.get('args', [])))
    else:
        raise UsageError('Comando inválido: ' + command)
    return 0


if __name__ == '__main__':
    try:
        if os.environ.get('HARNESS_HOOK_INPUT') != '1':
            load_env()
        raw = sys.argv[2:]
        # Consume pnpm's initial separator only; retain flags inside a runner command.
        args = raw[1:] if raw and raw[0] == '--' else raw
        raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else '', args))
    except UsageError as error:
        print('[harness] ' + redact(str(error)), file=sys.stderr)
        raise SystemExit(2)
    except Exception as error:
        if os.environ.get('HARNESS_DEBUG') == '1':
            import traceback
            print(redact(traceback.format_exc()), file=sys.stderr)
        else:
            print('[harness] ' + redact(str(error)), file=sys.stderr)
        raise SystemExit(1)
