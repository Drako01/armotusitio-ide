"""Fast health and generated role contracts; doctor checks the local environment separately."""
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from .config import ROOT, H, FIXED, READ_ONLY, DETERMINISTIC, jread, validate_schema, policy, setting, gate_timeout_ms, agent_timeout_ms, max_retries
from .context import manifests, context, context_index
from .tasks import list_tasks, load_task
from .security import contained


def agent_doc(agent):
    if agent['name'] in READ_ONLY:
        mode = 'read-only (Codex `read-only` sandbox; Claude without Edit/Write/Bash)'
    elif agent['name'] in DETERMINISTIC:
        mode = 'deterministic node executed by the Harness, no LLM'
    else:
        mode = 'write within scope (Codex `workspace-write`; Claude `acceptEdits`)'
    text = (f'# {agent["name"]}\n\n> Generated from `../manifests/agents.json`. Edit the manifest, then run `pnpm harness:agents-doc`.\n\n'
            f'**Execution mode:** {mode}\n**Token budget:** {agent["tokenBudget"]}\n')
    for title, key in [('Responsibilities', 'responsibilities'), ('Allowed paths', 'allowedPaths'),
                       ('Forbidden paths', 'forbiddenPaths'), ('Skills', 'skills'), ('Context sources', 'contextSources'), ('Verification', 'verification')]:
        text += '\n## ' + title + '\n\n' + ('\n'.join('- ' + str(v) for v in agent[key]) or '- none') + '\n'
    return text


def agents_doc(write=False):
    stale = []
    for agent in manifests(True)['agents']:
        file = H / 'agents' / (agent['name'] + '.md')
        expected = agent_doc(agent)
        # Preserve established generated templates; newline normalization is semantic equivalence.
        current = file.read_text(encoding='utf-8') if file.exists() else None
        if current == expected:
            continue
        if write:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(expected, encoding='utf-8', newline='\n')
        else:
            stale.append(file.name)
    if stale:
        raise ValueError('Contratos de agente desactualizados (pnpm harness:agents-doc): ' + ', '.join(stale))


OPERATIONAL = ('tasks', 'handoffs', 'state', 'logs', 'specs', 'runtime')
# The only versioned placeholders: exact paths, and they must stay empty.
EXPECTED_GITKEEP = frozenset('.harness/' + d + '/.gitkeep' for d in [
    'tasks/inbox', 'tasks/active', 'tasks/completed', 'tasks/failed', 'handoffs', 'state',
    'logs/audit', 'logs/completed', 'logs/execution', 'logs/errors', 'runtime'])
EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
GIT_TIMEOUT = 30


def git_read(args, cwd, toplevel=None):
    """Read-only git call; `safe.directory` avoids dubious-ownership failures on copied trees (no writes happen).
    The locale is forced to C so the "not a git repository" detection does not depend on git's translations."""
    prefix = ['git'] + (['-c', 'safe.directory=' + toplevel] if toplevel else [])
    try:
        return subprocess.run(prefix + args, cwd=cwd, capture_output=True, timeout=GIT_TIMEOUT,
                              env={**os.environ, 'LC_ALL': 'C', 'LANGUAGE': 'C'})
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError('No se pudo consultar git para el gate de estado local (falla cerrada): ' + str(error))


def versioned_state():
    """Offending tracked operational paths (anything but empty, expected `.gitkeep`); None without a git repository."""
    top = git_read(['rev-parse', '--show-toplevel'], ROOT, str(ROOT))
    if top.returncode:
        message = top.stderr.decode('utf-8', errors='replace').strip()
        if 'not a git repository' in message.lower() and 'dubious ownership' not in message.lower():
            return None
        raise ValueError('git rev-parse --show-toplevel falló (código ' + str(top.returncode) + '): ' + message)
    toplevel = top.stdout.decode('utf-8', errors='replace').strip()
    if not toplevel:
        raise ValueError('git rev-parse --show-toplevel no devolvió ruta')
    root = Path(ROOT).resolve()
    top_path = Path(toplevel).resolve()
    try:
        prefix = root.relative_to(top_path).as_posix()
    except ValueError:
        raise ValueError('El Harness no está dentro del toplevel de git: ' + toplevel)
    base = '.harness/' if prefix in ('', '.') else prefix + '/.harness/'
    run = git_read(['-C', toplevel, 'ls-files', '-z', '-s', '--'] + [base + d for d in OPERATIONAL], toplevel, toplevel)
    if run.returncode:
        raise ValueError('git ls-files falló (código ' + str(run.returncode) + '): ' +
                         run.stderr.decode('utf-8', errors='replace').strip())
    bad = []
    for entry in run.stdout.decode('utf-8', errors='replace').split('\0'):
        if not entry:
            continue
        meta, _, path = entry.partition('\t')
        blob = meta.split()[1] if len(meta.split()) > 1 else ''
        rel = path[len(base) - len('.harness/'):]
        if rel in EXPECTED_GITKEEP and blob == EMPTY_BLOB:
            continue
        bad.append(rel)
    return sorted(bad)


