"""Fixed compatibility surface for retained JavaScript consumers, not an eval bridge."""
from . import config, security, context, routing, tasks, state, adapters, delegation, lifecycle, check, snapshot, runner


def invoke(method, args):
    if method == 'moveTask':
        state.move_task(*args)
        return args[0]  # Return the mutated object for JavaScript's historical by-reference contract.
    methods = {
        'tokenize': config.tokenize, 'terms': config.terms, 'digest': config.digest,
        'validateSchema': config.validate_schema, 'gateTimeoutMs': config.gate_timeout_ms,
        'maxRetries': config.max_retries, 'id': config.task_id, 'jread': config.jread,
        'writeJson': config.write_json, 'matchesPath': security.matches_path, 'allowedPath': security.allowed_path,
        'readSource': security.read_source, 'manifests': lambda options=None: context.manifests((options or {}).get('includeDisabled', False)),
        'getDomain': context.get_domain, 'skillIndex': context.skill_index, 'context': context.context,
        'inferDomains': routing.infer_domains, 'taskSlice': routing.task_slice, 'selectAgents': routing.select_agents,
        'buildDag': routing.build_dag, 'makeTask': tasks.make_task, 'loadTask': tasks.load_task,
        'expandSource': tasks.expand_source, 'listTasks': tasks.list_tasks, 'abortTask': tasks.abort_task,
        'retryTask': tasks.retry_task, 'dispatch': tasks.dispatch, 'taskFileText': lambda identity: config.dumps(tasks.load_task(identity)),
        'persistTask': state.persist_task, 'moveTask': state.move_task, 'log': state.log, 'handoff': state.handoff,
        'validateTask': state.validate_task, 'claudeArgs': adapters.claude_args, 'extractClaudeResult': adapters.extract_claude_result,
        'hostAdapter': adapters.host_adapter, 'parseResult': adapters.parse_result, 'agentTimeoutMs': config.agent_timeout_ms,
        'delegationContext': delegation.delegation_context, 'delegationPrompt': delegation.delegation_prompt,
        'compactHandoff': delegation.compact_handoff, 'runGate': delegation.run_gate, 'executeNode': delegation.execute_node,
        'execute': lifecycle.execute, 'check': check.check, 'agentsDoc': check.agents_doc,
        'snapshot': lambda: {'files': list(snapshot.snapshot().items()), 'ignored': sorted(snapshot.snapshot().ignored)},
        'changedFiles': lambda before, after, domain, contract, ignored=None: snapshot.compare_snapshots(
            snapshot.Snapshot(before['files'], ignored=before.get('ignored')), snapshot.Snapshot(after['files'], ignored=after.get('ignored')), domain, contract, ignored),
        'verifyScopeRestoration': snapshot.verify_scope_restoration, 'clearRestoredScope': snapshot.clear_restored_scope,
        'verifyInterrupted': snapshot.verify_interrupted,
        'spawnRun': lambda cmd, arguments, options=None: runner.spawn_run(cmd, arguments, {**(options or {}), 'trusted': True}),
        'constants': lambda: {'pathRule': security.PATH_RULE, 'readOnlyAgents': config.READ_ONLY, 'downstreamAgents': config.DOWNSTREAM,
            'nonImplementerAgents': config.NON_IMPLEMENTERS, 'fixedAgents': config.FIXED, 'deterministicAgents': config.DETERMINISTIC,
            'claudeReadOnlyTools': adapters.CLAUDE_READ, 'claudeWriteTools': adapters.CLAUDE_WRITE,
            'claudeDeniedForReadOnly': adapters.CLAUDE_DENIED},
    }
    if method not in methods:
        raise ValueError('Unknown Harness RPC method')
    return methods[method](*args)
