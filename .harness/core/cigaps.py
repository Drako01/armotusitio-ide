"""Bidirectional CI <-> Harness parity report. Stdlib only, no network, no YAML dependency.

CI -> Harness: every verification command found in .github/workflows/*.yml is classified as ignored (setup), covered by a
domain gate, covered by a dependency-graph check (`targeted`), CI-only (documented exception) or uncovered.
Harness -> CI: every JS workspace standard script, every enabled-domain gate and every enabled domain with apps/<x>/ paths
must be exercised by CI, or be a documented local-only gate. All exceptions live in manifests/ci-parity.json.

A CI step only counts as coverage when it can fail the workflow: `continue-on-error: true`, a command followed by
`|| true`/`|| :` and a literally false `if:` make it `soft` (never coverage). When a workflow has a `required` job, the
covering job must also be in its (transitive) `needs`; otherwise the row is `not-required`. `uncovered` and
`not-required` are the gaps `--strict` fails on.
"""
import json
import posixpath
import re
from fnmatch import fnmatchcase
from itertools import product
from . import config, impact
from .config import UsageError
from .context import manifests

VERIFY_EXECUTABLES = {'pnpm', 'npm', 'npx', 'yarn', 'node', 'go', 'gofmt', 'golangci-lint', 'bash', 'sh', 'docker',
                      'python', 'python3', 'make', 'uses'}
HARNESS_ENTRYPOINTS = ['.harness/core.mts', '.harness/bootstrap.mts']
SHELL_KEYWORDS = {'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time', '{', 'env'}
PNPM_BUILTINS = {'install', 'i', 'add', 'exec', 'dlx', 'config', 'store', 'setup', 'update', 'remove', 'rebuild'}
BLOCK_SCALAR = re.compile(r'^[|>][+-]?\d*$')
ASSIGNMENT = re.compile(r'^([A-Za-z_]\w*)=(.*)$', re.S)
VARIABLE = re.compile(r'\$\{(\w+)\}|\$(\w+)')
REQUIRED_JOB = 'required'
GAPS = ('uncovered', 'not-required')
FALSE_LITERALS = {'false', '0', '!true'}
DIRNAME = re.compile(r'^\$\(\s*dirname\s+"?\$\{?(\w+)\}?"?\s*\)$')


# --- manifest -------------------------------------------------------------------------------------------------------

def load_manifest():
    manifest = config.jread('manifests/ci-parity.json')
    errors = config.validate_schema(manifest, config.jread('manifests/ci-parity.schema.json'))
    if errors:
        raise ValueError('Manifest ci-parity.json inválido: ' + '; '.join(errors[:5]))
    return manifest


def entry_match(entry, tokens):
    """Entries match a whole-token prefix of the normalized command (fnmatch per token); withFlag needs one extra token."""
    pattern = entry['match'].split()
    if len(tokens) < len(pattern) or not all(fnmatchcase(t, p) for t, p in zip(tokens, pattern)):
        return False
    return 'withFlag' not in entry or any(fnmatchcase(t, entry['withFlag']) for t in tokens[len(pattern):])


def first_entry(entries, tokens):
    return next((e for e in entries if entry_match(e, tokens)), None)


# --- workflow parsing -----------------------------------------------------------------------------------------------

def expression(value):
    """`${{ x }}` -> x, lowercased and unquoted."""
    value = re.sub(r'^\$\{\{(.*)\}\}$', r'\1', str(value).strip()).strip().strip('"\'').strip()
    return value.lower()


def soft_reason(step):
    """Why a step cannot fail the job (or never runs), else None. `steps.<id>.outputs.* == 'true'` guards still cover."""
    if expression(step.get('continue-on-error', '')) == 'true':
        return 'continue-on-error: true'
    if 'if' in step and expression(step['if']) in FALSE_LITERALS:
        return 'if: ' + step['if'] + ' (never runs)'
    return None


