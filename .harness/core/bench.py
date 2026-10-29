"""Reproducible sequential-vs-parallel benchmark with a simulated host (no tokens, no network, no provider quota).

Every scenario runs in a throw-away Git repository holding a copy of this Harness, once with `HARNESS_MAX_WORKERS=1`
(the historical executor) and once per requested worker count. Wall time is measured from outside the Harness; the
simulated agents also log start/end so the *writer phase* speedup is measured independently of gates and review.

    pnpm harness:bench                       # table
    pnpm harness:bench -- --json --out r.json
    pnpm harness:bench -- --assert           # exit 1 unless parallelism pays off as designed (used by verify-enterprise)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from .config import H, ROOT, UsageError

HARNESS = Path(__file__).resolve().parents[1]
SIM = HARNESS / 'tests' / 'fixtures' / 'sim-agent.cjs'
GIT_ENV = {'GIT_CONFIG_COUNT': '2', 'GIT_CONFIG_KEY_0': 'maintenance.auto', 'GIT_CONFIG_VALUE_0': 'false',
           'GIT_CONFIG_KEY_1': 'gc.auto', 'GIT_CONFIG_VALUE_1': '0', 'GIT_CONFIG_NOSYSTEM': '1'}

# name -> unit lines (agent=documentation writers on disjoint docs/ paths); weights drive the planner's estimate only.
def scenarios(units, weight):
    lines = lambda items: '\n'.join(f'unit: {i} | agent=documentation | owns=docs/{i}/** | weight={weight}' + (f' | after={",".join(a)}' if a else '') for i, a in items)
    names = [f'u{n}' for n in range(units)]
    return {
        'independent': lines([(n, []) for n in names]),
        'diamond': lines([('root', []), ('left', ['root']), ('right', ['root']), ('join', ['left', 'right'])]),
        'chain': lines([(n, [names[i - 1]] if i else []) for i, n in enumerate(names)]),
    }


def make_repo(directory):
    shutil.copytree(HARNESS / 'manifests', directory / '.harness/manifests')
    shutil.copytree(HARNESS / 'core', directory / '.harness/core', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(HARNESS / 'lib', directory / '.harness/lib')
    for name in ['cli.py', 'bootstrap.mjs', 'core.mjs', 'README.md']:
        shutil.copy(HARNESS / name, directory / '.harness' / name)
    shutil.copytree(ROOT / '.codex/skills', directory / '.codex/skills')
    for name in ['tasks/inbox', 'tasks/active', 'tasks/completed', 'tasks/failed', 'state', 'handoffs', 'runtime', 'logs/execution', 'logs/errors', 'logs/audit', 'logs/completed']:
        (directory / '.harness' / name).mkdir(parents=True, exist_ok=True)
    domains = directory / '.harness/manifests/domains.json'
    data = json.loads(domains.read_text())
    for domain in data['domains']:
        domain['verification'] = [['node', '-e', 'process.exit(0)']]
    domains.write_text(json.dumps(data))
    (directory / '.gitignore').write_text('.harness/runtime/*\n.harness/tasks/*/*\n.harness/handoffs/*\n.harness/state/*\n.harness/logs/*/*\n__pycache__/\n')
    env = {**os.environ, **GIT_ENV}
    for args in (['init', '-q'], ['add', '-A'], ['-c', 'user.name=bench', '-c', 'user.email=bench@example.test', 'commit', '-qm', 'bench']):
        subprocess.run(['git', *args], cwd=directory, env=env, check=True, capture_output=True)


def harness(directory, args, env):
    # The throw-away repository's synthetic task has no operator spec to review, so the mandatory preflight receipt does
    # not apply to it; without this, `run` refused the task and the benchmark failed before measuring anything.
    return subprocess.run([sys.executable, '-I', '-S', '-B', '-X', 'utf8', str(directory / '.harness/cli.py'), *args], cwd=directory,
                          env={**os.environ, **GIT_ENV, 'HARNESS_HOST': '', 'HARNESS_PREFLIGHT': 'off', **env}, capture_output=True, text=True)


def run_once(directory, text, workers, ms):
    shutil.rmtree(directory / 'docs', ignore_errors=True)
    subprocess.run(['git', 'checkout', '-q', '--', '.'], cwd=directory, env={**os.environ, **GIT_ENV}, capture_output=True)
    state = Path(tempfile.mkdtemp(prefix='bench-sim-'))
    spec, log = state / 'spec.json', state / 'sim.log'
    spec.write_text(json.dumps({'*': {'ms': ms}}))
    env = {'HARNESS_AGENT_COMMAND': f'"{shutil.which("node")}" "{SIM}"', 'SIM_SPEC': str(spec), 'SIM_LOG': str(log), 'SIM_STATE': str(state / 'st'),
           'HARNESS_WORKTREE_DIR': str(state / 'wt'), 'HARNESS_MAX_WORKERS': str(workers), 'HARNESS_HOST_LIMIT': str(workers),
           'HARNESS_ROLE_LIMITS': f'documentation={workers}', 'HARNESS_MAX_RETRIES': '0'}
    created = harness(directory, ['run', 'docs', 'Crear la documentación de la plataforma\n\n' + text + '\n'], env)
    if created.returncode:
        raise RuntimeError('plan failed: ' + created.stderr[-400:])
    task = json.loads(created.stdout)
    started = time.monotonic()
    executed = harness(directory, ['execute', task['id']], env)
    wall = round((time.monotonic() - started) * 1000)
    if executed.returncode:
        raise RuntimeError('execute failed: ' + (executed.stderr + executed.stdout)[-600:])
    final = json.loads(executed.stdout)
    events = [json.loads(line) for line in log.read_text().splitlines() if line]
    writers = [e for e in events if e['node'].startswith('documentation-')]
    phase = (max(e['at'] for e in writers if e['event'] == 'end') - min(e['at'] for e in writers if e['event'] == 'start')) if writers else 0
    shutil.rmtree(state, ignore_errors=True)
    return {'workers': workers, 'wallMs': wall, 'writerPhaseMs': phase, 'status': final['status'], 'plan': (final.get('plan') or {}).get('parallel'),
            'peakConcurrency': final['metrics'].get('peakConcurrency'), 'mode': final['metrics'].get('mode'),
            'harnessDurationMs': final['metrics'].get('durationMs'), 'criticalPathMs': final['metrics'].get('criticalPathMs'),
            'integrationMs': final['metrics'].get('integrationMs', 0), 'queueMs': final['metrics'].get('queueMs', 0)}


def benchmark(units=4, ms=1000, workers=(4,), weight=2):
    if not shutil.which('node'):
        raise RuntimeError('the simulated host needs `node` on PATH')
    results = []
    with tempfile.TemporaryDirectory(prefix='redevent-bench-') as temporary:
        directory = Path(temporary) / 'repo'
        directory.mkdir()
        make_repo(directory)
        for name, text in scenarios(units, weight).items():
            sequential = run_once(directory, text, 1, ms)
            row = {'scenario': name, 'units': units, 'agentMs': ms, 'sequential': sequential, 'parallel': []}
            for count in workers:
                parallel = run_once(directory, text, count, ms)
                parallel['speedup'] = round(sequential['wallMs'] / max(parallel['wallMs'], 1), 2)
                parallel['writerPhaseSpeedup'] = round(sequential['writerPhaseMs'] / max(parallel['writerPhaseMs'], 1), 2)
                row['parallel'].append(parallel)
            results.append(row)
    return {'schemaVersion': 1, 'host': 'simulated (tests/fixtures/sim-agent.cjs): no tokens, no network', 'python': sys.version.split()[0],
            'platform': sys.platform, 'cpuCount': os.cpu_count(), 'results': results}


def verdicts(report):
    """The properties the design promises, evaluated on measured numbers."""
    failures = []
    for row in report['results']:
        best = max(row['parallel'], key=lambda p: p['workers'])
        if row['scenario'] == 'independent':
            if best['writerPhaseSpeedup'] < min(best['workers'], row['units']) * 0.6:
                failures.append(f'independent: writer phase speedup {best["writerPhaseSpeedup"]} below 60% of the ideal {min(best["workers"], row["units"])}')
            if best['speedup'] < 1.25:
                failures.append(f'independent: end-to-end speedup {best["speedup"]} < 1.25')
            if (best['peakConcurrency'] or 0) < min(best['workers'], row['units']):
                failures.append(f'independent: peak concurrency {best["peakConcurrency"]} below {min(best["workers"], row["units"])}')
        if row['scenario'] == 'chain' and best['wallMs'] > row['sequential']['wallMs'] * 1.35:
            failures.append(f'chain: coordination overhead too high ({best["wallMs"]}ms vs {row["sequential"]["wallMs"]}ms sequential)')
        if row['scenario'] == 'diamond' and ((best['peakConcurrency'] or 0) < 2 or best['writerPhaseSpeedup'] < 1.05):
            failures.append(f'diamond: the two middle units did not overlap (peak {best["peakConcurrency"]}, writer phase speedup {best["writerPhaseSpeedup"]})')
        if any(p['status'] != 'completed' for p in row['parallel']) or row['sequential']['status'] != 'completed':
            failures.append(f'{row["scenario"]}: a run did not complete')
    return failures


def render(report):
    lines = ['Harness benchmark (simulated host, ' + report['platform'] + ', ' + str(report['cpuCount']) + ' CPU)',
             f'{"scenario":<12}{"workers":>8}{"wall ms":>10}{"writers ms":>12}{"speedup":>9}{"writers x":>10}{"peak":>6}']
    for row in report['results']:
        seq = row['sequential']
        lines.append(f'{row["scenario"]:<12}{1:>8}{seq["wallMs"]:>10}{seq["writerPhaseMs"]:>12}{"1.00":>9}{"1.00":>10}{seq["peakConcurrency"] or 1:>6}')
        for p in row['parallel']:
            lines.append(f'{"":<12}{p["workers"]:>8}{p["wallMs"]:>10}{p["writerPhaseMs"]:>12}{p["speedup"]:>9.2f}{p["writerPhaseSpeedup"]:>10.2f}{p["peakConcurrency"] or 0:>6}')
    return '\n'.join(lines)


def main(args):
    options, index = {'units': 4, 'ms': 1000, 'workers': [4], 'assert': False, 'json': False, 'out': None}, 0
    while index < len(args):
        arg = args[index]
        if arg in ('--assert', '--json'):
            options[arg[2:]] = True
        elif arg in ('--units', '--ms', '--workers', '--out'):
            index += 1
            value = args[index] if index < len(args) else ''
            if arg == '--out':
                options['out'] = value
            elif arg == '--workers':
                if not value or not all(v.isdigit() and 2 <= int(v) <= 16 for v in value.split(',')):
                    raise UsageError('--workers requiere una lista como 2,4 (cada valor entre 2 y 16)')
                options['workers'] = [int(v) for v in value.split(',')]
            else:
                if not value.isdigit() or not (2 <= int(value) <= 12 if arg == '--units' else 50 <= int(value) <= 60000):
                    raise UsageError(f'{arg} fuera de rango')
                options[arg[2:]] = int(value)
        else:
            raise UsageError('Opción inválida para bench: ' + arg)
        index += 1
    report = benchmark(options['units'], options['ms'], tuple(options['workers']))
    failures = verdicts(report)
    if options['assert'] and failures:
        # Wall-clock thresholds are sensitive to a saturated host (e.g. the full verifier running beside agents); one
        # fresh measurement separates load noise from a real regression, and both attempts stay in the report.
        first = failures
        report = benchmark(options['units'], options['ms'], tuple(options['workers']))
        failures = verdicts(report)
        report['firstAttemptFailures'] = first
        if failures:
            print('First attempt: ' + '; '.join(first), file=sys.stderr)
    report['verdict'] = {'passed': not failures, 'failures': failures}
    if options['out']:
        Path(options['out']).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2) if options['json'] else render(report) + ('\n' + '\n'.join('FAIL: ' + f for f in failures) if failures else '\nOK: parallelism pays off where it should and costs little where it cannot.'))
    return 1 if options['assert'] and failures else 0
