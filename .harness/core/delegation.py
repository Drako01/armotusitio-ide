"""Explicit bounded contracts, post-execution write guards and truthful results."""
import json
import secrets
import time
from contextlib import ExitStack
from .config import ROOT, H, NON_IMPLEMENTERS, DETERMINISTIC, READ_ONLY, dumps, tokenize, budget, gate_timeout_ms, agent_timeout_ms, workspace, isolated, now, local_hook
from .context import context, context_index, get_domain, manifests
from .security import read_source, allowed_path, redact
from .state import persist_task, handoff, handoff_name, log
from .snapshot import snapshot, serialize_snapshot, compare_snapshots, baseline_file, record_scope_violation, ScopeError
from .adapters import host_adapter, extract_claude_result, parse_result, claude_usage
from .runner import spawn_run
from . import worktree as wt_mod
from .budget import BUDGET, host_name
from . import progress
from . import lessons as lessons_mod
from .verification import task_verify_plan, run_gates, selected, SKIPPED, FAIL, NOT_RUN

RULE = ('You are a Harness-delegated specialist, not the host orchestrator. Implement only your assigned role and domain scope intersected with contract.allowedPaths. Respect both context.exclude and contract.forbiddenPaths. Read applicable nested AGENTS instructions. context.skills lists selected skills by reference: read each SKILL.md from its path before acting. Handoffs are summaries: read the full record from handoff.path when changes, decisions or verification details are needed. Reviewers and security auditors must not edit files and must return failed for actionable findings; their `files` must be [] (reviewed files are cited in `decisions`/`verification` as path:line), `risks` holds only actionable findings (then status=failed) and non-blocking observations go in `decisions`. Never run formatters or linters with --write over the whole repository; run them only on files inside your scope. If a gate (typecheck, build, test) regenerates tracked generated files such as next-env.d.ts or tsconfig.tsbuildinfo, restore them with `git checkout -- <file>` before responding, unless they are an intentional part of the change, in which case declare them in `files`. Return ONLY the JSON result shape; exit success does not imply task success. Do not orchestrate agents, commit, push, switch branches, or modify unrelated files. Correct issues described in failed handoffs before revalidation. When `node.owns` is present you exclusively own those paths for this run: write nowhere else, other units are being changed concurrently in separate checkouts.')


def delegation_context(task, contract, agent=None):
    agent = agent or contract['name']
    if task.get('sourceRef'):
        read_source(task['sourceRef'])
    ctx = context(task['domain'], task['task'])
    if task.get('sourceRef'):
        ctx['sourceRef'] = task['sourceRef']
    index = context_index()['skills']
    names = list(dict.fromkeys(contract.get('skills', []) + ([] if agent in NON_IMPLEMENTERS else [s['name'] for s in ctx['skills']])))
    skills = []
    for name in names:
        entry = next((s for s in index if s['name'] == name), None)
        if not entry:
            raise ValueError('Skill faltante: ' + name)
        skills.append({k: entry[k] for k in ['name', 'description', 'path']})
    ctx['skills'] = skills
    return ctx


def compact_handoff(record, file, absolute=False):
    path = str(file).replace('\\', '/') if absolute else str(file).replace(str(ROOT) + '/', '').replace(str(ROOT) + '\\', '').replace('\\', '/')
    return {k: record.get(k, [] if k in ['files', 'risks'] else None) for k in ['agent', 'attempt', 'status', 'files', 'risks', 'nextAction']} | ({'node': record['node']} if record.get('node') else {}) | {'path': path}