def parse_needs(text):
    """{job: [needed jobs]} from `needs:` as scalar, inline list or block list."""
    needs, job, in_jobs, collecting = {}, None, False, False
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith('#'):
            continue
        indent = len(raw) - len(raw.lstrip(' '))
        if indent == 0:
            in_jobs, job, collecting = stripped == 'jobs:', None, False
        elif not in_jobs:
            continue
        elif indent == 2 and re.match(r'^[\w.-]+:\s*$', stripped):
            job, collecting = stripped[:-1].strip(), False
            needs[job] = []
        elif job is not None and indent == 4:
            collecting = False
            match = re.match(r'^needs:\s*(.*)$', stripped)
            if match:
                value = match.group(1).split(' #')[0].strip()
                if value.startswith('['):
                    needs[job] += [x.strip().strip('"\'') for x in value.strip('[]').split(',') if x.strip()]
                elif value:
                    needs[job].append(value.strip('"\''))
                else:
                    collecting = True
        elif job is not None and collecting and indent > 4 and stripped.startswith('- '):
            needs[job].append(stripped[2:].split(' #')[0].strip().strip('"\''))
    return needs


def parse_workflow(text):
    """Line-oriented extraction of steps: [{'job', 'run', 'uses', 'cwd'}]. Understands `run: x`, `run: |`/`>` blocks."""
    lines, steps = text.splitlines(), []
    state = {'job': None, 'step': None, 'cwd': '.', 'steps': False, 'step_indent': None, 'key_indent': None}

    def flush():
        if state['step'] and (state['step'].get('run') is not None or state['step'].get('uses')):
            steps.append({'job': state['job'], 'run': state['step'].get('run'), 'uses': state['step'].get('uses'),
                          'cwd': state['step'].get('cwd', state['cwd']), 'soft': soft_reason(state['step']),
                          'shell': state['step'].get('shell', '')})
        state['step'] = None

    def scalar(value):
        value = value.strip()
        return value[1:-1] if len(value) > 1 and value[0] == value[-1] and value[0] in '"\'' else value

    i, in_jobs = 0, False
    while i < len(lines):
        raw = lines[i]
        i += 1
        stripped = raw.strip()
        if not stripped or stripped.startswith('#'):
            continue
        indent = len(raw) - len(raw.lstrip(' '))
        if indent == 0:
            flush()
            in_jobs, state['job'], state['steps'] = stripped == 'jobs:', None, False
            continue
        if not in_jobs:
            continue
        if indent == 2 and re.match(r'^[\w.-]+:\s*$', stripped):
            flush()
            state.update(job=stripped[:-1].strip(), cwd='.', steps=False, step_indent=None)
            continue
        if state['job'] is None:
            continue
        if stripped == 'steps:':
            state['steps'] = True
            continue
        content, key_indent = stripped, indent
        if state['steps'] and stripped.startswith('- ') and (state['step_indent'] in (None, indent)):
            flush()
            state['step_indent'], state['step'] = indent, {}
            content = stripped[2:].strip()
            key_indent = indent + 2
            state['key_indent'] = key_indent
        elif state['step'] is None or indent != state['key_indent']:
            if not state['steps'] and re.match(r'^working-directory:', stripped):
                state['cwd'] = scalar(stripped.split(':', 1)[1]) or '.'
            continue
        match = re.match(r'^([\w-]+):\s*(.*)$', content)
        if not match or state['step'] is None:
            continue
        key, value = match.group(1), match.group(2)
        if key == 'uses':
            state['step']['uses'] = scalar(value.split(' #')[0])
        elif key == 'working-directory':
            state['step']['cwd'] = scalar(value.split(' #')[0]) or '.'
        elif key in ('if', 'continue-on-error', 'shell'):
            state['step'][key] = scalar(value.split(' #')[0])
        elif key == 'run':
            if BLOCK_SCALAR.match(value.strip()):
                body = []
                while i < len(lines) and (not lines[i].strip() or len(lines[i]) - len(lines[i].lstrip(' ')) > key_indent):
                    body.append(lines[i])
                    i += 1
                width = min([len(b) - len(b.lstrip(' ')) for b in body if b.strip()] or [0])
                body = [b[width:] for b in body]
                state['step']['run'] = (' '.join if value.startswith('>') else '\n'.join)(body)
            else:
                state['step']['run'] = scalar(value)
    flush()
    return steps


