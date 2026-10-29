#!/usr/bin/env python3
"""Apply additive IDE command registration to a checked-out ArmoTuSitio IDE branch."""
from pathlib import Path
import json
import subprocess
import sys

root = Path.cwd()
ext = root / 'extensions/armotusitio-ide'
source = ext / 'extension.ts'
pkgfile = ext / 'package.json'
if not source.is_file() or not pkgfile.is_file():
    raise SystemExit('Run from the repository root after extracting the package.')
branch = subprocess.run(['git', 'branch', '--show-current'], text=True, capture_output=True, check=True).stdout.strip()
if branch != 'feat/harness':
    raise SystemExit(f'Expected feat/harness, got {branch!r}; nothing changed.')
text = source.read_text(encoding='utf-8')
import_line = "const { registerNativeHarness } = require('./src/native-integration.ts');\n"
if import_line not in text:
    marker = "const repeatActions = ['check', 'verify', 'test'];"
    if text.count(marker) != 1:
        raise SystemExit('Extension registration marker differs; no changes made.')
    text = text.replace(marker, import_line + marker)
call = "\tregisterNativeHarness(context, vscode);\n"
if call not in text:
    marker = "\tconst controller = new Controller(context);\n"
    if text.count(marker) != 1:
        raise SystemExit('Activation marker differs; no changes made.')
    text = text.replace(marker, marker + call)

pkg = json.loads(pkgfile.read_text(encoding='utf-8'))
commands = pkg['contributes']['commands']
new = [
 ('atsHarness.nativeDoctor', 'ArmoTuSitio: Diagnóstico del Harness nativo'),
 ('atsHarness.nativeNewTask', 'ArmoTuSitio: Crear tarea nativa'),
 ('atsHarness.nativeRunTask', 'ArmoTuSitio: Ejecutar tarea nativa'),
 ('atsHarness.nativeStatus', 'ArmoTuSitio: Estado de tareas nativas'),
 ('atsHarness.nativeReconcile', 'ArmoTuSitio: Reconciliar estado nativo'),
 ('atsHarness.nativeCancel', 'ArmoTuSitio: Cancelar tarea nativa'),
]
for name, title in new:
    if not any(c['command'] == name for c in commands):
        commands.append({'command': name, 'title': title})
# Keep original package formatting near untouched to minimize the VS Code upstream diff.
raw = pkgfile.read_text(encoding='utf-8')
if 'atsHarness.nativeDoctor' not in raw:
    # The first commands array belongs to chatParticipants; target the extension contributes.commands.
    marker = '    "commands": [\n'
    if raw.count(marker) != 2:
        raise SystemExit('Expected exactly two command arrays; no changes made.')
    inserts = ''.join('      { "command": ' + json.dumps(n, ensure_ascii=False) + ', "title": ' + json.dumps(t, ensure_ascii=False) + ' },\n' for n, t in new)
    pos = raw.rfind(marker)
    raw = raw[:pos] + raw[pos:].replace(marker, marker + inserts, 1)
# Validate the final package JSON and confirm contributed command registration.
parsed = json.loads(raw)
registered = {x['command'] for x in parsed['contributes']['commands']}
if any(n not in registered for n, _ in new):
    raise SystemExit('Native command registration failed; nothing changed.')
source.write_text(text, encoding='utf-8')
pkgfile.write_text(raw, encoding='utf-8')
print('Applied native Harness command integration to feat/harness. No commit or push performed.')
