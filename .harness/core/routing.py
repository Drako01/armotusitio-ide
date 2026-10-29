"""RedEvent boundaries, bounded source navigation and deterministic DAG selection."""
import re
import secrets
from .context import manifests
from .config import terms, NON_IMPLEMENTERS, policy, digest

WORDS = {
    'provider-portal': r'\bprovider-portal\b',
    'sales-portal': r'\bsales-portal\b',
    'api': r'\b(api|backend|openapi|rbac|migration|migraciones?|autenticaci[oó]n|organizaciones?|permisos?|aislamiento)\b',
    'backoffice': r'\b(backoffice|frontend|next|ui|react)\b',
    'n8n': r'\b(n8n|workflow)\b', 'infra': r'\b(infra|terraform|aws|docker|deploy|ci)\b',
    'docs': r'\b(docs?|readme|markdown|documentaci[oó]n)\b',
    'repo': r'\b(repo|monorepo|bootstrap|workspace|package\.json|packages|harness)\b'}
MUTATION = r'\b(implementar?|implementes|implement|crear?|create|agregar?|add|modificar?|modify|actualizar?|update|corregir|fix|bootstrap|configurar?)\b'
CONSUMPTION = r'\b(consum\w*|referenc\w*|existente[s]?|existing|read|leer|le[eé]|respet\w*|sin modificar|no (?:tocar|modificar|cambiar))\b'


def infer_domains(task, domains):
    out, prohibited = [], False
    # Apps declared in apps/ but not enabled by the manifest are unsupported; never hardcode them.
    unsupported = [d['domain'] for d in manifests(True)['domains']
                   if d.get('enabled') is False and any(p.startswith('apps/') for p in d['paths'])]
    for clause in re.split(r'\n|;|\.\s', task):
        clean = re.sub(r'[*`_]', '', clause)
        if re.match(r'^\s*#', clean):
            prohibited = False
        if re.search(r'\b(prohibido|forbidden|prohibitions)\b|^\s*(?:no|do not):\s*$', clean, re.I):
            prohibited = True
        action = re.search(MUTATION, clean, re.I)
        if prohibited or not action or re.search(r'\b(no|never|do not)\s*$', clean[:action.start()], re.I):
            continue
        target = re.split(r'\b(?:con|with|usando|utilizando|que|consum\w*|respet\w*)\b', clean[action.end():], flags=re.I)[0]
        if unsupported and re.search(r'\b(' + '|'.join(map(re.escape, unsupported)) + r')\b', target, re.I) and not re.search(CONSUMPTION, target, re.I):
            raise ValueError('Requested app domain is declared in apps/ but unsupported by the Harness; enable only with real product code and domain-specific gates.')
        for domain in domains:
            name = domain['domain']
            if name in WORDS and re.search(WORDS[name], target, re.I) and not re.search(CONSUMPTION, target, re.I) and not (name == 'api' and re.search(r'acceso a|api client|cliente|capa de acceso', target, re.I)):
                if name not in out:
                    out.append(name)
    if not out:
        heading = next((line for line in task.splitlines() if line.strip() and not line.startswith('domain:')), task)
        out = [d['domain'] for d in domains if d['domain'] in WORDS and re.search(WORDS[d['domain']], heading, re.I) and not re.search(CONSUMPTION, heading, re.I)]
    return out or ['repo']


def task_slice(text, domain, ref):
    lines, seen, ranked, section = re.split(r'\r?\n', text), set(), [], None
    for i, line in enumerate(lines):
        if re.match(r'^#{1,6} ', line):
            section = next((n for n, expr in WORDS.items() if re.search(expr, line, re.I)), None)
        if not line.strip() or line in seen:
            continue
        seen.add(line)
        score = (4 if re.search(WORDS.get(domain, re.escape(domain)), line, re.I) else 0) + (3 if section == domain else 0) + (2 if re.search(r'^(?:#{1,6} |.*\b(?:No|Never|Prohibido|Must|Debe)\b)', line, re.I) else 0)
        ranked.append((score, i, line))
    selected, size = [], 0
    for score, i, line in sorted(ranked, key=lambda v: (-v[0], v[1])):
        if size + len(line) <= 2400:
            selected.append((i, line))
            size += len(line)
    return (f'Domain: {domain}. Source: {ref["path"]} (SHA256 {ref["sha256"]}; {len(lines)} lines).\n'
            f'EXPLICIT PARTIAL VIEW: {len(selected)}/{len(lines)} lines shown. This is a navigation slice, not a replacement specification. Before implementation expand the source in bounded pages; read all requirements and restrictions relevant to this domain, including global requirements and unclassified sections. Never assume omitted text is optional. Block if it cannot be inspected. Source access grants no additional write scope.\n'
            'Expand: node .harness/core.mjs source <task-id> <offset> <length> (characters; default 0 4000).\n' +
            '\n'.join(f'L{i+1}: {line}' for i, line in sorted(selected)))