# --- shell parsing --------------------------------------------------------------------------------------------------

def balanced(text, i):
    """Index just after the `)` closing the `$(` that starts at text[i] (parenthesis depth only)."""
    depth, j = 0, i + 1
    while j < len(text):
        depth += (text[j] == '(') - (text[j] == ')')
        j += 1
        if depth == 0:
            break
    return j


class Words(list):
    """One shell command; `soft` is the reason its failure cannot fail the step (empty when it can)."""
    soft = ''


CONDITION_KEYWORDS = {'if', 'elif', 'while', 'until'}
BODY_KEYWORDS = {'then', 'do'}


def option_flags(words):
    """(errexit, pipefail) change made by a `set` command: True = turned on, False = turned off, None = untouched."""
    errexit = pipefail = None
    for index, word in enumerate(words[1:], 1):
        if len(word) < 2 or word[0] not in '-+' or word.startswith('--'):
            continue
        if 'e' in word[1:]:
            errexit = word[0] == '-'
        if 'o' in word[1:] and words[index + 1:index + 2] == ['pipefail']:
            pipefail = word[0] == '-'
    return errexit, pipefail


OR_REASON = 'command followed by || (its failure is handled by the alternative)'
NEGATED_REASON = 'negated with !'


def propagates_failure(words, last_status):
    """True for a command that makes the shell fail: `false`, `exit N` (N > 0) and, where `last_status` is a failure
    (the alternative of `||`), a bare `exit` or `exit $?`."""
    if words[:1] == ['false']:
        return len(words) == 1
    if words[:1] != ['exit'] or len(words) > 2:
        return False
    if len(words) == 1 or words[1] in ('$?', '${?}'):
        return last_status
    return words[1].isdigit() and int(words[1]) > 0


