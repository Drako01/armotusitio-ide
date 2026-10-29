"""Opt-in real-host smoke, isolated workspace and compact sanitized evidence."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from .config import ROOT, H, now, task_id, write_json
from .security import redact


def smoke_host(host):
    if host not in ['codex', 'claude']:
        raise ValueError('Usage: harness:smoke-host <codex|claude>')
    with tempfile.TemporaryDirectory(prefix='redevent-host-smoke-') as directory:
        root = Path(directory)
        harness = root / '.harness'
        for name in ['manifests', 'core', 'agents']:
            shutil.copytree(H / name, harness / name, ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copy2(H / 'cli.py', harness / 'cli.py')
        shutil.copytree(ROOT / '.codex/skills', root / '.codex/skills')
        if (ROOT / 'AGENTS.md').exists():
            shutil.copy2(ROOT / 'AGENTS.md', root / 'AGENTS.md')
        for name in ['tasks/inbox', 'tasks/active', 'tasks/failed', 'tasks/completed', 'handoffs', 'state', 'runtime',
                     'logs/audit', 'logs/execution', 'logs/errors', 'logs/completed']:
            (harness / name).mkdir(parents=True, exist_ok=True)
        file = harness / 'manifests/domains.json'
        domains = json.loads(file.read_text())
        next(d for d in domains['domains'] if d['domain'] == 'repo')['verification'] = [[sys.executable, '-I', '-S', '-B', '-c',
            "from pathlib import Path; assert Path('smoke-artifact.txt').read_text().strip() == 'HARNESS_REAL_HOST_SMOKE'"]]
        file.write_text(json.dumps(domains))
        env = {**os.environ, 'HARNESS_HOST':host, 'HARNESS_AGENT_COMMAND':'', 'HARNESS_MAX_RETRIES':'0', 'HARNESS_AGENT_TIMEOUT_MS':'180000'}
        def call(*args):
            return subprocess.run([sys.executable, '-I', '-S', '-B', '-X', 'utf8', str(harness/'cli.py'), *args],
                                  cwd=root, env=env, capture_output=True, text=True, encoding='utf-8', timeout=600)
        created = call('run','repo', 'REAL HOST SMOKE ONLY. Architect: create root file smoke-artifact.txt containing exactly HARNESS_REAL_HOST_SMOKE and declare it in files. Reviewer: verify that exact file/content without edits. Return evidence of checks performed. Do not modify anything else.')
        if created.returncode:
            report = {'host':host,'at':now(),'status':'blocked','error':redact(created.stderr[-1500:])}
        else:
            task = json.loads(created.stdout)
            executed = call('execute', task['id'])
            try:
                final_task = json.loads(executed.stdout)
            except ValueError:
                final_task = {}
            report = {'host':host,'at':now(),'taskId':task['id'],'exit':executed.returncode,
                      'status':'passed' if executed.returncode == 0 and final_task.get('status') == 'completed' else 'blocked',
                      'stderr':redact(executed.stderr[-1500:]),
                      'nodes':[{k:n[k] for k in ['agent','status','attempts']} for n in final_task.get('dag',[])],
                      'handoffRefs':[]}
            for handoff in (harness/'handoffs').glob(task['id']+'-*.json'):
                value = json.loads(handoff.read_text())
                report['handoffRefs'].append({'agent':value['agent'],'status':value['status'],'risks':value['risks'],
                                               'verification':value['verification']})
    evidence = H/'logs/audit'/('real-host-smoke-'+host+'-'+task_id()+'.json')
    write_json(evidence, report)
    return {**report,'evidence':evidence.relative_to(ROOT).as_posix()}
