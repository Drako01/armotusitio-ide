"""Only adapters know Codex/Claude CLI arguments; both share a logical contract."""
import json
import os
import re
from .config import H, ROOT, READ_ONLY, jread, dumps, validate_schema
from .runner import windows_spec

CLAUDE_READ = ['Read', 'Grep', 'Glob', 'WebFetch']
CLAUDE_WRITE = CLAUDE_READ + ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']
CLAUDE_DENIED = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'mcp__*']


def claude_args(read_only):
    args = ['-p', '--output-format', 'json', '--json-schema', dumps(jread('manifests/agent-result.schema.json')),
            '--permission-mode', 'default' if read_only else 'acceptEdits', '--allowedTools',
            ','.join(CLAUDE_READ if read_only else CLAUDE_WRITE)]
    if read_only:
        args += ['--tools', ','.join(CLAUDE_READ), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                 '--disallowedTools', ','.join(CLAUDE_DENIED)]
    model = os.environ.get('HARNESS_CLAUDE_MODEL')
    if model:
        if not re.fullmatch(r'[A-Za-z0-9._:\[\]-]+', model):
            raise ValueError('HARNESS_CLAUDE_MODEL contains invalid characters')
        args += ['--model', model]
    turns = os.environ.get('HARNESS_CLAUDE_MAX_TURNS')
    if turns:
        if not turns.isdigit() or not 1 <= int(turns) <= 200:
            raise ValueError('HARNESS_CLAUDE_MAX_TURNS must be an integer 1..200')
        args += ['--max-turns', turns]
    return args


def claude_usage(text):
    """Token usage reported by the Claude envelope; None when the host does not report it (never estimated here)."""
    try:
        usage = json.loads(text.strip()).get('usage')
    except (ValueError, TypeError, AttributeError):
        return None
    if not isinstance(usage, dict):
        return None
    keys = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    found = {k: usage[k] for k in keys if isinstance(usage.get(k), int) and not isinstance(usage.get(k), bool)}
    return found or None


def host_adapter(agent, prompt, result_file, extra_dirs=()):
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', agent):
        raise ValueError('Unsafe agent name')
    environment = {'HARNESS_AGENT_PROMPT': prompt, 'HARNESS_AGENT': agent}
    custom = os.environ.get('HARNESS_AGENT_COMMAND')
    if custom:
        if '{prompt}' in custom:
            raise ValueError('Unsafe {prompt} interpolation: read HARNESS_AGENT_PROMPT or stdin instead')
        environment['HARNESS_RESULT_FILE'] = str(result_file)
        cmd = os.environ.get('ComSpec', 'cmd.exe') if os.name == 'nt' else 'sh'
        args = ['/d', '/s', '/c', custom.replace('{agent}', agent)] if os.name == 'nt' else ['-lc', custom.replace('{agent}', agent)]
        return {'cmd': cmd, 'args': args, 'env': environment, 'input': prompt}
    host = os.environ.get('HARNESS_HOST', '').lower()
    if host not in ['codex', 'claude']:
        return None
    read_only = agent in READ_ONLY
    args = ['exec', '--sandbox', 'read-only' if read_only else 'workspace-write', '--output-schema',
            str(H / 'manifests/agent-result.schema.json'), '--output-last-message', str(result_file), '-'] if host == 'codex' else claude_args(read_only)
    if host == 'codex':
        environment['HARNESS_RESULT_FILE'] = str(result_file)
        model = os.environ.get('HARNESS_CODEX_MODEL')
        if model:
            if not re.fullmatch(r'[A-Za-z0-9._:-]+', model):
                raise ValueError('HARNESS_CODEX_MODEL contains invalid characters')
            args[-1:-1] = ['--model', model]
    if host == 'claude':
        for directory in extra_dirs:
            args += ['--add-dir', str(directory)]  # isolated worktrees read handoffs/sources that live in the main checkout
    cmd, args = windows_spec(host, args)
    return {'cmd': cmd, 'args': args, 'env': environment, 'input': prompt, 'host': host}


def extract_claude_result(text):
    try:
        envelope = json.loads(text.strip())
    except (ValueError, TypeError):
        raise ValueError('Claude --output-format json did not return a JSON envelope') from None
    if not isinstance(envelope, dict) or envelope.get('type') != 'result' or envelope.get('subtype') != 'success' or envelope.get('is_error') is not False:
        raise ValueError('Claude host reported invalid or error envelope (is_error=' + str(envelope.get('is_error') if isinstance(envelope, dict) else None) + ')')
    if not isinstance(envelope.get('structured_output'), dict):
        raise ValueError('Claude JSON envelope missing structured_output object')
    return dumps(envelope['structured_output'])


def parse_result(text):
    result = json.loads(text.strip())
    errors = validate_schema(result, jread('manifests/agent-result.schema.json'))
    if errors:
        raise ValueError('Agent result schema invalid: ' + '; '.join(errors))
    return result