def tokenize(text, pipefail=False):
    """Split shell text into commands (lists of unquoted words). Separators: newline ; & | && || ( ). Redirections and
    heredoc bodies are dropped; `$(...)` stays verbatim inside its word.

    A command is `soft` (its failure cannot fail the step) when it is: followed by or an alternative of `||`; a condition
    of `if`/`elif`/`while`/`until`; negated with `!`; run after `set +e`; or the non-last side of a pipe without pipefail
    (`pipefail` is the initial state: `shell: bash` enables it, `set -o pipefail` too)."""
    text = re.sub(r'\\\r?\n\s*', ' ', text)
    commands, words, current, i, n = [], [], None, 0, len(text)
    heredocs = []
    statement, alternative, condition, errexit = 0, False, False, True
    handled = []  # commands made soft by the last `||`; they are hard again when its alternative propagates the failure
    guard = [None, False]  # [`if ! cmd` command, `then` already seen on its own]

    def end_word():
        nonlocal current
        if current is not None:
            words.append(current)
            current = None

    def end_command():
        nonlocal condition, errexit, pipefail
        end_word()
        if words:
            if guard[0] is not None and (guard[1] or words[0] == 'then'):
                body = words if guard[1] else words[1:]
                if body or guard[1]:
                    if guard[0].soft == NEGATED_REASON and propagates_failure(body, False):
                        guard[0].soft = ''  # `if ! cmd; then exit 1; fi` fails the step when cmd fails
                    guard[0] = None
                else:
                    guard[1] = True
            elif guard[0] is not None:
                guard[0] = None
            if words[0] == 'set':
                changed_errexit, changed_pipefail = option_flags(words)
                errexit = errexit if changed_errexit is None else changed_errexit
                pipefail = pipefail if changed_pipefail is None else changed_pipefail
            if words[0] in BODY_KEYWORDS:
                condition = False
            command = Words(words)
            command.soft = ('command in a `||` alternative' if alternative else 'condition of an if/while' if condition
                            else NEGATED_REASON if words[0] == '!' or words[:2] == ['if', '!'] else 'after set +e' if not errexit else '')
            if words[0] in CONDITION_KEYWORDS:
                condition = True
                command.soft = command.soft or 'condition of an if/while'
            if alternative and handled and propagates_failure(words, True):
                for earlier in handled:
                    if earlier.soft == OR_REASON:
                        earlier.soft = ''
            if alternative:
                handled.clear()
            if command.soft == NEGATED_REASON and words[:2] == ['if', '!']:
                guard[0], guard[1] = command, False
            if words in [['true'], [':']] and alternative:
                pass
            else:
                commands.append(command)
            words.clear()

    while i < n:
        c = text[i]
        if c in ' \t\r':
            end_word()
        elif c == '\n':
            end_command()
            statement, alternative = len(commands), False
            handled.clear()
            while heredocs and i < n:
                delimiter, end = heredocs.pop(0), text.find('\n', i + 1)
                while end != -1 and text[i + 1:end].strip() != delimiter:
                    i, end = end, text.find('\n', end + 1)
                i = n if end == -1 else end
        elif c in ';()':
            end_command()
            if c == ';':
                statement, alternative = len(commands), False
                handled.clear()
        elif c in '&|':
            end_command()
            doubled = text[i + 1:i + 2] == c
            i += 1 if doubled else 0
            if c == '|' and doubled:
                handled.clear()
                for earlier in commands[statement:]:
                    if not earlier.soft:
                        handled.append(earlier)
                    earlier.soft = earlier.soft or OR_REASON
                alternative = True
            elif c == '|' and not pipefail and commands[statement:]:
                commands[-1].soft = commands[-1].soft or 'left side of a pipe without pipefail'

        elif c == '#' and current is None:
            while i + 1 < n and text[i + 1] != '\n':
                i += 1
        elif c == "'":
            j = text.find("'", i + 1)
            j = n if j == -1 else j
            current = (current or '') + text[i + 1:j]
            i = j
        elif c == '"':
            current = current or ''
            i += 1
            while i < n and text[i] != '"':
                if text[i] == '\\' and i + 1 < n:
                    current += text[i + 1]
                    i += 2
                elif text[i] == '$' and text[i + 1:i + 2] == '(':
                    j = balanced(text, i + 1)
                    current += text[i:j]
                    i = j
                else:
                    current += text[i]
                    i += 1
        elif c == '$' and text[i + 1:i + 2] == '(':
            j = balanced(text, i + 1)
            current = (current or '') + text[i:j]
            i = j - 1
        elif c == '\\' and i + 1 < n:
            current = (current or '') + text[i + 1]
            i += 1
        elif c in '<>':
            if current is not None and current.isdigit():
                current = None
            else:
                end_word()
            heredoc = text[i:i + 2] == '<<'
            while i < n and text[i] in '<>&|-' and not (heredoc and text[i] == '-' and text[i - 1] not in '<'):
                i += 1
            while i < n and text[i] in ' \t':
                i += 1
            start = i
            while i < n and text[i] not in ' \t\r\n;&|()':
                i += 1
            if heredoc:
                heredocs.append(text[start:i].strip('\'"'))
            i -= 1
        else:
            current = (current or '') + c
        i += 1
    end_command()
    return commands


def expand(argv, variables):
    """Expand known loop/dirname variables (cartesian product); unknown references stay literal."""
    names = sorted({m.group(1) or m.group(2) for word in argv for m in VARIABLE.finditer(word)})
    known = [n for n in names if isinstance(variables.get(n), list) and variables[n]]
    results = []
    for combination in product(*[variables[n] for n in known]):
        values = dict(zip(known, combination))
        results.append([VARIABLE.sub(lambda m: values.get(m.group(1) or m.group(2), m.group(0)), word) for word in argv])
    return results or [argv]