def state_gate():
    files = versioned_state()
    if files:
        shown = '\n'.join('  ' + f for f in files[:20]) + ('\n  ... (+' + str(len(files) - 20) + ')' if len(files) > 20 else '')
        if len(files) <= 20:
            fix = 'git rm --cached --ignore-unmatch -- ' + ' '.join(shlex.quote(f) for f in files)
        else:
            fix = ("git ls-files -z -- " + ' '.join('.harness/' + d for d in OPERATIONAL) +
                   " | grep -zv '/\\.gitkeep$' | xargs -0 git rm --cached --")
        raise ValueError('El estado operacional del Harness es local y no se versiona; hay ' + str(len(files)) +
                         ' archivo(s) en el índice de git (sólo se permiten los .gitkeep vacíos esperados):\n' + shown +
                         '\nSolución (no borra los archivos del disco ni toca los .gitkeep): ' + fix)


def check():
    for item in ['manifests/domains.json', 'manifests/agents.json', 'README.md', 'tasks/inbox',
                 'tasks/active', 'tasks/completed', 'tasks/failed', 'handoffs', 'state', 'logs/execution',
                 'logs/errors', 'logs/audit', 'logs/completed', 'cli.py', 'core', 'manifests/python-runtime.json']:
        if not (H / item).exists() or not contained('.harness/' + item):
            raise ValueError('Falta / unsafe Harness layout ' + item)
    for name in ['agents', 'domains', 'policies', 'python-runtime', 'ci-parity']:
        errors = validate_schema(jread('manifests/' + name + '.json'), jread('manifests/' + name + '.schema.json'))
        if errors:
            raise ValueError('Manifest ' + name + '.json inválido: ' + '; '.join(errors[:5]))
    gate_timeout_ms(), agent_timeout_ms(), max_retries()
    setting('HARNESS_CONTEXT_BUDGET', policy()['contextBudget'])
    runtime_metadata = jread('manifests/python-runtime.json')
    if not tuple(runtime_metadata['minimum']) <= sys.version_info[:2] <= tuple(runtime_metadata['maximum']):
        raise ValueError('Unsupported Python; use Node bootstrap')
    values = manifests(True)
    names = {a['name'] for a in values['agents']}
    if not set(FIXED).issubset(names) or len(names) != len(values['agents']):
        raise ValueError('Missing or duplicate fixed agents')
    if len({d['domain'] for d in values['domains']}) != len(values['domains']):
        raise ValueError('Duplicate domains')
    index = context_index()
    for agent in values['agents']:
        for skill in agent['skills']:
            if not any(s['name'] == skill for s in index['skills']):
                raise ValueError('Missing role skill: ' + skill)
    for domain in values['domains']:
        if domain['agent'] not in names:
            raise ValueError('Dominio ' + domain['domain'] + ' refiere agente inexistente')
        if domain.get('enabled') is not False:
            context(domain['domain'])
        from .security import command_policy
        for gate in domain['verification']:
            if not gate:
                raise ValueError('Empty domain check')
            command_policy(gate[0], gate[1:], trusted=True)
        for dependency in domain.get('dependencies', []):
            if dependency not in {d['domain'] for d in values['domains']}:
                raise ValueError('Unknown domain dependency: ' + dependency)
    good = {'status': 'passed', 'changes': [], 'files': [], 'decisions': [], 'risks': [], 'verification': [], 'nextAction': None}
    schema = jread('manifests/agent-result.schema.json')
    if validate_schema(good, schema) or not validate_schema({'status': 'passed'}, schema):
        raise ValueError('Invalid result schema contract')
    handoff_schema = jread('manifests/handoff.schema.json')
    sample = {'schemaVersion':1,'taskId':'fixture','domain':'repo','agent':'architect','attempt':1,'at':'fixture', **good}
    if validate_schema(sample, handoff_schema) or not validate_schema({**sample,'attempt':0}, handoff_schema):
        raise ValueError('Invalid handoff schema contract')
    task_schema = jread('manifests/task.schema.json')
    sample_task = {'schemaVersion':1,'id':'fixture1','status':'active','task':'fixture','domain':'repo'}
    if validate_schema(sample_task,task_schema) or not validate_schema({**sample_task,'status':'done'},task_schema):
        raise ValueError('Invalid task schema contract')
    legacy_node={'id':'architect','agent':'architect','dependsOn':[],'status':'pending','attempts':0}
    planned_node={'id':'documentation-a','agent':'documentation','unit':'a','kind':'write','owns':['docs/a/**'],'dependsOn':['context-manager'],'status':'running','attempts':1,'runId':'abc','claim':None}
    if (validate_schema({**sample_task,'dag':[legacy_node,planned_node]},task_schema)
            or not validate_schema({**sample_task,'dag':[{**legacy_node,'status':'done'}]},task_schema)
            or not validate_schema({**sample_task,'dag':[{**planned_node,'owns':'docs/a/**'}]},task_schema)
            or not validate_schema({**sample_task,'dag':[{k:v for k,v in legacy_node.items() if k!='agent'}]},task_schema)):
        raise ValueError('Invalid task DAG node contract (legacy and planned nodes must validate; malformed ones must not)')
    for row in list_tasks():
        try:
            load_task(row['id'])
        except ValueError as error:
            if row['status'] != 'failed':
                raise
            print('[harness] Legacy failed evidence ' + row['id'] + ' is not retryable: ' + str(error) + '. Run: pnpm harness:hygiene -- --quarantine-invalid --yes', file=sys.stderr)
    agents_doc(False)
    state_gate()
    package_file = ROOT / 'package.json'
    package = json.loads(package_file.read_text(encoding='utf-8')) if package_file.is_file() else {}
    manager = package.get('packageManager')
    if manager is not None and (not isinstance(manager, str) or not manager):
        raise ValueError('Invalid packageManager')
    for executable in ['node', 'git']:
        if not shutil.which(executable):
            raise ValueError('Missing ' + executable)
    # Validate pnpm only when the workspace explicitly selects it.
    # VS Code and npm workspaces must not be forced to adopt pnpm.
    from .runner import spawn_run
    node = spawn_run('node', ['--version'], {'trusted': True, 'persist': False, 'timeoutMs': 5000})
    if node['code'] or int(node['out'].strip().lstrip('v').split('.')[0]) < 24:
        raise ValueError('Node >=24 required')
    if manager and manager.startswith('pnpm@'):
        if not shutil.which('pnpm'):
            raise ValueError('Missing pnpm')
        pnpm = spawn_run('pnpm', ['--version'], {'trusted': True, 'persist': False, 'timeoutMs': 10000})
        expected_pnpm = manager.removeprefix('pnpm@').split('+', 1)[0]
        if pnpm['code'] or pnpm['out'].strip() != expected_pnpm:
            raise ValueError('pnpm version must match packageManager' + ('; ' + pnpm['err'] if pnpm['code'] else ''))
    print('Harness check: OK (Python ' + sys.version.split()[0] + ' via ' + python_source() + ')')


PYTHON_SOURCES = ['managed', 'HARNESS_PYTHON', 'PATH']


def python_source():
    """Origin label exported by the shared Node launcher env; unknown values report as direct, never echoed."""
    source = os.environ.get('HARNESS_PYTHON_SOURCE', '')
    return source if source in PYTHON_SOURCES else 'direct'


def doctor():
    host = os.environ.get('HARNESS_HOST', '').lower()
    rows = [{'component': 'Python', 'status': 'PASS', 'version': sys.version.split()[0], 'path': sys.executable,
             'source': python_source()}]
    for binary in ['node', 'pnpm', 'git', 'codex', 'claude']:
        executable = shutil.which(binary)
        required = binary in ['node', 'pnpm', 'git'] or binary == host
        rows.append({'component': binary, 'status': 'PASS' if executable else 'FAIL' if required else 'WARN',
                     'path': executable})
    rows.append({'component': 'HARNESS_HOST', 'status': 'PASS' if host in ['codex', 'claude'] or os.environ.get('HARNESS_AGENT_COMMAND') else 'WARN', 'host': host or None})
    return rows
