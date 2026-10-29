"""Task decomposition: work units with ownership, a validated DAG, and a cost/benefit check before adding agents.

Three plan sources, all deterministic and offline:

* `legacy`    - the historical chain (no units). Used for small tasks and whenever nothing proves independence.
* `directive` - the operator wrote `unit:` lines in the task text (explicit, authoritative).
* `auto`      - bullets that each name repository paths under disjoint directories are proposed as units.

A plan never creates agents for its own sake: parallel units are kept only when the estimated speedup beats the
coordination overhead, otherwise the same units run as an ordered chain (or the plan degrades to `legacy`).
"""
import re
import time
from .config import NON_IMPLEMENTERS, READ_ONLY, DETERMINISTIC, policy, setting
from .routing import build_dag, MUTATION, CONSUMPTION
from .security import valid_path, matches_path

UNIT_KEYS = {'agent', 'owns', 'reads', 'after', 'effects', 'weight', 'timeoutMs'}
UNIT_LINE = re.compile(r'^\s*(?:[-*]\s*)?unit:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,31})\s*(?:\|(.*))?$', re.I)
BULLET = re.compile(r'^\s*(?:[-*+]|\d+[.)])\s+(.*)$')
PATH = re.compile(r'`((?:[A-Za-z0-9_.@-]+/)+[A-Za-z0-9_.@*-]*(?:\*\*)?)`')
ROLE_ORDER_PRE = ['architect']
ROLE_ORDER_POST = ['tester']


def planner_mode():
    mode = __import__('os').environ.get('HARNESS_PLANNER', 'auto')
    if mode not in ('auto', 'directive', 'off'):
        raise ValueError('HARNESS_PLANNER must be auto, directive or off')
    return mode


def prefix(glob):
    """Directory prefix before the first wildcard; the basis of the conservative overlap test."""
    head = re.split(r'[*?\[]', glob, 1)[0]
    return head


def overlaps(a, b):
    """Two globs may match a common path when one directory prefix contains the other (wildcard-first globs overlap all)."""
    pa, pb = prefix(a), prefix(b)
    return pa.startswith(pb) or pb.startswith(pa)


def covered(pattern, allowed):
    """True when every path `pattern` can match lies inside `allowed` (containment, unlike the conservative `overlaps`)."""
    if allowed.endswith('**'):
        return prefix(pattern).startswith(prefix(allowed))
    return pattern == allowed or ('*' not in pattern and matches_path(pattern, allowed))


def conflicting(owns_a, owns_b):
    return any(overlaps(a, b) for a in owns_a for b in owns_b)


def safe_id(agent, unit):
    return re.sub(r'[^a-zA-Z0-9_-]', '-', f'{agent}-{unit}')


def parse_units(text, default_agent):
    units = []
    for line in re.split(r'\r?\n', text):
        match = UNIT_LINE.match(line)
        if not match:
            continue
        unit = {'unit': match[1], 'agent': default_agent, 'owns': [], 'reads': [], 'after': [], 'effects': 'none', 'weight': 1.0}
        for part in filter(None, (p.strip() for p in (match[2] or '').split('|'))):
            key, sep, value = part.partition('=')
            key, value = key.strip(), value.strip()
            if not sep or key not in UNIT_KEYS or not value:
                raise ValueError(f'unit {match[1]}: invalid or unknown attribute {part!r} (allowed: {", ".join(sorted(UNIT_KEYS))})')
            if key in ('owns', 'reads', 'after'):
                unit[key] = [v.strip() for v in value.split(',') if v.strip()]
            elif key == 'weight':
                unit[key] = float(value)
                if not 0 < unit[key] <= 1000:
                    raise ValueError(f'unit {match[1]}: weight must be in (0, 1000]')
            elif key == 'timeoutMs':
                if not value.isdigit() or int(value) < 1:
                    raise ValueError(f'unit {match[1]}: timeoutMs must be a positive integer')
                unit[key] = int(value)
            elif key == 'effects':
                if value not in ('none', 'external'):
                    raise ValueError(f'unit {match[1]}: effects must be none or external')
                unit[key] = value
            else:
                unit[key] = value
        units.append(unit)
    if len({u['unit'] for u in units}) != len(units):
        raise ValueError('duplicate unit id in task')
    return units