def is_script(word):
    return word.startswith('./') and word.endswith('.sh')


def shell_commands(text, with_soft=False, pipefail=False):
    """[(argv, cwd)] (or (argv, cwd, soft) with_soft) for every command in a run block, with env prefixes stripped,
    loops/`cd` resolved. `./x.sh` is a verification command like any other executable."""
    variables, found, cwd = {}, [], '.'
    for words in tokenize(text, pipefail):
        soft = words.soft
        while words and (words[0] in SHELL_KEYWORDS or (ASSIGNMENT.match(words[0]) and len(words) > 1)):
            words = words[1:]
        if not words:
            continue
        if words[0] == 'for' and len(words) > 3 and words[2] == 'in':
            variables[words[1]] = words[3:]
            continue
        assignment = ASSIGNMENT.match(words[0])
        if assignment and len(words) == 1:
            name, value = assignment.groups()
            derived = DIRNAME.match(value)
            if derived and isinstance(variables.get(derived.group(1)), list):
                variables[name] = [posixpath.dirname(v) or '.' for v in variables[derived.group(1)]]
            else:
                variables[name] = [value] if '$' not in value else None
            continue
        if words[0] == 'cd' and len(words) == 2:
            cwd = posixpath.normpath(posixpath.join(cwd, words[1]))
            continue
        if words[0] in VERIFY_EXECUTABLES or is_script(words[0]):
            found += [(argv, cwd, soft) if with_soft else (argv, cwd) for argv in expand(words, variables)]
    return found


# --- normalization --------------------------------------------------------------------------------------------------

def normalize_pnpm(args, cwd, names):
    target, recursive, i = None, False, 0
    while i < len(args) and args[i].startswith('-'):
        option = args[i]
        if option in ('--filter', '-F', '--dir', '-C') and i + 1 < len(args):
            target = target or args[i + 1]
            i += 2
        elif option.startswith('--filter=') or option.startswith('--dir='):
            target = target or option.split('=', 1)[1]
            i += 1
        elif option in ('-r', '--recursive'):
            recursive = True
            i += 1
        else:
            break
    rest = args[i:]
    if len(rest) > 1 and rest[0] == 'run':
        rest = rest[1:]
    if rest and rest[0].startswith('harness:'):
        return ['harness', rest[0][len('harness:'):], *rest[1:]]
    if target is None and recursive:
        target = '*'
    if target is None and cwd not in ('.', '') and rest and rest[0] not in PNPM_BUILTINS:
        target = cwd
    if target is None or not rest:
        return ['pnpm', *rest]
    target = names.get(target, target)
    target = posixpath.normpath(target) if target != '*' else target
    return ['pnpm', '@' + target, *rest]


def canonical(argv, cwd='.', names=None):
    """Comparable token list: harness entrypoints -> `harness <cmd>`, pnpm workspace scripts -> `pnpm @<dir> <script>`,
    Go run from a working directory -> `go -C <dir> ...`."""
    names = names or {}
    if is_script(argv[0]):
        argv = ['bash', *argv]
    if argv[0] == 'node' and len(argv) > 1 and argv[1] in HARNESS_ENTRYPOINTS:
        return ['harness', *argv[2:]]
    if argv[0] == 'pnpm':
        return normalize_pnpm(argv[1:], cwd, names)
    if argv[0] == 'go' and cwd not in ('.', '') and '-C' not in argv:
        return ['go', '-C', cwd, *argv[1:]]
    return list(argv)


def workspace_ref(tokens):
    """(dir pattern, script) when the canonical command runs a workspace script, else None."""
    if len(tokens) >= 3 and tokens[0] == 'pnpm' and tokens[1].startswith('@') and not tokens[2].startswith('-'):
        return tokens[1][1:], tokens[2]
    return None


