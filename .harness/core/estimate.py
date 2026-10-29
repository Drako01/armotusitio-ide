"""Duration estimate of a plan from historical telemetry, with conservative policy fallbacks.

No history (or no telemetry module) is not an error: the estimate then rests on `riskPipeline.fallbackMs` and says so
through a `low` confidence. A `disproportion` warning flags cost out of scale with the change size; it never removes a
mandatory verification, it only tells the operator the plan may be heavier than the change deserves.
"""
from .config import policy, NON_IMPLEMENTERS, READ_ONLY

PHASES = ['code', 'tests', 'review', 'verify']
# Fallback minutes per phase and level, used when telemetry has fewer than MIN_SAMPLES (conservative on purpose).
FALLBACK_MS = {'LOW': {'code': 300000, 'tests': 120000, 'review': 0, 'verify': 180000},
               'MEDIUM': {'code': 900000, 'tests': 300000, 'review': 300000, 'verify': 300000},
               'HIGH': {'code': 1500000, 'tests': 600000, 'review': 900000, 'verify': 600000}}
GATE_MS = 120000
MIN_SAMPLES = 3


def settings():
    return {'fallbackMs': FALLBACK_MS, 'gateMs': GATE_MS, 'disproportionMs': 1200000, 'tinyDiffFiles': 3,
            **{k: v for k, v in policy().get('riskPipeline', {}).items() if k in ('fallbackMs', 'gateMs', 'disproportionMs', 'tinyDiffFiles')}}


def stats(kind, key):
    """(count, ms) from telemetry: p90 below 10 samples (conservative), median afterwards. (0, None) without history."""
    try:
        from . import telemetry
        summary = telemetry.summarize(kind, key) or {}
        count = int(summary.get('count') or 0)
        if count < MIN_SAMPLES:
            return count, None
        ms = summary.get('p90Ms') if count < 10 else summary.get('medianMs')
        return count, (int(ms) if ms else None)
    except Exception:  # ImportError, missing log, malformed summary: all mean "no history"
        return 0, None


def phase_of(agent):
    if agent == 'tester':
        return 'tests'
    if agent in READ_ONLY:
        return 'review'
    return None if agent in NON_IMPLEMENTERS else 'code'


def width_of(dag):
    """Largest set of delegated nodes at the same dependency depth (an upper bound of useful parallelism)."""
    depth, by_id = {}, {n['id']: n for n in dag}
    def level(node_id):
        if node_id not in depth:
            depth[node_id] = 1 + max([level(d) for d in by_id[node_id].get('dependsOn', []) if d in by_id] or [0])
        return depth[node_id]
    counts = {}
    for n in dag:
        if phase_of(n['agent']) == 'code':
            counts[level(n['id'])] = counts.get(level(n['id']), 0) + 1
    return max(counts.values() or [1])


def estimate(plan, dag, gates, risk, workers, files=None):
    """{totalMs, perPhase, workers, plannedGates, effectiveParallelism, risk, confidence, basis[, warnings]}."""
    cfg = settings()
    level = risk['level'] if isinstance(risk, dict) else (risk or 'HIGH')
    base = cfg['fallbackMs'].get(level) or cfg['fallbackMs']['HIGH']
    per, samples, basis, nodes = {p: 0 for p in PHASES}, [], [], {p: [] for p in PHASES}
    for node in dag:
        phase = phase_of(node['agent'])
        if phase:
            count, ms = stats('worker', node['agent'])
            samples.append(count)
            nodes[phase].append(ms if ms is not None else None)
            basis.append(f"{node['agent']}: " + (f'history ({count} samples)' if ms is not None else 'policy fallback'))
    for phase in ('code', 'tests', 'review'):
        known = nodes[phase]
        if not known:
            continue
        guess = base[phase] // max(1, len(known))  # the fallback is per phase; split it across the nodes that share it
        per[phase] = sum(ms if ms is not None else guess for ms in known)
    parallelism = max(1, min(int(workers or 1), width_of(dag)))
    if per['code'] and parallelism > 1:
        longest = max(ms for ms in nodes['code'] if ms is not None) if any(ms is not None for ms in nodes['code']) else per['code'] // len(nodes['code'])
        per['code'] = max(longest, per['code'] // parallelism)  # never faster than the longest single node
    planned = [g if isinstance(g, str) else ' '.join(map(str, g)) for g in gates or []]
    gate_ms = []
    for gate in planned:
        count, ms = stats('gate', gate)
        samples.append(count)
        gate_ms.append(ms if ms is not None else cfg['gateMs'])
    per['verify'] = sum(gate_ms) if planned else base['verify']
    if 'verifier' in {n['agent'] for n in dag} and not planned:
        basis.append('verify: policy fallback (no gates declared)')
    total = sum(per.values())
    known_samples = min(samples) if samples else 0
    confidence = 'high' if known_samples >= 20 else 'medium' if known_samples >= 5 else 'low'
    result = {'totalMs': total, 'perPhase': per, 'workers': int(workers or 1), 'plannedGates': planned,
              'effectiveParallelism': parallelism, 'risk': level, 'confidence': confidence,
              'basis': basis or ['policy fallback; no history']}
    size = len(files) if files is not None else (len(risk['files']) if isinstance(risk, dict) and 'files' in risk else None)
    if size is not None and level == 'LOW' and size <= cfg['tinyDiffFiles'] and total > cfg['disproportionMs']:
        result['warnings'] = [{'code': 'disproportion',
                               'message': f'estimated {round(total / 60000)} min for a LOW-risk change of {size} file(s); '
                                          'review the scope. Mandatory verifications are kept.'}]
    return result