def delegation_prompt(task, node, contract, ctx, handoffs):
    context_value = {k: v for k, v in ctx.items() if k != 'task'}
    checks = context_value.pop('verification')
    # References and selected skills appear once; role contract carries its write policy and responsibilities.
    logical_contract = {k: v for k, v in contract.items() if k not in ['skills', 'contextSources', 'inputs', 'outputs', 'verification']}
    value = {'taskId': task['id'], 'task': task['task'], 'role': node['agent'], 'domain': task['domain'],
             **({'node': {k: node[k] for k in ['id', 'unit', 'kind', 'owns', 'reads'] if k in node}} if node.get('unit') else {}),
             'contract': logical_contract, 'context': context_value, 'handoffs': handoffs,
             'checks': checks, 'roleChecks': contract.get('verification', []), 'result': {'status': 'passed|failed|blocked', 'changes': [],
                      'files': [], 'decisions': [], 'risks': [], 'verification': [], 'nextAction': None}, 'rule': RULE}
    lessons = [{k: l[k] for k in ['id', 'title', 'advice'] if k in l} for l in lessons_mod.relevant(task['domain'], [node['agent']], 5)]
    if lessons:
        value['lessons'] = lessons
    prompt = dumps(value)
    limit = budget(ctx['tokenBudget'], contract.get('tokenBudget'))
    if lessons and tokenize(prompt) > limit:
        value.pop('lessons')  # advisory text is dropped before anything else is trimmed or the budget fails
        prompt = dumps(value)
    if tokenize(prompt) > limit:
        context_value['skills'] = [{k: v for k, v in s.items() if k != 'description'} for s in context_value['skills']]
        context_value['omitted'] = context_value.get('omitted', []) + ['skill descriptions; full skills referenced by path']
        prompt = dumps(value)
    if tokenize(prompt) > limit:
        raise ValueError('Delegated prompt budget excedido; task/restrictions/findings cannot be truncated')
    return prompt


def dependency_handoffs(task, node):
    found = []
    for dependency in task['dag']:
        if dependency['id'] not in node['dependsOn'] and dependency['status'] not in ['failed', 'blocked'] and dependency['id'] not in task.get('feedback', []):
            continue
        file = H / 'handoffs' / handoff_name(task, dependency)
        if file.exists():
            from .config import read_json
            found.append(compact_handoff(read_json(file), file, absolute=isolated()))
    return found


def run_gate(task, gate):
    """Runs one plan check. SKIPPED_ENVIRONMENT is reported as `skipped` and must be treated by callers as fail-closed."""
    return gate_outcome(task, run_gates(task, [gate], gate_timeout_ms(), spawn=spawn_run)[0])


def gate_outcome(task, result):
    """Evidence logging and verdict for one gate result (cached, retried or quarantined results included)."""
    evidence = {'command': result['command'], 'tier': result['tier'], 'status': result['status'], 'exit': result['exit'],
                'durationMs': result['durationMs'], 'log': result['log'], 'stdoutTail': result['stdoutTail'][-1500:], 'stderrTail': result['stderrTail'][-1500:]}
    for key in ('error', 'reused', 'cached', 'retriedFlaky', 'quarantined'):
        if result.get(key):
            evidence[key] = result[key]
    if result['status'] == SKIPPED:
        evidence['skipReason'] = result['skipReason']
    log('audit', task['id'], 'gate', evidence)
    record_gate(task, result)
    quarantined = bool(result.get('quarantined'))
    code = 3 if result['status'] == SKIPPED else 1 if result['status'] in (FAIL, NOT_RUN) and not quarantined else 0
    return {'code': code, 'skipped': result['status'] == SKIPPED, 'reason': result['skipReason'], 'evidence': dumps(evidence)}


def record_gate(task, result):
    """Local telemetry and flaky history for one gate run; best effort, never alters the verdict."""
    try:
        from . import telemetry, flaky
        telemetry.record('gate', key=' '.join(result['command']), durationMs=result['durationMs'], status=result['status'], task=task['id'])
        if result.get('reused'):
            telemetry.record('cache', key=' '.join(result['command']), result='hit')
        if result['status'] in ('PASS', 'FAIL'):
            flaky.observe_gate_output(result['stdoutTail'] + result['stderrTail'], result['status'] == 'PASS',
                                      retries=1 if result.get('retriedFlaky') else 0, duration_ms=result['durationMs'])
    except Exception:
        pass


class Cancelled(Exception):
    """The run was cancelled (operator interrupt, fail-fast, timeout of the whole task); its result must never be adopted."""