def tokens_equal(pattern, tokens):
    return len(pattern) == len(tokens) and all(fnmatchcase(t, p) for t, p in zip(tokens, pattern))


def targeted_check(tokens, workspaces):
    """Name of the impact.py check shape equivalent to this command, or None."""
    ref = workspace_ref(tokens)
    if ref and len(tokens) == 3 and ref[1] in impact.SCRIPT_ORDER:
        # A discovery glob (packages/*) runs the script only where declared, so it is equivalent whether or not one does.
        if '*' in ref[0] or any(d == ref[0] and isinstance(w['scripts'].get(ref[1]), str) for d, w in workspaces.items()):
            return 'pnpm --filter ./<workspace> ' + ref[1]
    if tokens[:3] in (['go', '-C', impact.GO_ROOT],) and len(tokens) > 3 and tokens[3] in ('vet', 'test') \
            and not any(t.startswith('-') for t in tokens[4:]):
        return 'go -C ' + impact.GO_ROOT + ' ' + tokens[3]
    if tokens[0] == 'gofmt' and tokens[1:2] == ['-l']:
        return 'gofmt -l'
    if tokens[:2] == ['bash', '-n'] and len(tokens) > 2 and all(t.endswith('.sh') for t in tokens[2:]):
        return 'bash -n <script>'
    if tokens[:3] == ['docker', 'compose', '-f'] and len(tokens) == 6 and tokens[4:] == ['config', '--quiet'] \
            and fnmatchcase(tokens[3], 'infra/docker/compose*.yml'):
        return 'docker compose config --quiet'
    if tokens[:4] == ['pnpm', 'exec', 'prettier', '--check']:
        return 'pnpm exec prettier --check'
    if tokens == ['pnpm', 'agent-config:check']:
        return 'pnpm agent-config:check'
    return None


# --- analysis -------------------------------------------------------------------------------------------------------

def ci_commands(workspaces):
    """Every verification command of every workflow, with its file/job and `soft` (reason it cannot fail), if any."""
    names = {w['name']: d for d, w in workspaces.items()}
    directory = config.ROOT / '.github/workflows'
    commands, reach = [], {}
    for file in sorted([*directory.glob('*.yml'), *directory.glob('*.yaml')]) if directory.is_dir() else []:
        text = file.read_text(encoding='utf-8-sig')
        needs = parse_needs(text)
        reach[file.name] = (required_jobs(needs, text), needed_jobs(needs))
        for step in parse_workflow(text):
            where = file.name + ':' + str(step['job'])
            base = {'where': where, 'file': file.name, 'job': step['job']}
            if step['uses']:
                commands.append({**base, 'cwd': step['cwd'], 'raw': 'uses ' + step['uses'].split('@')[0],
                                 'tokens': ['uses', step['uses'].split('@')[0]], 'soft': step['soft']})
            for argv, cwd, soft in shell_commands(step['run'] or '', True, step.get('shell', '').split()[:1] == ['bash']):
                cwd = posixpath.normpath(posixpath.join(step['cwd'], cwd)) if cwd != '.' else step['cwd']
                tokens = canonical(argv, cwd, names)
                commands.append({**base, 'cwd': cwd, 'raw': ' '.join(argv), 'tokens': tokens,
                                 'soft': step['soft'] or soft or None})
    for command in commands:
        jobs, declared = reach[command['file']]
        command['required'] = jobs is None or command['job'] in jobs
        command['inNeeds'] = command['job'] in declared
    return commands


def job_body(text, job):
    """Source lines of one job (everything indented deeper than its `  <job>:` header)."""
    body, inside = [], False
    for raw in text.splitlines():
        indent = len(raw) - len(raw.lstrip(' '))
        if raw.strip() and not raw.strip().startswith('#') and indent <= 2:
            inside = raw.strip() == job + ':'
        elif inside:
            body.append(raw)
    return '\n'.join(body)


