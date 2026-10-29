"""Risk-proportional pipeline: deterministic LOW/MEDIUM/HIGH from the real diff plus task text, scope and dependencies.

LOW    docs, isolated visual change (css/markup inside one portal), nothing sensitive: implementer + affected gates.
MEDIUM business logic, shared packages/components, functional changes: implementer + reviewer (+ tester by text).
HIGH   authentication, authorization, RBAC, tenancy, migrations, contracts, infra, security, CI, .harness core:
       implementer + reviewer + security-auditor + every mandatory verification.

Fail closed: any error while classifying, or an unreadable diff, is HIGH. A level can never remove a mandatory control:
a sensitive category (auth, rbac, tenancy, migrations, secrets, infra, security) always mandates the security-auditor.
"""
import re
from .config import policy, recommended_workers, agent_timeout_ms
from .routing import risk as legacy_risk

LEVELS = ['LOW', 'MEDIUM', 'HIGH']
# category -> (path regex, text regex); every hit forces HIGH. SENSITIVE ones also mandate the security-auditor.
CATEGORIES = {
    'authentication': (r'(?:^|[/_.-])(?:auth(?!or)|login|jwt|oauth|session)', r'auth(?!or)|autenticaci|autorizaci|login|jwt|oauth|password|contrase'),
    'rbac': (r'rbac|permission|permiso|(?:^|/)roles?(?:/|\.|$)', r'rbac|permission|permiso'),
    'tenancy': (r'tenan|organi[sz]ation|organizacion', r'tenan|organi[sz]ation|organizaci|aislamiento'),
    'migrations': (r'migrat|migraci|\.sql$', r'migrat|migraci'),
    'secrets': (r'secret|(?:^|/)\.env|credential|\.pem$|\.key$', r'secret|credential|credencial'),
    'infra': (r'(?:^|/)infra(?:/|$)|terraform|docker|\.tf$|helm|k8s', r'infra|terraform|docker|deploy'),
    'security': (r'securit|segurid|csrf|cors', r'securit|segurid|csrf|xss'),
    'contracts': (r'openapi|swagger|\.proto$|contrat', r'openapi|swagger|contrat'),
    'ci': (r'^\.github/|(?:^|/)workflows?/', r'github actions|ci/cd|\bworkflows? de ci\b'),
}
SENSITIVE = ['authentication', 'rbac', 'tenancy', 'migrations', 'secrets', 'infra', 'security']
DOC = re.compile(r'(?:\.(?:md|mdx|txt)$)|^docs/', re.I)
VISUAL = re.compile(r'\.(?:css|scss|sass|less|svg|html|png|jpe?g|webp|ico|woff2?)$', re.I)
# A documentation-only diff never lowers the risk of a task whose text announces dependency or runtime work.
DEP_TEXT = re.compile(r'package\.json|dependenc|runtime|lockfile|go\.mod|go\.sum', re.I)
LOGIC_TEXT = re.compile(r'\b(api|endpoint|l[oó]gica|logic|validaci[oó]n|validation|estado|state|fetch|query|schema|servicio|service|hook|store)\b', re.I)
SHARED = re.compile(r'^(?:packages|shared|libs?)/')


def sensitivity(files, text):
    """{category: [evidence]} from paths and free text; policy highRiskPattern is reported as its own category."""
    found = {}
    for name, (path_rx, text_rx) in CATEGORIES.items():
        hits = [p for p in files if re.search(path_rx, p, re.I)]
        if re.search(text_rx, text, re.I):
            hits.append('task text')
        if hits:
            found[name] = hits[:5]
    core = [p for p in files if p.startswith('.harness/') and not p.endswith('.md')]
    if core:
        found['harness-core'] = core[:5]
    if not found and re.search(policy()['highRiskPattern'], text + ' ' + ' '.join(files), re.I):
        found['policy-pattern'] = ['highRiskPattern']
    return found


def apply_enabled():
    """Opt-in (policies.json riskPipeline.apply, default false): until enabled the chain selection stays historical."""
    return bool(policy().get('riskPipeline', {}).get('apply', False))


def portal(path):
    parts = path.split('/')
    return '/'.join(parts[:2]) if parts[0] == 'apps' and len(parts) > 2 else None


