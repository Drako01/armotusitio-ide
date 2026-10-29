"""Metadata-first discovery; cached by source fingerprint, never full content."""
import re
import os
from pathlib import Path
from .config import ROOT, H, jread, digest, dumps, tokenize, budget, write_json
from .security import PATH_RULE, contained, matches_path, PROTECTED


def manifests(include_disabled=False):
    return {'domains': [d for d in jread('manifests/domains.json')['domains'] if include_disabled or d.get('enabled') is not False],
            'agents': jread('manifests/agents.json')['agents']}


def get_domain(name):
    for domain in manifests()['domains']:
        if domain['domain'] == name:
            return domain
    raise ValueError('Dominio desconocido o deshabilitado: ' + str(name))


def skill_index():
    entries = {}
    domains = manifests(True)['domains']
    for base in ['.codex/skills', '.claude/skills']:
        directory = ROOT / base
        if not directory.is_dir():
            continue
        for folder in sorted(directory.iterdir()):
            file = folder / 'SKILL.md'
            if not folder.is_dir() or folder.name in entries or not file.is_file():
                continue
            relative = file.relative_to(ROOT).as_posix()
            if not contained(relative):
                raise ValueError('Skill symlink rejected: ' + relative)
            content = file.read_bytes()
            head = content[:1800].decode('utf-8', errors='replace')
            description = re.search(r'description:\s*[>|]-?\r?\n((?:[ \t]+.*\r?\n?)+)', head, re.I)
            fallback = re.search(r'description:\s*(.+)', head, re.I) or re.search(r'^#\s+(.+)', head, re.M)
            description = ' '.join(description[1].split()) if description else (fallback[1] if fallback else '')
            selected_domains = [d['domain'] for d in domains if folder.name in d['skills']]
            entries[folder.name] = {'name': folder.name, 'source': base, 'description': description,
                                    'path': relative, 'domains': selected_domains, 'triggers': selected_domains,
                                    'estimatedTokens': tokenize(content.decode('utf-8', errors='replace')), 'sha256': digest(content)}
    return list(entries.values())


def context_index():
    # Hash only bounded discovery sources, never the repository tree. Timestamp restoration cannot hide drift.
    files = [H / 'manifests/domains.json', H / 'manifests/agents.json', H / 'manifests/policies.json']
    for base in ['.codex/skills', '.claude/skills']:
        directory = ROOT / base
        if directory.exists():
            files += sorted(directory.glob('*/SKILL.md'))
    fingerprint = digest(dumps([(p.relative_to(ROOT).as_posix(), digest(p.read_bytes())) for p in files]))
    cache = H / 'runtime' / 'context-index.json'
    if cache.exists():
        from .config import read_json
        existing = read_json(cache)
        if existing.get('fingerprint') == fingerprint:
            return existing
    value = {'schemaVersion': 1, 'fingerprint': fingerprint,
             'domains': [{k: d.get(k) for k in ['domain', 'agent', 'paths', 'contextSources', 'skills', 'verification',
                         'risks', 'dependencies', 'ownership', 'securityImplications', 'enabled']} for d in manifests(True)['domains']],
             'skills': skill_index()}
    write_json(cache, value)
    return value


def deduplicate(values):
    seen, out = set(), []
    for value in values:
        key = dumps(value)
        if key not in seen:
            seen.add(key)
            out.append(value)
    return out


def context(name, task=''):
    domain = get_domain(name)
    index = context_index()['skills']
    selected = []
    for skill in domain['skills']:
        entry = next((s for s in index if s['name'] == skill), None)
        if not entry:
            raise ValueError('Skill faltante: ' + skill)
        selected.append(entry)
    raw = {'domain': name, 'paths': domain['paths'], 'exclude': domain['exclude'],
           'instructions': deduplicate(domain['instructions']), 'skills': selected,
           'verification': deduplicate(domain['verification']), 'tokenBudget': budget(domain['tokenBudget']),
           'sources': deduplicate(domain['contextSources']), 'task': task, 'pathSemantics': PATH_RULE}
    from .changes import changed_files
    try:
        changes = [f for f in changed_files() if not PROTECTED.search(f) and any(matches_path(f,p) for p in domain['paths']) and not any(matches_path(f,p) for p in domain['exclude'])]
    except ValueError:
        if os.environ.get('HARNESS_BASE'):
            raise
        changes = []  # Isolated no-Git fixtures still validate all scope snapshots.
    if len(changes) <= 30:
        raw['changeSet'] = {'files':changes,'sha256':digest(dumps(changes))}
    else:
        reference = H/'runtime/change-refs'/(digest(dumps(changes))+'.json')
        write_json(reference,changes)
        raw['changeSet'] = {'count':len(changes),'path':reference.relative_to(ROOT).as_posix(),'sha256':digest(dumps(changes))}
    estimate = tokenize(dumps(raw))
    reduced, omissions = False, []
    if estimate > raw['tokenBudget']:
        raw['skills'] = [{k: v for k, v in s.items() if k in ['name', 'path', 'sha256']} for s in selected]
        omissions.append('skill descriptions and optional discovery metadata; full skills referenced by path/hash')
        reduced = True
        estimate = tokenize(dumps(raw))
    if estimate > raw['tokenBudget']:
        raise ValueError('Context budget excedido: task, restrictions and skills cannot be truncated; omitted ' + '; '.join(omissions))
    return {**raw, 'estimatedTokens': estimate, 'reduced': reduced, 'omitted': omissions}