def auto_units(text, domain, default_agent):
    """Bullets that mutate paths under disjoint directories become units; anything ambiguous yields nothing."""
    groups = []
    for line in re.split(r'\r?\n', text):
        bullet = BULLET.match(line)
        if not bullet:
            continue
        body = bullet[1]
        action = re.search(MUTATION, body, re.I)
        if not action or re.search(CONSUMPTION, body, re.I) or re.search(r'\b(no|never|do not|sin)\s*$', body[:action.start()], re.I):
            continue
        paths = [p for p in PATH.findall(body) if valid_path(p.rstrip('/'))]
        if not paths:
            continue
        owners = []
        for path in paths:
            clean = path.rstrip('/')
            if '*' in clean:
                owner = clean
            else:
                owner = clean.rsplit('/', 1)[0] + '/**' if '.' in clean.rsplit('/', 1)[-1] else clean + '/**'
            if any(covered(owner, allowed) for allowed in domain['paths']) and not any(overlaps(owner, ex) and covered(owner, ex) for ex in domain['exclude']):
                owners.append(owner)  # bullets about other domains belong to those domains' own plans
        if owners:
            groups.append({'owns': owners, 'chars': len(body)})
    merged = []
    for group in groups:
        for existing in merged:
            if conflicting(existing['owns'], group['owns']):
                existing['owns'] = list(dict.fromkeys(existing['owns'] + group['owns']))
                existing['chars'] += group['chars']
                break
        else:
            merged.append(dict(group))
    # Merging can create new overlaps between earlier groups.
    changed = True
    while changed:
        changed = False
        for i, a in enumerate(merged):
            for b in merged[i + 1:]:
                if conflicting(a['owns'], b['owns']):
                    a['owns'] = list(dict.fromkeys(a['owns'] + b['owns']))
                    a['chars'] += b['chars']
                    merged.remove(b)
                    changed = True
                    break
            if changed:
                break
    if len(merged) < 2:
        return []
    cap = min(6, policy()['parallel']['maxNodes'] // 2)
    return [{'unit': f'part-{i + 1}', 'agent': default_agent, 'owns': g['owns'], 'reads': [], 'after': [], 'effects': 'none',
             'weight': max(1.0, round(g['chars'] / 400, 2))} for i, g in enumerate(merged[:cap])]


def validate_units(units, domain, agent_names):
    domain_paths = domain['paths']
    for unit in units:
        if unit['agent'] not in agent_names:
            raise ValueError(f'unit {unit["unit"]}: unknown agent {unit["agent"]!r}')
        if unit['agent'] in NON_IMPLEMENTERS:
            raise ValueError(f'unit {unit["unit"]}: agent {unit["agent"]!r} cannot own writes')
        if not unit['owns']:
            raise ValueError(f'unit {unit["unit"]}: owns= is required (exclusive ownership is what makes it safe to run in parallel)')
        for pattern in unit['owns'] + unit['reads']:
            if not valid_path(pattern.replace('*', 'x')):
                raise ValueError(f'unit {unit["unit"]}: unsafe path pattern {pattern!r}')
        for pattern in unit['owns']:
            if not any(covered(pattern, allowed) for allowed in domain_paths):
                raise ValueError(f'unit {unit["unit"]}: ownership {pattern!r} is outside domain paths')
        for dep in unit['after']:
            if dep not in {u['unit'] for u in units}:
                raise ValueError(f'unit {unit["unit"]}: after= references unknown unit {dep!r}')


def reachable(deps, start):
    seen, stack = set(), [start]
    while stack:
        for dep in deps.get(stack.pop(), []):
            if dep not in seen:
                seen.add(dep)
                stack.append(dep)
    return seen


def estimate(units, edges):
    """(sequentialMs, parallelMs): critical path of declared weights plus a fixed coordination cost per extra worker."""
    p = policy()['parallel']
    cost = {u['unit']: u['weight'] * p['minUnitMs'] for u in units}
    sequential = sum(cost.values())
    memo = {}
    def longest(name):
        if name not in memo:
            memo[name] = cost[name] + max([longest(d) for d in edges.get(name, [])] or [0])
        return memo[name]
    critical = max(longest(u['unit']) for u in units)
    extra = max(0, max_parallel_width(units, edges) - 1)
    return sequential, critical + extra * p['coordinationOverheadMs'], critical


def max_parallel_width(units, edges):
    """Largest set of mutually unordered units (greedy level width by depth is a safe lower bound for the overhead term)."""
    depth = {}
    def level(name):
        if name not in depth:
            depth[name] = 1 + max([level(d) for d in edges.get(name, [])] or [-1])
        return depth[name]
    counts = {}
    for unit in units:
        counts[level(unit['unit'])] = counts.get(level(unit['unit']), 0) + 1
    return max(counts.values())


def order_edges(units):
    """Declared `after` plus an edge for every ownership overlap between otherwise unordered units (declaration order wins)."""
    edges = {u['unit']: list(u['after']) for u in units}
    notes = []
    for i, later in enumerate(units):
        for earlier in units[:i]:
            if later['unit'] in reachable(edges, earlier['unit']) or earlier['unit'] in reachable(edges, later['unit']):
                continue
            if conflicting(earlier['owns'], later['owns']) or (later['effects'] == 'external' and earlier['effects'] == 'external'):
                edges[later['unit']].append(earlier['unit'])
                notes.append(f'{later["unit"]} serialized after {earlier["unit"]}: overlapping ownership or shared external effects')
    # Cycle guard (declared `after` loops).
    for name in edges:
        if name in reachable(edges, name):
            raise ValueError(f'unit dependency cycle through {name}')
    return edges, notes


def build_unit_dag(selected, units, edges, parallel, domain_agent=None):
    names = set(selected)
    # The domain's own agent is represented by its units, never twice (the repo domain's agent *is* the architect).
    pre = [a for a in selected if a in ROLE_ORDER_PRE and a != domain_agent]
    post = [a for a in selected if a in ROLE_ORDER_POST and a != domain_agent]
    first = ['context-manager'] if 'context-manager' in names else []
    nodes, ids = [], {}
    def add(node_id, agent, deps, **extra):
        nodes.append({'id': node_id, 'agent': agent, 'dependsOn': list(dict.fromkeys(deps)), 'status': 'pending', 'attempts': 0, **extra})
    for agent in first:
        add(agent, agent, [])
    pre_ids = []
    for agent in pre:
        add(agent, agent, first)
        pre_ids.append(agent)
    base = pre_ids or first
    chain_previous = None
    for unit in units:
        node_id = safe_id(unit['agent'], unit['unit'])
        ids[unit['unit']] = node_id
        deps = base + [ids[d] for d in edges[unit['unit']]]
        if not parallel and chain_previous:
            deps.append(chain_previous)
        extra = {'unit': unit['unit'], 'kind': 'external' if unit['effects'] == 'external' else 'write', 'owns': unit['owns'],
                 'reads': unit['reads'], 'weight': unit['weight']}
        if 'timeoutMs' in unit:
            extra['timeoutMs'] = unit['timeoutMs']
        add(node_id, unit['agent'], deps, **extra)
        chain_previous = node_id
    unit_ids = list(ids.values())
    tail = list(unit_ids)
    for agent in post:
        add(agent, agent, unit_ids)
        tail.append(agent)
    gate_deps = tail
    for agent in ('reviewer', 'security-auditor', 'verifier', 'logger'):
        if agent not in names:
            continue
        if agent == 'reviewer':
            deps = gate_deps
        elif agent == 'security-auditor':
            deps = ['reviewer'] if 'reviewer' in names else gate_deps
        elif agent == 'verifier':
            deps = ['security-auditor'] if 'security-auditor' in names else ['reviewer'] if 'reviewer' in names else gate_deps
        else:
            deps = ['verifier'] if 'verifier' in names else gate_deps
        add(agent, agent, deps)
    return nodes


def plan(domain, text, selection, agents, risk_level):
    """Returns {'dag', 'agents', 'plan'|None}. `plan` is None for the historical chain so legacy tasks stay byte-identical."""
    started = time.monotonic()
    legacy = {'dag': build_dag(selection['agents']), 'agents': selection['agents'], 'plan': None}
    mode = planner_mode()
    if mode == 'off' or risk_level == 'LOW':
        return legacy
    names = {a['name'] for a in agents} | ({selection['temporary']['name']} if selection.get('temporary') else set())
    default_agent = next((a for a in selection['agents'] if a not in NON_IMPLEMENTERS and a not in ROLE_ORDER_PRE + ROLE_ORDER_POST),
                         domain['agent'])
    units, source = parse_units(text, default_agent), 'directive'
    if not units and mode == 'auto':
        units, source = auto_units(text, domain, default_agent), 'auto'
    if not units:
        return legacy
    if len(units) > policy()['parallel']['maxNodes'] // 2:
        raise ValueError(f'plan has {len(units)} units; the limit is {policy()["parallel"]["maxNodes"] // 2}')
    validate_units(units, domain, names)
    edges, notes = order_edges(units)
    sequential, parallel_ms, critical = estimate(units, edges)
    minimum = float(__import__('os').environ.get('HARNESS_MIN_SPEEDUP', '1.2'))
    width = max_parallel_width(units, edges)
    speedup = round(sequential / parallel_ms, 2) if parallel_ms else 1.0
    worth = width > 1 and speedup >= minimum
    if source == 'auto' and not worth:
        return {**legacy, 'plan': None}  # nothing declared it, nothing proves it pays off: keep the historical chain
    if not worth:
        notes.append(f'estimated speedup {speedup} is below {minimum} or no independent units: units run as an ordered chain')
    selected = list(dict.fromkeys(selection['agents'] + [u['agent'] for u in units]))
    dag = build_unit_dag(selected, units, edges, worth, domain['agent'])
    # Instance agents stay in the task roster once; the domain agent is replaced by its units.
    roster = list(dict.fromkeys(n['agent'] for n in dag))
    summary = {'source': source, 'parallel': worth, 'units': [u['unit'] for u in units], 'width': width,
               'estimate': {'sequentialMs': round(sequential), 'parallelMs': round(parallel_ms), 'criticalPathMs': round(critical),
                            'speedup': speedup, 'basis': 'declared unit weights; coordinationOverheadMs per extra worker'},
               'notes': notes, 'planMs': round((time.monotonic() - started) * 1000)}
    return {'dag': dag, 'agents': roster, 'plan': summary}


def parallel_capable(dag):
    """True when at least two delegated (non-deterministic) nodes are unordered, i.e. the DAG is not a chain."""
    deps = {n['id']: n['dependsOn'] for n in dag}
    work = [n['id'] for n in dag if n['agent'] not in DETERMINISTIC]
    for i, a in enumerate(work):
        for b in work[i + 1:]:
            if a not in reachable(deps, b) and b not in reachable(deps, a):
                return True
    return False