def needed_jobs(needs):
    """Every job in the transitive `needs` of `required`, whether or not its result is evaluated."""
    jobs, queue = set(), list(needs.get(REQUIRED_JOB, []))
    while queue:
        job = queue.pop()
        if job not in jobs:
            jobs.add(job)
            queue.extend(needs.get(job, []))
    return jobs


def required_jobs(needs, text=None):
    """Jobs whose failure fails the `required` job; None when there is no such job. A job counts only if it is in the
    `needs` of `required` and `needs.<job>.result` is read in that job (otherwise `required` can pass despite its failure),
    plus whatever those jobs transitively need (a failed dependency makes them skip, which `result` also reports)."""
    if REQUIRED_JOB not in needs:
        return None
    body = job_body(text, REQUIRED_JOB) if text is not None else None
    checked = [n for n in needs[REQUIRED_JOB] if body is None or re.search(r'needs\.' + re.escape(n) + r'\.result\b|needs\[[\'"]' + re.escape(n) + r'[\'"]\]\.result\b', body)]
    jobs, queue = {REQUIRED_JOB}, list(checked)
    jobs.update(queue)
    while queue:
        for need in needs.get(queue.pop(), []):
            if need not in jobs:
                jobs.add(need)
                queue.append(need)
    return jobs


def resolve(matches):
    """(class, cover command, detail) for the CI commands exercising a Harness item. Soft steps never count."""
    firm = [c for c in matches if not c['soft']]
    required = [c for c in firm if c['required']]
    if required:
        return 'covered', required[0], ''
    if firm:
        if firm[0].get('inNeeds'):
            why = f'is in the needs of the `{REQUIRED_JOB}` job but its `needs.{firm[0]["job"]}.result` is not evaluated there'
        else:
            why = f'is not in the needs of the `{REQUIRED_JOB}` job'
        return 'not-required', firm[0], f'{firm[0]["where"]} {why}: its failure does not block merge'
    if matches:
        return 'uncovered', None, f'only soft step(s) run it ({matches[0]["soft"]}): {matches[0]["where"]}'
    return 'uncovered', None, ''


def row(direction, classification, item, where='', detail=''):
    return {'direction': direction, 'class': classification, 'item': item, 'where': where, 'detail': detail}