def run_deterministic(task, node, ctx):
    if node['agent'] in ['context-manager', 'logger']:
        node['status'] = 'passed'
        handoff(task, node, 'passed', {'verification': [str(ctx['estimatedTokens']) + ' estimated context tokens']} if node['agent'] == 'context-manager' else {'nextAction': 'complete'})
        return True
    # Explicit domain checks remain required after an implementer, including clean worktrees.
    # Parallel runs gate the *integrated* main checkout: integration and gates exclude each other.
    with ExitStack() as stack:
        if isolated():
            stack.enter_context(wt_mod.MAIN_LOCK)
        gates = selected(task_verify_plan(task))
        try:
            if gates:
                progress.record_gates(task['id'], node['id'], 0, len(gates), gates[0]['command'])
            results = run_gates(task, gates, gate_timeout_ms(), spawn=spawn_run)  # independent gates run concurrently; results come back in plan order
            for result in results:
                run = gate_outcome(task, result)
                if run['skipped']:
                    # An environment gap is never a pass: block with the explicit reason until the tool is available.
                    node['status'] = 'blocked'
                    handoff(task, node, 'blocked', {'risks': ['Verification not performed (SKIPPED_ENVIRONMENT): ' + run['reason']],
                                                    'verification': [run['evidence']], 'nextAction': 'Install or start the missing tool, then rerun pnpm harness:execute (the task stays active; harness:retry only accepts failed tasks)'})
                    return False
                if run['code']:
                    node['status'] = 'failed'
                    handoff(task, node, 'failed', {'risks': ['Verification failed'], 'verification': [run['evidence']]})
                    return False
        finally:
            progress.clear_gates(task['id'])
    node['status'] = 'passed'
    handoff(task, node, 'passed', {'verification': ['domain gates passed']})
    return True


def node_timeout(node):
    """Per-subtask timeout: the planner may only tighten the global limit, never extend it."""
    limit, own = agent_timeout_ms(), node.get('timeoutMs')
    if own and limit:
        return min(limit, own)
    return own or limit


