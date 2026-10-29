"""Task ingestion preserves immutable sources, identity and retry evidence."""
import json
import re
from .config import ROOT, H, task_id, digest, now, read_json, STATUSES, write_json, recommended_workers, worker_rationale
from .context import manifests, get_domain, context
from .routing import infer_domains, task_slice, select_agents, build_dag, risk
from . import planner, risk as riskmod, estimate as estimator
from .state import persist_task, validate_task, assert_task_id, Lock, move_task, log, reopen_nodes
from .security import contained, read_source, redact
from .snapshot import verify_scope_restoration, clear_restored_scope


def make_task(domain_name, task_text, source='direct'):
    if not task_text.strip():
        raise ValueError('Empty task specification')
    if redact(task_text) != task_text:
        raise ValueError('Task source contains sensitive content; replace secrets with environment references before ingestion')
    all_values = manifests()
    names = infer_domains(task_text, all_values['domains']) if domain_name == 'auto' else [domain_name]
    bootstrap = 'backoffice' in names and re.search(r'bootstrap|scaffold|(?:backoffice.*(?:completo|nuevo))|(?:(?:crear|create).*backoffice)', task_text, re.I)
    if bootstrap and 'repo' not in names:
        names.insert(0, 'repo')
    identity = task_id()
    external = source != 'direct' or len(task_text) > 4000 or len(names) > 1
    ref = {'path': f'.harness/tasks/sources/{identity}.txt', 'sha256': digest(task_text), 'characters': len(task_text)} if external else None
    items = []
    for name in names:
        domain = get_domain(name)
        text = task_slice(task_text, name, ref) if ref else task_text
        selected_context = context(name,text)
        change_set = selected_context['changeSet']
        files = change_set.get('files')
        if files is None:
            files = read_json(ROOT/change_set['path'])
        selection = select_agents(domain, task_text, all_values['agents'], files,
                                  riskmod.classify(files, task_text, name) if riskmod.apply_enabled() else None)
        if name != 'repo':
            selection['agents'] = [n for n in selection['agents'] if n != 'architect']
        # The planner sees the whole specification (units may live outside the domain slice) and returns the historical
        # chain unless explicit units, or provably independent path-owned bullets, justify parallel work.
        layout = planner.plan(domain, task_text, selection, all_values['agents'], risk(files, task_text, name))
        item = {'schemaVersion': 1, 'runtimeVersion': 2, 'id': task_id() if len(names) > 1 else identity,
                'source': source, 'status': 'active', 'task': text, 'domain': name, 'createdAt': now(),
                'agents': layout['agents'], 'temporaryAgent': selection['temporary'],
                'dag': layout['dag'], 'contextSlice': selected_context,
                'risk': risk(files,task_text,name), 'rule': 'ORCHESTRATOR_MUST_DELEGATE_PRODUCT_WORK'}
        if layout['plan']:
            item['plan'] = layout['plan']
        if ref:
            item['sourceRef'] = ref
        validate_task(item)
        items.append(item)
    if ref:
        if not contained(ref['path']):
            raise ValueError('Source storage symlink rejected')
        file = ROOT / ref['path']
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open('x', encoding='utf-8', newline='') as stream:
            stream.write(task_text)
    for item in items:
        if item['temporaryAgent']:
            write_json(H / 'runtime/agents' / (item['id'] + '-' + item['temporaryAgent']['name'] + '.json'), item['temporaryAgent'])
        persist_task(item)
        log('execution', item['id'], 'orchestrated', {'domain': item['domain'], 'agents': item['agents'], 'risk': item['risk']})
    if len(items) == 1:
        return items[0]
    parent = {'schemaVersion': 1, 'runtimeVersion': 2, 'id': identity, 'source': source, 'sourceRef': ref,
              'status': 'active', 'task': 'Domain slices share the immutable source; expand via source command.',
              'domain': 'multi', 'createdAt': now(), 'primaryDomain': names[0], 'secondaryDomains': names[1:],
              'children': [t['id'] for t in items]}
    if any(t['domain'] == 'repo' for t in items):
        parent['bootstrap'] = next(t['id'] for t in items if t['domain'] == 'repo')
    persist_task(parent)
    return parent


def preview(domain_name, task_text):
    """Dry run of planning: the DAG, ownership and cost/benefit estimate per domain. Persists nothing."""
    all_values = manifests()
    names = infer_domains(task_text, all_values['domains']) if domain_name == 'auto' else [domain_name]
    out = []
    for name in names:
        domain = get_domain(name)
        files = context(name, task_text)['changeSet'].get('files') or []
        assessed = riskmod.classify(files, task_text, name)
        selection = select_agents(domain, task_text, all_values['agents'], files, assessed if riskmod.apply_enabled() else None)
        if name != 'repo':
            selection['agents'] = [n for n in selection['agents'] if n != 'architect']
        layout = planner.plan(domain, task_text, selection, all_values['agents'], risk(files, task_text, name))
        workers = recommended_workers(layout['plan']['width']) if layout['plan'] and layout['plan']['parallel'] else 1
        budget = riskmod.budget_for(assessed['level'], layout['plan'])
        gates = [v for v in domain.get('verification', [])]
        out.append({'domain': name, 'agents': layout['agents'], 'plan': layout['plan'] or {'source': 'legacy', 'parallel': False},
                    'risk': {'level': assessed['level'], 'reasons': assessed['reasons'], 'mandatory': assessed['mandatory']},
                    'budget': budget, 'estimate': estimator.estimate(layout['plan'], layout['dag'], gates, assessed, workers),
                    'recommendedWorkers': workers, 'workerRationale': worker_rationale(layout['plan'], workers),
                    'dag': [{k: n[k] for k in ['id', 'agent', 'dependsOn', 'owns', 'kind'] if k in n} for n in layout['dag']]})
    return out


