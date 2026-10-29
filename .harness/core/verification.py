"""Selective plans use the same change detector and domain checks as delegation.

A plan check is one explicit object: {command, tier, reason, requires}. `targeted` checks come from the dependency
graph (fast feedback); `authoritative` checks are the declared domain gates or `fullChecks`. Consumers that need a
bare argv use `argv()`; there is no second implicit format.
"""
import hashlib
import json
import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from .config import ROOT, H, UsageError, policy, now, write_json, read_json
from .context import manifests, get_domain, deduplicate
from .changes import changed_files, head, resolve_base
from .security import matches_path, redact
from .routing import risk as risk_of
from . import impact, cigaps, gatecache, gatedag

PASS, FAIL, SKIPPED, NOT_RUN = 'PASS', 'FAIL', 'SKIPPED_ENVIRONMENT', 'NOT_RUN'
NOT_IMPACTED = 'SKIPPED_NOT_IMPACTED'  # declared gate that no changed file reaches: never a pass, never PARTIAL or FAIL
EXIT = {'PASS': 0, 'FAIL': 1, 'USAGE': 2, 'PARTIAL': 3, 'EMPTY': 4, 'STALE': 5, 'FAST': 6}
TAIL = 2000
COVERED_BY = 'verify-enterprise.sh'
TOOL_ALIASES = {'postgres': 'psql'}
LAST = 'runtime/verify-last.json'
OPERATIONAL = ('.harness/tasks/', '.harness/state/', '.harness/handoffs/', '.harness/logs/', '.harness/runtime/')
ENTERPRISE_FULL = ('--security', '--full', '')
PURE_NODE_SCRIPTS = ('agent-config:check',)


def argv(item):
    return list(item['command'])


def enterprise_mode(command):
    """Mode flag of a local `verify-enterprise.sh` invocation ('' = script default, i.e. full), or None for other commands."""
    index = 1
    if command[:1] != ['bash'] or len(command) < 2 or not command[1].endswith('verify-enterprise.sh') or command[1].endswith('docker-verify-enterprise.sh'):
        return None
    return command[index + 1] if len(command) > index + 1 else ''


def requires_for(command):
    """Tools a check needs before it can run. Declared up front so a gap is SKIPPED_ENVIRONMENT, never inferred."""
    name = command[0] if command else ''
    needs = [name] if name in ['pnpm', 'go', 'docker', 'bash', 'gofmt'] else []
    script = ' '.join(command[1:])
    if name == 'pnpm' and not any(a.startswith('harness:') or a in PURE_NODE_SCRIPTS for a in command[1:]):
        needs = impact.PNPM
    mode = enterprise_mode(command)
    if mode is not None:
        # golangci-lint/govulncheck are not prerequisites: the script records their skips in its structured report
        # (read below as PARTIAL with the named steps), so a missing linter never discards the checks it covers.
        needs = ['bash', 'go', 'pnpm', 'node_modules']
    if 'docker-verify-enterprise.sh' in script:
        needs = ['bash', 'docker']
    return needs


def authoritative(command, reason):
    return {'command': list(command), 'tier': 'authoritative', 'reason': reason, 'requires': requires_for(command)}


def tool_status(name, cache=None, spawn=None):
    """(available, reason). Only ever evaluated before a check runs, never from a check's own exit code."""
    cache = {} if cache is None else cache
    if name in cache:
        return cache[name]
    binary = TOOL_ALIASES.get(name, name)
    if name == 'node_modules':
        result = (True, '') if (ROOT / 'node_modules').is_dir() else (False, 'node_modules is not installed (run pnpm install)')
    elif not shutil.which(binary):
        result = (False, f'{name} is not installed or not on PATH')
    elif name == 'docker':
        from .runner import spawn_run
        probe = (spawn or spawn_run)('docker', ['info'], {'trusted': True, 'timeoutMs': 15000, 'persist': False})
        result = (True, '') if probe['code'] == 0 else (False, 'docker daemon is not reachable (docker info exit ' + str(probe['code']) + ')')
    else:
        result = (True, '')
    cache[name] = result
    return result


def missing_tools(item, cache=None, spawn=None):
    reasons = [reason for ok, reason in (tool_status(t, cache, spawn) for t in item.get('requires', [])) if not ok]
    return '; '.join(reasons)