def analyze():
    exceptions = load_manifest()
    workspaces = impact.js_workspaces()
    domains = manifests()['domains']
    commands = ci_commands(workspaces)
    gates = [(d['domain'], canonical(g), g) for d in domains for g in d['verification']]
    rows, seen = [], set()
    for command in commands:
        tokens = command['tokens']
        ignored = first_entry(exceptions['ignored'], tokens)
        gate = next((g for g in gates if tokens_equal(tokens, g[1])), None)
        targeted = None if ignored or command['soft'] or gate else targeted_check(tokens, workspaces)
        only = None if ignored or command['soft'] or gate or targeted else first_entry(exceptions['ciOnly'], tokens)
        classification, detail = (('ignored', ignored['reason']) if ignored else
                                  ('soft', command['soft'] + ': this step cannot fail the workflow, so it covers nothing') if command['soft'] else
                                  ('domain-gate', gate[0] + ': ' + ' '.join(gate[2])) if gate else
                                  ('targeted', targeted) if targeted else
                                  ('ci-only', only['reason']) if only else ('uncovered', 'no gate, check or exception'))
        key = ('ci->harness', classification, ' '.join(tokens), command['where'])
        if key not in seen:
            seen.add(key)
            rows.append(row('ci->harness', classification, ' '.join(tokens), command['where'], detail))
    for directory, workspace in workspaces.items():
        for script in impact.SCRIPT_ORDER:
            if not isinstance(workspace['scripts'].get(script), str):
                continue
            classification, cover, detail = resolve([c for c in commands if tokens_equal(c['tokens'], ['pnpm', '@' + directory, script])
                                                     or (workspace_ref(c['tokens']) and len(c['tokens']) == 3 and c['tokens'][2] == script
                                                         and fnmatchcase(directory, workspace_ref(c['tokens'])[0]))])
            rows.append(row('harness->ci', classification, directory + ' ' + script, cover['where'] if cover else '',
                            detail or ('workspace script never runs in CI' if classification == 'uncovered' else '')))
    for domain in domains:
        for gate in domain['verification']:
            tokens = canonical(gate)
            classification, cover, detail = resolve([c for c in commands if tokens_equal(c['tokens'], tokens)
                                                     or (workspace_ref(tokens) and workspace_ref(c['tokens']) and len(c['tokens']) == len(tokens)
                                                         and c['tokens'][2:] == tokens[2:]
                                                         and fnmatchcase(tokens[1][1:], c['tokens'][1][1:]))])
            local = first_entry(exceptions['localOnly'], tokens) if classification == 'uncovered' and not detail else None
            rows.append(row('harness->ci', 'local-only' if local else classification, domain['domain'] + ': ' + ' '.join(gate),
                            cover['where'] if cover else '',
                            local['reason'] if local else detail or ('gate has no CI equivalent or local-only entry' if classification == 'uncovered' else '')))
        apps = sorted({m.group(1) for p in domain['paths'] for m in [re.match(r'^apps/([^/*]+)/', p)] if m})
        for app in apps:
            classification, cover, detail = resolve([c for c in commands if any(
                fnmatchcase('apps/' + app, d) or d.rstrip('/') == 'apps/' + app
                for d in [c['cwd'], *( [workspace_ref(c['tokens'])[0]] if workspace_ref(c['tokens']) else [] ),
                          *( [c['tokens'][2]] if c['tokens'][:2] == ['go', '-C'] else [] )])])
            rows.append(row('harness->ci', classification, domain['domain'] + ': apps/' + app,
                            cover['where'] if cover else '', detail or ('enabled domain without any CI job' if classification == 'uncovered' else '')))
    return rows


def render(rows):
    for r in rows:
        r['item'] = r['item'] if len(r['item']) <= 90 else r['item'][:87] + '...'
    width = [max(len(r[k]) for r in rows + [{'direction': 'DIRECTION', 'class': 'CLASS', 'item': 'ITEM', 'where': 'WHERE'}])
             for k in ['direction', 'class', 'item', 'where']] if rows else [9, 5, 4, 5]
    header = {'direction': 'DIRECTION', 'class': 'CLASS', 'item': 'ITEM', 'where': 'WHERE'}
    lines = []
    for r in [header, *rows]:
        lines.append('  '.join(r[k].ljust(w) for k, w in zip(['direction', 'class', 'item', 'where'], width)).rstrip()
                     + ('  # ' + r['detail'] if r.get('detail') and r is not header else ''))
    gaps = [r for r in rows if r['class'] in GAPS]
    lines.append('')
    lines.append(f'{len(rows)} rows, {len([r for r in gaps if r["class"] == "uncovered"])} uncovered, '
                 f'{len([r for r in gaps if r["class"] == "not-required"])} not-required'
                 + (': ' + '; '.join(f'{r["direction"]} {r["item"]} ({r["class"]})' for r in gaps) if gaps else ''))
    return '\n'.join(lines)


def main(args):
    unknown = [a for a in args if a not in ('--strict', '--json')]
    if unknown:
        raise UsageError('Opción inválida para ci-gaps: ' + ', '.join(unknown))
    rows = analyze()
    gaps = [r for r in rows if r['class'] in GAPS]
    if '--json' in args:
        print(json.dumps({'rows': rows, 'summary': {'rows': len(rows), 'uncovered': len([r for r in gaps if r['class'] == 'uncovered']),
                                                    'notRequired': len([r for r in gaps if r['class'] == 'not-required']),
                                                    'strict': '--strict' in args}},
                         ensure_ascii=False, indent=2))
    else:
        print(render(rows))
    return 1 if gaps and '--strict' in args else 0