def execute_node(task, node, cancel=None):
    started = time.monotonic()
    node['status'], node['attempts'] = 'running', node['attempts'] + 1
    node['runId'], node['startedAt'] = secrets.token_hex(8), now()
    for key in ['finishedAt', 'failureCategory', 'integration', 'interrupted', 'cancelled']:
        node.pop(key, None)
    persist_task(task)
    (local_hook('announce') or progress.announce)(task)
    contract = next((a for a in manifests()['agents'] if a['name'] == node['agent']), task.get('temporaryAgent'))
    if not contract:
        raise ValueError('Agent contract missing')
    ctx = delegation_context(task, contract, node['agent'])
    if node.get('owns'):
        contract = {**contract, 'ownedPaths': node['owns']}  # dynamic scope reduction to the node's exclusive ownership
    if node['agent'] in DETERMINISTIC:
        try:
            return run_deterministic(task, node, ctx)
        finally:
            node['finishedAt'] = now()
    isolate = isolated() and not local_hook('lone') and wt_mod.available()
    worktree = wt_mod.Worktree(task['id'], node['id'], node['attempts'], node['runId']) if isolate else None
    work_root = worktree.path if isolate else ROOT
    result_file = work_root / '.harness' / 'runtime' / f'{task["id"]}-{node["id"]}-{node["attempts"]}-result.json'
    prompt = delegation_prompt(task, node, contract, ctx, dependency_handoffs(task, node))
    extra_dirs = [H / 'handoffs', H / 'tasks'] if isolate else []
    adapter = host_adapter(node['agent'], prompt, result_file, extra_dirs)
    if adapter is None:
        node['status'] = 'blocked'
        handoff(task, node, 'blocked', {'nextAction': 'Set HARNESS_HOST=codex|claude or HARNESS_AGENT_COMMAND'})
        return False
    category = 'none'
    failure = ''  # human reason of a non-passed node, only fed to the local lessons log
    run = {'code': 1}
    keep_baseline = True
    baseline = None
    integrated = None
    try:
        with ExitStack() as stack:
            if isolate:
                if not local_hook('slot'):
                    # Sequential children running in worker threads still honour the global worker/role/host limits.
                    stack.enter_context(BUDGET.slot(node['agent'], host_name()))
                # Stage task inputs by the same relative paths the prompt references; they are Harness-owned, not agent writes.
                staged = [f'.harness/tasks/active/{task["id"]}.json'] + ([task['sourceRef']['path']] if task.get('sourceRef') else [])
                worktree.create(staged)
                node['isolation'] = {'worktree': worktree.name, 'path': str(worktree.path), 'head': worktree.head}
                persist_task(task)
                stack.enter_context(workspace(worktree.path))
            result_file.parent.mkdir(parents=True, exist_ok=True)
            result_file.unlink(missing_ok=True)  # A previous/stale result is never adopted.
            before = snapshot()
            baseline = baseline_file(task, node)
            log_file = H / 'runtime/output' / (baseline.stem + '-' + secrets.token_hex(6) + '.log')
            owned = [log_file.relative_to(ROOT).as_posix()] + ([result_file.relative_to(work_root).as_posix()] if adapter.get('host') != 'claude' else [])
            if isolate:
                owned = [result_file.relative_to(work_root).as_posix()] if adapter.get('host') != 'claude' else []
                owned += worktree.owned
            else:
                owned.append(baseline.relative_to(ROOT).as_posix())
                saved_baseline = json.loads(serialize_snapshot(before))
                saved_baseline['owned'] = owned
                baseline.write_text(dumps(saved_baseline), encoding='utf-8')
            node['activeStartedAt'] = now()
            run = spawn_run(adapter['cmd'], adapter['args'], {'env': adapter['env'], 'input': adapter['input'],
                            'host': adapter.get('host'), 'trusted': True, 'structured': True, 'timeoutMs': node_timeout(node), 'logFile': str(log_file),
                            'cancel': cancel, 'onSpawn': worktree.record_process if isolate else None})
            if cancel is not None and cancel.is_set():
                raise Cancelled('Run cancelled before its result could be adopted')
            node['activeMs'] = run.get('durationMs')
            # The reserved output name is persisted before spawn for crash recovery.
            if run.get('log') and not isolate:
                owned.append(run['log'])
            actual = compare_snapshots(before, snapshot(), get_domain(task['domain']), contract, owned)
            keep_baseline = False  # Only an authoritative comparison permits baseline retirement.
            if isolate and worktree.head_moved():
                reason = 'Agent moved HEAD inside its worktree (commit/checkout/reset are delivery operations, never delegated)'
                record_scope_violation(task, node, before, [], reason, contained=True)
                category = 'security-denial'
                raise ValueError(reason)
            if run['code']:
                category = 'timeout' if run['code'] == 124 else 'cancelled' if run['code'] == 130 else 'host-unavailable' if run['code'] == 127 else 'host-exit'
                tail = redact(str(run.get('err', ''))[-4096:])
                import re
                cause = ('quota' if re.search(r'quota|usage limit|rate.limit|429', tail, re.I) else
                         'authentication' if re.search(r'unauthoriz|authentication|login required|401', tail, re.I) else
                         'turn-limit' if re.search(r'max.turns|turn limit', tail, re.I) else
                         'timeout' if run['code'] == 124 else
                         'windows-pipe' if re.search(r'broken.pipe|winerror|pipe', tail, re.I) else 'unknown')
                if cause in ('quota', 'authentication'):
                    category = 'host-' + cause
                log('audit', task['id'], 'host-exit', {'node': node['id'], 'exitCode': run['code'],
                    'cause': cause, 'stderrTail': tail, 'log': run.get('log')})
                raise ValueError('Host exit ' + str(run['code']) + ' (' + category +
                                 '; cause=' + cause + '); transport evidence ' + str(run.get('log', 'unavailable')))
            raw = extract_claude_result(run['out']) if adapter.get('host') == 'claude' else result_file.read_text(encoding='utf-8') if result_file.exists() else run['out']
            if adapter.get('host') == 'claude':
                usage = claude_usage(run['out'])
                if usage:
                    node['tokens'] = usage
            result = parse_result(raw)
            # Snapshot is authoritative for writes; declared paths are only supporting metadata.
            # Scope validation above remains fail-closed for read-only/protected/out-of-scope writes.
            import re
            declared = [file for file in result['files']
                        if isinstance(file, str) and re.fullmatch(r'[A-Za-z0-9_.@/\\-]+', file)
                        and not file.startswith('/') and '..' not in file.split('/')]
            discarded = [str(file)[:120] for file in result['files'] if file not in declared]
            if discarded:
                log('audit', task['id'], 'invalid-declared-files-ignored',
                    {'node': node['id'], 'count': len(discarded)})
            undeclared = sorted(set(actual) - set(declared))
            if undeclared:
                log('audit', task['id'], 'auto-declared', {'node': node['id'], 'files': undeclared})
            result['files'] = sorted(set(actual) | (set(declared) & set(actual)))
            if result['status'] == 'passed' and result['risks'] and node['agent'] in ['reviewer', 'security-auditor']:
                raise ValueError('Passed review/audit cannot contain unresolved findings')
            if result['status'] == 'passed' and not result['verification']:
                raise ValueError('Passed agent result requires explicit verification evidence')
            if result['status'] == 'passed' and actual and not (result['changes'] or result['decisions'] or result['verification']):
                raise ValueError('Passed agent result missing evidence for changed files')
            if cancel is not None and cancel.is_set():
                raise Cancelled('Run cancelled before its result could be adopted')  # a late result is never integrated
            if isolate and result['status'] == 'passed' and actual:
                try:
                    node['integration'] = {'patch': worktree.evidence(actual), **worktree.integrate(actual)}
                except wt_mod.IntegrationConflict as conflict:
                    category = 'integration-conflict'
                    node['conflicts'] = node.get('conflicts', 0) + 1
                    worktree.set_state('conflict', files=[c['file'] for c in conflict.conflicts])
                    node['status'] = 'failed'
                    handoff(task, node, 'failed', {'risks': [str(conflict)], 'files': [],
                                                   'nextAction': 'Main checkout changed the same files concurrently; the node is retried from the updated state'})
                    return False
                integrated = actual
            node['status'] = result['status']
            handoff(task, node, node['status'], result)
            category = 'none' if node['status'] == 'passed' else 'agent-result'
            failure = ' '.join(map(str, result['risks']))
            return node['status'] == 'passed'
    except Cancelled:
        category = 'cancelled'
        node['status'] = 'pending'
        node['cancelled'] = {'at': now(), 'runId': node['runId']}
        if isolate:
            worktree.set_state('cancelled')
        log('audit', task['id'], 'node-cancelled', {'node': node['id'], 'runId': node['runId'], 'attempt': node['attempts']})
        raise
    except ScopeError as error:
        category = 'security-denial'
        failure = str(error)
        record_scope_violation(task, node, before, error.scope_files, str(error), contained=isolate)
        keep_baseline = False  # The persisted restoration latch supersedes this baseline.
        handoff(task, node, 'failed', {'risks': [str(error)]})
        return False
    except Exception as error:
        if keep_baseline and not isolate:
            task['scopeValidationPending'] = {'agent': node['agent'], 'attempt': node['attempts'],
                                             'baseline': baseline.relative_to(ROOT).as_posix()}
        category = category if category != 'none' else 'malformed-result'
        failure = str(error)
        node['status'] = 'failed'
        handoff(task, node, 'failed', {'risks': ['Invalid structured agent result: ' + str(error)]})
        return False
    finally:
        node['finishedAt'] = now()
        node['failureCategory'] = category
        if category != 'none':
            try:
                lessons_mod.observe(task, node, category, failure)  # best effort; never alters the outcome
            except Exception:
                pass
        if isolate:
            if node['status'] == 'passed':
                # Evidence (handoff, journal, patch) survives; a successful node's checkout is no longer needed.
                node.pop('isolation', None)
                worktree.discard()
            elif worktree.state not in ('removed',):
                worktree.set_state(worktree.state if worktree.state in ('conflict', 'cancelled') else 'failed')
        if not keep_baseline and baseline is not None:
            baseline.unlink(missing_ok=True)
        try:
            from . import telemetry
            telemetry.record('worker', key=node['agent'], durationMs=round((time.monotonic() - started) * 1000), status=node['status'],
                             attempt=node['attempts'], category=category)
            if category != 'none':
                telemetry.record('failure', key=category, category=category, agent=node['agent'])
        except Exception:
            pass
        if not keep_baseline or isolate:
            log('execution', task['id'], 'agent-finished', {'agent': node['agent'], 'node': node['id'], 'domain': task['domain'],
                'host': adapter.get('host', 'custom'), 'durationMs': round((time.monotonic()-started)*1000),
                'estimatedContext': tokenize(prompt), 'attempt': node['attempts'], 'exit': run['code'],
                'status': node['status'], 'failureCategory': category, 'isolated': bool(isolate),
                **({'tokens': node['tokens']} if node.get('tokens') else {})})