def mandatory_for(level, sensitive=False):
    """Agents/controls that cannot be dropped at `level`; `sensitive` adds the auditor whatever the level says."""
    out = ['implementer', 'verifier']
    if level in ('MEDIUM', 'HIGH'):
        out.insert(1, 'reviewer')
    if level == 'HIGH' or sensitive:
        out.insert(2 if 'reviewer' in out else 1, 'security-auditor')
    if level == 'HIGH' or sensitive:
        out.append('full-verification')
    return out


def classify(files=None, task='', domain=None, scope=None, dependencies=None):
    """Deterministic classification. `files=None` reads the real diff (core.changes); any failure is HIGH (fail closed)."""
    try:
        if files is None:
            from .changes import changed_files
            files = changed_files(allow_unversioned=True)
        return assess(list(files), task or '', domain, list(scope or []), list(dependencies or []))
    except Exception as error:
        return {'level': 'HIGH', 'reasons': [f'classification failed ({type(error).__name__}); failing closed'], 'files': [],
                'sensitive': True, 'categories': [], 'mandatory': mandatory_for('HIGH', True), 'failedClosed': True}


def assess(files, task, domain, scope, dependencies):
    reasons, touched = [], files + scope + dependencies
    found = sensitivity(touched, task)
    sensitive = any(c in found for c in SENSITIVE)
    if found:
        level = 'HIGH'
        reasons += [f'{name}: {", ".join(hits)}' for name, hits in found.items()]
    elif domain in ('api', 'infra'):
        level, reasons = 'HIGH', [f'domain {domain} is always high risk']
    elif files and all(DOC.search(p) for p in files) and (domain == 'docs' or not (LOGIC_TEXT.search(task) or DEP_TEXT.search(task))):
        level, reasons = 'LOW', ['documentation only']
    elif files and all(VISUAL.search(p) for p in files) and len({portal(p) for p in files}) == 1 and None not in {portal(p) for p in files} \
            and not LOGIC_TEXT.search(task) and not any(SHARED.search(p) for p in dependencies + scope):
        level, reasons = 'LOW', ['isolated visual change inside one portal']
    elif not files and not task.strip():
        level, reasons = 'LOW', ['no change and no task']
    else:
        level = 'MEDIUM'
        reasons.append('shared package or component' if any(SHARED.search(p) for p in touched) else 'functional or business-logic change')
    # Never below the legacy classifier when it already saw a reason for HIGH (compatible extension, not a replacement).
    legacy = legacy_risk(files, task, domain)
    if legacy == 'HIGH' and level != 'HIGH':
        level, sensitive = 'HIGH', True
        reasons.append('legacy routing.risk classified HIGH')
    return {'level': level, 'reasons': reasons, 'files': files, 'sensitive': sensitive, 'categories': sorted(found),
            'mandatory': mandatory_for(level, sensitive)}


def explain(result):
    """Human-readable, multi-line explanation of a classification."""
    lines = [f"risk {result['level']}" + (' (failed closed)' if result.get('failedClosed') else '')]
    lines += ['  - ' + r for r in result['reasons']]
    lines.append(f"  files: {len(result['files'])}; mandatory: {', '.join(result['mandatory'])}")
    if result['sensitive']:
        lines.append('  security-auditor is mandatory: sensitive area touched')
    return '\n'.join(lines)


# Orientative initial workers per task class: (min, max). The scheduler still decides; plan width is the real ceiling.
BUDGETS = {'LOW': ('small', 1, 1), 'MEDIUM': ('medium', 2, 3), 'HIGH': ('critical', 3, 5)}
TIMEOUT_SHARE = {'LOW': 0.34, 'MEDIUM': 0.67, 'HIGH': 1.0}


def budget_for(level, plan=None):
    """Execution budget hint per task type. Transversal refactors (wide parallel plans) are sized by their DAG."""
    kind, low, high = BUDGETS.get(level, BUDGETS['HIGH'])
    width = int((plan or {}).get('width') or 1) if (plan or {}).get('parallel') else 1
    if width > high and (plan or {}).get('parallel'):
        kind, low, high = 'transversal', 1, recommended_workers(width)
    initial = max(1, min(high, width))
    return {'class': kind, 'workers': {'min': low, 'max': high}, 'initialWorkers': initial, 'planWidth': width,
            'agentTimeoutMs': int(agent_timeout_ms() * TIMEOUT_SHARE.get(level, 1.0)) if agent_timeout_ms() else 0,
            'basis': 'orientative hint combined with the plan width; the scheduler decides'}