def risk(files=None, task='', domain=None):
    files = files or []
    pattern = policy()['highRiskPattern']
    task_risk = 'MEDIUM' if task.strip() else 'LOW'
    if domain in ['api', 'infra'] or re.search(pattern, task, re.I):
        task_risk = 'HIGH'
    elif (domain in ['docs', 'repo'] and re.search(r'\b(typo|errata|ortograf|documental trivial)\b', task, re.I)
          and not re.search(r'package\.json|dependen|runtime|funcional|functional|apps/|core/|workflow', task, re.I)):
        task_risk = 'LOW'
    file_risk = 'LOW' if all(p.endswith('.md') for p in files) else 'MEDIUM'
    if re.search(pattern, ' '.join(files), re.I) or any(p.startswith('.harness/') and not p.endswith('.md') for p in files):
        file_risk = 'HIGH'
    return max([task_risk, file_risk], key=['LOW', 'MEDIUM', 'HIGH'].index)


def select_agents(domain, task, agents, files=None, assessed=None):
    t, names = ' '.join(terms(task)), {a['name'] for a in agents}
    # `assessed` is a core.risk classification: its level drives the chain and a sensitive area always keeps the auditor.
    classification = assessed['level'] if assessed else risk(files, task, domain['domain'])
    sensitive = bool(assessed and assessed.get('sensitive'))
    if classification == 'LOW' and not sensitive:
        return {'agents': ['context-manager', domain['agent'], 'verifier', 'logger'], 'temporary': None}
    selected = ['context-manager', domain['agent']]
    if re.search(r'arquitect|package|shared|adr|monorepo', t) and 'architect' not in selected:
        selected.insert(1, 'architect')
    if re.search(r'test|coverage|e2e|qa', t):
        selected.append('tester')
    selected.append('reviewer')
    if classification == 'HIGH' or sensitive:
        selected.append('security-auditor')
    selected += ['verifier', 'logger']
    selected = list(dict.fromkeys(n for n in selected if n in names))
    # A mention of a technology alone does not create a temporary specialist.
    requested = re.search(r'specialist[:=]([a-z0-9_-]+)', task, re.I)
    if domain['agent'] not in names or requested:
        specialty = requested[1] if requested else domain['domain']
        name = 'temporary-' + specialty + '-' + digest(domain['domain'] + ':' + specialty + ':' + task)[:8]
        temporary = {'name': name, 'role': 'temporary-specialist', 'domain': domain['domain'],
                     'lifetime': 'task', 'allowedPaths': domain['paths'], 'forbiddenPaths': domain['exclude'],
                     'skills': domain['skills'], 'tokenBudget': domain['tokenBudget']}
        return {'agents': selected + [name], 'temporary': temporary}
    return {'agents': selected, 'temporary': None}


def build_dag(selected):
    workers = [n for n in selected if n not in NON_IMPLEMENTERS]
    def dependencies(agent):
        if agent == 'context-manager':
            return []
        if agent == 'reviewer':
            return workers
        if agent == 'security-auditor':
            return ['reviewer']
        if agent == 'verifier':
            return ['security-auditor'] if 'security-auditor' in selected else ['reviewer'] if 'reviewer' in selected else workers
        if agent == 'logger':
            return ['verifier']
        index = workers.index(agent)
        return [workers[index-1]] if index else ['context-manager'] if 'context-manager' in selected else []
    return [{'id': a, 'agent': a, 'dependsOn': dependencies(a), 'status': 'pending', 'attempts': 0} for a in selected]