def load_task(identity):
    assert_task_id(identity)
    found = [H / 'tasks' / status / (identity + '.json') for status in STATUSES if (H / 'tasks' / status / (identity + '.json')).exists()]
    if len(found) != 1:
        raise ValueError('Task not found' if not found else 'Duplicate task lifecycle records; inspect state')
    file = found[0]
    if not contained(file.relative_to(ROOT).as_posix()):
        raise ValueError('Task storage symlink rejected')
    task = validate_task(read_json(file), file.parent.name)
    if task['domain'] == 'multi':
        for child_id in task['children']:
            child = load_task(child_id)
            if child['domain'] == 'multi':
                raise ValueError('Nested multi tasks are invalid')
            if task['status'] == 'completed' and child['status'] != 'completed':
                raise ValueError('Completed parent has incomplete child')
    return task


def expand_source(identity, offset='0', length='4000'):
    task = load_task(identity)
    if not task.get('sourceRef'):
        raise ValueError('Task has no external source')
    if not re.fullmatch(r'\d+', str(offset)) or not re.fullmatch(r'\d+', str(length)) or not 1 <= int(length) <= 12000:
        raise ValueError('Source expansion budget: offset >= 0, length 1..12000')
    start, count = int(offset), int(length)
    text = read_source(task['sourceRef'])
    if start > len(text):
        raise ValueError('Source offset out of range')
    return {'sourceRef': task['sourceRef'], 'offset': start, 'nextOffset': min(len(text), start+count),
            'complete': start+count >= len(text), 'text': text[start:start+count]}


def list_tasks():
    rows = []
    for status in STATUSES:
        directory = H / 'tasks' / status
        if not directory.exists():
            continue
        for file in sorted(directory.glob('*.json')):
            task = read_json(file)
            nodes = {}
            for node in task.get('dag', []):
                status_name = node.get('status', 'invalid')
                nodes[status_name] = nodes.get(status_name, 0) + 1
            rows.append({'id': task['id'], 'status': status, 'domain': task['domain'],
                         'updatedAt': task.get('updatedAt', task.get('createdAt')), 'nodes': nodes})
    return sorted(rows, key=lambda row: row['id'])


def abort_task(identity, reason=''):
    assert_task_id(identity)
    with Lock(H / 'state/workspace.lock'):
        task = load_task(identity)
        if task['status'] != 'active':
            raise ValueError('Tarea activa no encontrada: ' + identity)
        if task['domain'] == 'multi':
            for child_id in task['children']:
                child = load_task(child_id)
                if child['status'] == 'active':
                    child['aborted'] = {'at': now(), 'reason': reason or 'parent aborted by operator'}
                    move_task(child, 'failed')
                    log('audit', child['id'], 'aborted-with-parent', {'parent': identity})
        task['aborted'] = {'at': now(), 'reason': reason or 'aborted by operator'}
        move_task(task, 'failed')
        log('audit', identity, 'aborted', {'reason': task['aborted']['reason']})
        return task


def retry_task(identity, reason=''):
    assert_task_id(identity)
    with Lock(H / 'state/workspace.lock'):
        task = load_task(identity)
        if task['status'] != 'failed':
            raise ValueError('Tarea failed no encontrada: ' + identity)
        children = [load_task(c) for c in task['children']] if task['domain'] == 'multi' else []
        for entry in [task, *children]:
            verify_scope_restoration(entry)
            if entry.get('scopeValidationPending'):
                raise ValueError('Unverified scope comparison; inspect retained baseline manually and use a new task')
            from .snapshot import baseline_file
            if any(baseline_file(entry, n).exists() and n['status'] == 'failed' for n in entry.get('dag', [])):
                raise ValueError('Unverified failed-attempt baseline remains; inspect scope manually and use a new task')
        for entry in [*children, task]:
            if entry['status'] != 'failed':
                continue
            clear_restored_scope(entry)
            entry.pop('aborted', None)
            reopen_nodes(entry)
            move_task(entry, 'active')
            log('audit', entry['id'], 'retried', {'reason': reason or 'operator retry'})
        return task


def dispatch():
    out = []
    for file in sorted((H / 'tasks/inbox').iterdir()):
        if file.suffix not in ['.md', '.txt']:
            continue
        if not contained(file.relative_to(ROOT).as_posix()):
            raise ValueError('Inbox symlink rejected')
        text = file.read_bytes().decode('utf-8')
        match = re.search(r'^domain:\s*(\S+)', text, re.I | re.M)
        out.append(make_task(match[1] if match else 'auto', text, 'inbox:' + file.name))
        file.unlink()
    return out