def report_dir():
    configured = os.environ.get('REDEVENT_VERIFY_REPORT_DIR')
    return (ROOT / configured) if configured else ROOT / '.artifacts/verify-enterprise'


KEEP_RUNS = 5


def prune_runs(parent, current=None, keep=KEEP_RUNS):
    """Keeps the `keep` most recent `run-*` report directories directly under `parent` (the current run always among them).
    Only real directories with that prefix are touched: symlinks are neither followed nor removed, nothing outside `parent`."""
    try:
        if parent.is_symlink() or not parent.is_dir():
            return []
        runs = [e for e in parent.iterdir() if e.name.startswith('run-') and e != current and e.is_dir() and not e.is_symlink()]
        runs.sort(key=lambda e: (e.stat().st_mtime, e.name), reverse=True)
        removed = []
        for old in runs[max(keep - (1 if current else 0), 0):]:
            shutil.rmtree(old, ignore_errors=True)
            removed.append(old.name)
        return removed
    except OSError:
        return []  # housekeeping never fails a verification


def enterprise_report(mode, not_before, directory=None, expected_sha=None):
    """(skipped step names, error) from the structured verification-report.json that verify-enterprise.sh writes itself.
    Nothing is inferred from logs; a missing, stale (older than this run), foreign-mode, foreign-commit or inconsistent
    report is an error."""
    file = (directory or report_dir()) / 'verification-report.json'
    try:
        if file.stat().st_mtime < not_before - 2:
            return [], 'verification-report.json predates this run (' + str(file) + ')'
        report = json.loads(file.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        return [], 'verification-report.json missing or unreadable (' + str(file) + '): ' + type(error).__name__
    summary = report.get('summary') if isinstance(report, dict) else None
    checks = report.get('checks') if isinstance(report, dict) else None
    ints = isinstance(summary, dict) and all(isinstance(summary.get(k), int) and not isinstance(summary.get(k), bool) for k in ['pass', 'fail', 'skip'])
    if not ints or not isinstance(checks, list) or not all(isinstance(c, dict) for c in checks):
        return [], 'verification-report.json has an invalid structure'
    expected = mode.lstrip('-') or 'full'
    if report.get('mode') != expected:
        return [], f'verification-report.json is for mode {report.get("mode")!r}, expected {expected!r}'
    sha = (report.get('git') or {}).get('sha') if isinstance(report.get('git'), dict) else None
    if expected_sha and sha != expected_sha:
        return [], f'verification-report.json is for commit {sha!r}, expected HEAD {expected_sha!r}'
    skipped = [str(c.get('name')) for c in checks if c.get('status') == 'SKIP']
    if summary['skip'] != len(skipped) or summary['fail']:
        return [], 'verification-report.json is inconsistent (summary does not match its checks)'
    return skipped, None


def tails(run):
    """Bounded, redacted tails per stream: a long stdout never pushes stderr out of the record."""
    return {'stdoutTail': redact(str(run['out']).strip()[-TAIL:]), 'stderrTail': redact(str(run['err']).strip()[-TAIL:])}


def execute_check(item, timeout_ms, cache=None, spawn=None):
    """Run one check; failure semantics are exit code (plus failOnOutput for list-style tools such as gofmt -l).
    verify-enterprise.sh is the only check whose skips are read: from its own structured report, never from logs.
    Each enterprise run writes into its own report directory, so no earlier run's report can be mistaken for this one."""
    from .runner import spawn_run
    command = argv(item)
    missing = missing_tools(item, cache, spawn)
    base = {'command': command, 'tier': item['tier'], 'reason': item['reason'], 'requires': item.get('requires', [])}
    if missing:
        return {**base, 'status': SKIPPED, 'exit': None, 'durationMs': 0, 'log': None, 'skipReason': missing, 'stdoutTail': '', 'stderrTail': ''}
    began = time.time()
    mode = enterprise_mode(command)
    options = {'trusted': True, 'timeoutMs': timeout_ms}
    directory = None
    if mode is not None:
        directory = report_dir() / ('run-' + uuid.uuid4().hex[:12])
        prune_runs(directory.parent, directory)
        options['env'] = {'REDEVENT_VERIFY_REPORT_DIR': str(directory)}
    run = (spawn or spawn_run)(command[0], command[1:], options)
    failed = bool(run['code']) or (item.get('failOnOutput') and bool(run['out'].strip()))
    result = {**base, 'status': FAIL if failed else PASS, 'exit': run['code'] if run['code'] or not failed else 1,
              'durationMs': run['durationMs'], 'log': run.get('log'), 'skipReason': None, **tails(run)}
    if mode is not None and not failed:
        skipped, error = enterprise_report(mode, began, directory, head())
        if error:
            # The real exit code of the process is kept; the report problem is a separate field and the status fails closed.
            result.update(status=FAIL, exit=run['code'], error=redact(error))
        elif skipped:
            result.update(status=SKIPPED, skipReason='verify-enterprise.sh omitió ' + str(len(skipped)) + ' paso(s): ' + '; '.join(skipped))
    return result


def overall(results):
    # A failure whose every failing test is quarantined (and non-critical) is reported separately and does not fail the run.
    if any(r['status'] == FAIL and not r.get('quarantined') for r in results):
        return 'FAIL'
    return 'PARTIAL' if any(r['status'] == SKIPPED for r in results) else 'PASS'


def not_run_result(item, reason):
    return {'command': argv(item), 'tier': item['tier'], 'reason': item['reason'], 'requires': item.get('requires', []),
            'status': NOT_RUN, 'exit': None, 'durationMs': 0, 'log': None, 'stdoutTail': '', 'stderrTail': '', 'skipReason': reason}


def with_options(spawn, cancel, env):
    """Wraps a spawn function so every process of a gate sees the run's cancel event and the gate's isolation env.
    Returns `spawn` untouched when there is nothing to add (sequential runs stay byte-compatible)."""
    if cancel is None and not env:
        return spawn

    def wrapped(cmd, args, options=None):
        from . import runner
        options = dict(options or {})
        if cancel is not None:
            options['cancel'] = cancel
        if env:
            options['env'] = {**(options.get('env') or {}), **env}
        return (spawn or runner.spawn_run)(cmd, args, options)
    return wrapped


def run_gates(task, gates, timeout_ms, keep_going=False, emit=None, cancel=None, concurrency=None, spawn=None, tools=None, gate_cache=True):
    """Runs checks (plan items) and returns their results in plan order. Concurrency: argument > HARNESS_GATE_CONCURRENCY >
    policy parallel.gateConcurrency > min(4, cpu); 1 is the sequential loop. `task` (or None) only labels telemetry; callers
    such as delegation keep their own evidence logging. `gate_cache`: True = default cache (if enabled), None/False = off."""
    tools = {} if tools is None else tools
    cache = gatecache.default_cache() if gate_cache is True else gate_cache or None
    workers = gatedag.concurrency(concurrency)
    if workers > 1:
        for item in gates:
            missing_tools(item, tools, spawn)  # probe each tool once, before threads race to do it

    def execute(item, env):
        isolated = with_options(spawn, cancel, env)
        return gatecache.execute(item, lambda: execute_check(item, timeout_ms, tools, isolated), cache)
    return gatedag.run_dag(gates, execute, not_run_result, workers, keep_going, cancel, emit)


def selected(plan, fast=False, cache=None, spawn=None):
    """Checks a run executes. --fast: only `targeted`. Otherwise everything except the targeted checks that
    verify-enterprise.sh (in the same plan) already runs, as long as that verifier can actually run here: when it is
    skipped by the environment its `coveredBy` checks are kept."""
    checks = plan['checks']
    if fast:
        return [c for c in checks if c['tier'] == 'targeted']
    cache = {} if cache is None else cache
    enterprise = any(c['tier'] == 'authoritative' and enterprise_mode(argv(c)) is not None and not missing_tools(c, cache, spawn) for c in checks)
    return [c for c in checks if not (enterprise and c.get('coveredBy') == COVERED_BY)]


def generated(file):
    """Exclude transient generated files, but never conceal changes to tracked next-env.d.ts."""
    if not any(matches_path(file, pattern) for pattern in policy().get('generatedArtifacts', [])):
        return False
    if file == 'next-env.d.ts' or file.endswith('/next-env.d.ts'):
        # A tracked generated file can carry meaningful changes and must remain observable.
        try:
            tracked = subprocess.run(['git', 'ls-files', '--error-unmatch', '--', file],
                                     cwd=ROOT, capture_output=True, timeout=3)
            return tracked.returncode != 0
        except (OSError, subprocess.SubprocessError):
            return False  # Unknown Git state: fail closed.
    return True


def snapshot(base=None):
    """({'head', 'changeSet'}, {path: digest}). Harness operational state and declared generated artifacts
    (policies.json `generatedArtifacts`, e.g. *.tsbuildinfo) are excluded: they change whenever a gate runs."""
    try:
        files = [f for f in changed_files(base) if not f.startswith(OPERATIONAL) and not generated(f)]
    except ValueError:
        return {'head': None, 'changeSet': None}, {}
    digest, digests = hashlib.sha256(), {}
    for file in files:
        path = ROOT / file
        try:
            digests[file] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() and not path.is_symlink() else '-'
        except OSError:
            digests[file] = '?'
        digest.update(file.encode() + b'\0' + digests[file].encode())
    return {'head': head(), 'changeSet': {'sha256': digest.hexdigest(), 'count': len(files)}}, digests


def fingerprint(base=None):
    """HEAD plus a digest of the changed paths and their contents; None where Git is unavailable."""
    return snapshot(base)[0]


def base_ref(plan):
    return (plan.get('base') or {}).get('ref')


def covers_all_domains(plan):
    """True when the domains the plan runs are every domain the same change set would select without a domain argument."""
    if plan.get('full') or not plan.get('requestedDomain'):
        return True
    everything = verify_plan(None, files=plan['files'], targeted_checks=False)['domains']
    return set(everything) <= set(plan['domains'])


def empty_hint(plan):
    """What EMPTY means for committed changes, for the base this run actually used."""
    ref = base_ref(plan)
    if ref:
        return (f'Committed changes are measured against {describe_base(plan.get("base"))}; if that is not the branch point, '
                'rerun with another --base <ref> (e.g. pnpm harness:verify -- --base origin/qa).')
    return ('Changes already committed are not seen unless a base is given: rerun with --base <ref> '
            '(e.g. pnpm harness:verify -- --base origin/qa) or set HARNESS_BASE.')


def run_plan(plan, timeout_ms, keep_going=False, fast=False, emit=None, cancel=None, concurrency=None):
    """Executes a plan, persists the summary and returns it. Stops at the first real failure unless keep_going."""
    started, begun = now(), time.monotonic()
    current, before = snapshot(base_ref(plan))
    cache = {}
    chosen = selected(plan, fast, cache)
    results = run_gates(None, chosen, timeout_ms, keep_going, emit, cancel, concurrency, tools=cache)
    status = overall(results)
    # Outside --full a run that executed nothing verified nothing, whether the plan was empty or --fast found no targeted check.
    empty = not chosen and not plan.get('full')
    if empty:
        status = 'EMPTY'
    scoped = not covers_all_domains(plan)
    base = plan.get('base') or {'ref': None, 'source': 'local changes only'}
    summary = {'schemaVersion': 1, 'status': status, 'startedAt': started, 'durationMs': round((time.monotonic() - begun) * 1000),
               'mode': 'fast' if fast else 'full' if plan.get('full') else 'standard', 'authoritative': not fast and not scoped and not empty, 'fast': fast,
               'keepGoing': keep_going, 'risk': plan.get('risk'), 'domains': plan.get('domains', []), 'domain': plan.get('requestedDomain'),
               'base': base, **current, 'checks': results}
    quarantined = [r for r in results if r['status'] == FAIL and r.get('quarantined')]
    if quarantined:
        summary['quarantined'] = [{k: r[k] for k in ['command', 'tier', 'reason', 'exit', 'flaky'] if k in r} for r in quarantined]
    skipped_not_impacted = [{**item, 'status': NOT_IMPACTED} for item in plan.get('notImpacted', [])] if not fast else []
    if skipped_not_impacted:
        summary['notImpacted'] = skipped_not_impacted
    if plan.get('incremental'):
        summary['incremental'] = plan['incremental']
    notices = []
    if quarantined:
        notices.append('QUARANTINED: ' + str(len(quarantined)) + ' check(s) failed only on known-flaky, non-critical tests; reported separately, not counted as passed.')
    if plan.get('incremental', {}).get('escalated'):
        notices.append('ESCALATED to full verification: ' + str(plan['incremental']['reason']))
    if skipped_not_impacted:
        notices.append('INCREMENTAL: ' + str(len(skipped_not_impacted)) + ' declared gate(s) were not impacted by this change and were not run (SKIPPED_NOT_IMPACTED, not a pass).')
    if fast:
        notices.append('FAST: only targeted checks ran; this is NOT the authoritative verification.')
    if scoped:
        notices.append('SCOPED: only domain ' + str(plan.get('requestedDomain')) + ' was verified, not every domain this change selects; '
                       'this is NOT the authoritative verification (run pnpm harness:verify without a domain).')
    if any(r['status'] == NOT_RUN for r in results):
        notices.append('Run stopped at the first failure; later checks did not run.')
    if status == 'PARTIAL':
        notices.append('PARTIAL: checks were skipped because tools are missing or the verifier skipped steps; this is NOT a successful verification.')
    if empty:
        notices.append('EMPTY: ' + (f'the plan has {len(plan["checks"])} check(s) but none was executed' + (' (--fast found no targeted checks)' if fast else '')
                       if plan['checks'] else 'the plan selected no checks for the changed files') + '; this is NOT a successful verification. '
                       + empty_hint(plan))
    _, after = snapshot(base_ref(plan))
    altered = sorted(f for f in set(before) | set(after) if before.get(f) != after.get(f))
    if altered:
        summary['selfAltered'] = altered
        notices.append('SELF-ALTERED: files changed while verifying (' + ', '.join(altered[:10]) + ('…' if len(altered) > 10 else '') + '); '
                       'the saved fingerprint predates them, so the result reports STALE until you rerun.')
    if notices:
        summary['notice'] = '\n'.join(notices)
    write_json(H / LAST, summary)
    return summary


def staleness(summary):
    """Reason a saved summary no longer describes the workspace (HEAD or changed-file set differ), else None."""
    if 'head' not in summary or 'changeSet' not in summary:
        return 'the summary has no HEAD/change-set fingerprint (produced by an older Harness)'
    now_state = fingerprint((summary.get('base') or {}).get('ref'))
    if summary['head'] != now_state['head']:
        return 'HEAD changed since the last verification'
    if summary['changeSet'] != now_state['changeSet']:
        return 'the set of changed files differs from the last verification'
    return None


def last_summary():
    file = H / LAST
    return read_json(file) if file.is_file() else None


def render_report(summary, stale=None):
    lines = [f'Verification {summary["status"]} ({summary["mode"]}, {summary["durationMs"]}ms, authoritative={summary["authoritative"]})',
             'Base: ' + describe_base(summary.get('base'))]
    if stale:
        lines.append('STALE: ' + stale + '; rerun pnpm harness:verify. This result is NOT authoritative for the current workspace.')
    if summary.get('notice'):
        lines.append(summary['notice'])
    def row(r):
        return f'[{r["status"]}] ({r["tier"]}) {" ".join(r["command"])}'
    for title, statuses in [('Failures', [FAIL]), ('Skipped (environment)', [SKIPPED]), ('Not run', [NOT_RUN])]:
        rows = [r for r in summary['checks'] if r['status'] in statuses and not (r['status'] == FAIL and r.get('quarantined'))]
        if rows:
            lines.append('\n' + title)
            for r in rows:
                lines += ['  ' + row(r), '    reason: ' + r['reason']]
                if r.get('skipReason'):
                    lines.append('    why: ' + r['skipReason'])
                if r['status'] == FAIL:
                    lines.append(f'    exit={r["exit"]} log={r.get("log")}')
                    if r.get('error'):
                        lines.append('    error: ' + r['error'])
                    for title, key in [('stdout', 'stdoutTail'), ('stderr', 'stderrTail')]:
                        if r.get(key):
                            lines += ['    ' + title + ':'] + ['    | ' + t for t in r[key].splitlines()[-12:]]
    if summary.get('quarantined'):
        lines.append('\nQuarantined (known-flaky failures, reported separately; NOT passed)')
        lines += ['  ' + row({**r, 'status': 'QUARANTINED'}) for r in summary['quarantined']]
    if summary.get('notImpacted'):
        lines.append(f'\nNot impacted ({len(summary["notImpacted"])}; {NOT_IMPACTED}, not run and NOT counted as passed)')
        lines += ['  ' + row(r) + '\n    reason: ' + r['reason'] for r in summary['notImpacted']]
    passed = [r for r in summary['checks'] if r['status'] == PASS]
    if passed:
        lines.append(f'\nPassed ({len(passed)})')
        lines += ['  ' + row(r) + (' [cached, saved ' + str(r.get('savedMs', 0)) + 'ms]' if r.get('cached') else '') for r in passed]
    return '\n'.join(lines)


def describe_base(base):
    base = base or {}
    return (f'{base["ref"]} ({base.get("source")})' if base.get('ref') else str(base.get('source') or 'local changes only'))


def render_plan(plan):
    lines = [f'Plan (validated={plan["validated"]}, risk={plan.get("risk")}, domains={", ".join(plan.get("domains", [])) or "-"})',
             'Base: ' + describe_base(plan.get('base'))]
    active = selected(plan)
    if plan.get('incremental', {}).get('escalated'):
        lines.append('ESCALATED to full verification' + (' (fail-closed)' if plan['incremental'].get('failClosed') else '') + ': ' + str(plan['incremental']['reason']))
    for item in plan['checks']:
        label = item['tier'] if item in active else 'targeted, only with --fast or when verify-enterprise.sh cannot run: it already covers this'
        lines += [f'[{label}] {" ".join(argv(item))}', f'    reason: {item["reason"]}']
        if item.get('requires'):
            lines.append('    requires: ' + ', '.join(item['requires']))
    for item in plan.get('notImpacted', []):
        lines += [f'[{NOT_IMPACTED}] {" ".join(argv(item))}', f'    reason: {item["reason"]}']
    return '\n'.join(lines)


def task_verify_plan(task, files=None, risk=None):
    domain = get_domain(task['domain'])
    files = changed_files(allow_unversioned=True) if files is None else files
    scoped = [f for f in files if not any(f.casefold().startswith('.harness/' + p + '/') for p in ['tasks','state','handoffs','logs'])
              and any(matches_path(f,p) for p in domain['paths'])
              and not any(matches_path(f,p) for p in domain['exclude'])]
    return verify_plan(task['domain'], files=scoped, task=task.get('task',''), incremental=True, risk=risk)


def merge(targeted, gates):
    """Deduplicates by canonical form (`--dir X s` == `--filter ./X s`), keeping the first (targeted) occurrence."""
    names = {w['name']: d for d, w in impact.js_workspaces().items()}
    seen, out = {}, []
    for item in targeted + gates:
        key = tuple(cigaps.canonical(argv(item), '.', names))
        if key not in seen:
            seen[key] = len(out)
            out.append(item)
        elif item['command'] != out[seen[key]]['command']:
            kept = out[seen[key]]
            out[seen[key]] = {**kept, 'reason': kept['reason'] + ' [same check as ' + ' '.join(argv(item)) + ']'}
    return out


RISKS = ('LOW', 'MEDIUM', 'HIGH')


def declared_gates():
    """[(command, reason)] of every gate a full run could declare: each domain's verification plus policy fullChecks."""
    found = [(list(g), f'declared gate of domain {d["domain"]}') for d in manifests()['domains'] for g in d['verification']]
    return found + [(list(c), 'fullChecks') for c in policy()['fullChecks']]


def not_impacted(checks):
    """Declared gates the selected checks do not include. Mandatory security controls (verify-enterprise.sh --security/--full)
    are never listed as skippable: they are either selected or absent from the declaration, never 'not impacted'."""
    names = {w['name']: d for d, w in impact.js_workspaces().items()}
    seen = {tuple(cigaps.canonical(argv(c), '.', names)) for c in checks}
    found = []
    for command, why in declared_gates():
        key = tuple(cigaps.canonical(command, '.', names))
        if key in seen or enterprise_mode(command) in ENTERPRISE_FULL:
            continue
        seen.add(key)
        found.append(authoritative(command, why + '; no changed file reaches it'))
    return found


def full_plan(files, info, incremental, domains=None):
    return {'full': True, 'risk': 'HIGH', 'files': files, 'base': info, 'domains': domains if domains is not None else [d['domain'] for d in manifests()['domains']],
            'checks': merge([], [authoritative(c, 'fullChecks (' + incremental['reason'] + ')') for c in policy()['fullChecks']]), 'validated': False,
            'incremental': incremental}


def escalated(files, info, reason, fail_closed=False):
    """The full verification chosen automatically; `reason` says why and whether the analysis itself failed (fail-closed)."""
    return full_plan(files, info, {'mode': 'full', 'escalated': True, 'failClosed': fail_closed, 'reason': reason})


def claimed(file, domain):
    return any(matches_path(file, p) for p in domain['paths']) and not any(matches_path(file, p) for p in domain['exclude'])


def verify_plan(name=None, full=False, files=None, task='', targeted_checks=True, base=None, incremental=None, risk=None):
    """`base` is the (ref, source) pair from changes.resolve_base; None keeps the HARNESS_BASE-only behaviour of other consumers.
    `incremental`: None = on when the change set is detected here (files is None), as `harness:verify` does. Incremental mode
    escalates to the full verification for cross-cutting changes and FAILS CLOSED (full) when change detection or impact
    analysis fails or a changed file belongs to no declared domain; gates no change reaches are listed in `notImpacted`.
    `risk` (LOW/MEDIUM/HIGH, optional, from the risk classifier): HIGH never reduces gates, so it escalates to full."""
    ref, source = base if base else (None, None)
    auto = (files is None) if incremental is None else bool(incremental)
    declared = risk.upper() if isinstance(risk, str) and risk.upper() in RISKS else None
    info = {'ref': ref, 'source': source} if base else None
    if files is None:
        try:
            files = changed_files(ref)
        except UsageError:
            raise
        except ValueError as error:
            if not auto or full:
                raise
            return escalated([], info, 'change detection failed (' + str(error)[:120] + '); verifying everything', True)
    if full:
        return full_plan(files, info, {'mode': 'full', 'escalated': False, 'failClosed': False, 'reason': 'explicit --full'})
    domains = [get_domain(name)] if name else [d for d in manifests()['domains'] if any(claimed(f, d) for f in files)]
    # Harness state evidence is operational, not a product/runtime change requiring product gates.
    runtime_files = [f for f in files if not any(f.startswith('.harness/' + p + '/') for p in ['tasks', 'state', 'handoffs', 'logs'])]
    if not name and not runtime_files:
        domains = []
    settings = policy().get('incremental') or {}
    if auto and not name and settings.get('enabled', True):
        verdict = impact.analyze(runtime_files, ref, settings.get('escalatePaths', []))
        if not verdict['full'] and declared == 'HIGH':
            verdict = {'full': True, 'reason': 'declared risk HIGH never reduces gates', 'failClosed': False}
        unclaimed = [f for f in runtime_files if not any(claimed(f, d) for d in manifests()['domains'])]
        if not verdict['full'] and unclaimed:
            verdict = {'full': True, 'reason': unclaimed[0] + ' belongs to no declared domain (ambiguous impact)', 'failClosed': True}
        if verdict['full']:
            return escalated(files, info, verdict['reason'], verdict['failClosed'])
    classification = risk_of(runtime_files, task, name)
    gates = deduplicate([(gate, d['domain']) for d in domains for gate in d['verification']])
    sensitive_api = any(f.startswith(('apps/api/', 'docs/api/')) and any(word in f.lower() for word in ['auth', 'rbac', 'tenan', 'migration', 'identity', 'openapi']) for f in runtime_files)
    if sensitive_api or name == 'api' and classification == 'HIGH':
        gates = [g for g in gates if g[0] != ['bash', './verify-enterprise.sh', '--quick']]
        gates.append((['bash', './verify-enterprise.sh', '--security'], 'api'))
    authoritative_checks = [authoritative(g, f'declared gate of domain {d}' + (' (escalated: auth/RBAC/tenancy/migrations/OpenAPI)' if g == ['bash', './verify-enterprise.sh', '--security'] else '')) for g, d in gates]
    try:
        targeted = impact.targeted_checks(runtime_files, ref) if runtime_files and targeted_checks else []
    except (ValueError, OSError) as error:
        if not auto or name:
            raise
        return escalated(files, info, 'impact analysis failed (' + type(error).__name__ + ': ' + str(error)[:120] + '); verifying everything', True)
    merged = merge(targeted, authoritative_checks)
    plan = {'full': False, 'risk': classification, 'files': files, 'base': info, 'requestedDomain': name,
            'domains': [d['domain'] for d in domains], 'checks': merged,
            'requiredAgents': ['reviewer', 'security-auditor'] if classification == 'HIGH' else ['reviewer'] if classification == 'MEDIUM' else [],
            'validated': False}
    if declared:
        plan['declaredRisk'] = declared
    if auto:
        plan['incremental'] = {'mode': 'incremental', 'escalated': False, 'failClosed': False, 'reason': None}
        # HIGH never reduces gates: nothing is declared "not impacted" for a high-risk change; a named domain is a scoped request, not an impact claim.
        if not name and classification != 'HIGH' and declared != 'HIGH':
            plan['notImpacted'] = not_impacted(merged)
    return plan
