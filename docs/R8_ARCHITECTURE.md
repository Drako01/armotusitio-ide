# r8 architecture: native agent runtime

Readers: maintainers of `extensions/armotusitio-ide`. The scenarios and the baseline are in [R8_BASELINE.md](R8_BASELINE.md), and the measured results are in [R8_TEST_EVIDENCE.md](R8_TEST_EVIDENCE.md).

## 1. Layers

```text
Chat UI (resources/chat.ts)       approval cards with risk, question cards, timeline steps, /permisos, /bifurcar
HarnessChatSession                conversation, plans, queue, ApprovalBroker grants, follow-up (delta) instructions
ChatRuntime (native-integration)  guarded pipeline runGuardedAgent: trust, fence, lease, quota, budget, metrics, verification
  ├─ structured: executeReviewedAgent (one process per turn, r7)
  └─ native:     NativeChatTransport -> AgentSessionManager -> AgentAdapter (src/runtime/)
                   ├─ ClaudeAdapter  claude --print --input-format stream-json (route A, installed CLI)
                   └─ CodexAdapter   codex app-server, JSON-RPC over stdio, types generated from the installed CLI
Policy                            commandVerdict / editVerdict (native-approve-tool) shared by Claude prompts,
                                  Codex server requests (provider-policy) and the ats-runner tools
```

The chat and the guarded pipeline never import a provider adapter. A native turn is an `AgentExecution` (`outcome` plus `cancel`), the same contract as the structured transport. That is why verification, diff, undo, metrics and budgets work unchanged.

## 2. Contracts (`src/runtime/contracts.ts`)

- **`AgentAdapter`**: `capabilities(env)` probes the installed CLI without spending tokens. `open(options, host)` returns an `AgentConnection`.
- **`AgentConnection`**: `startTurn`, `steer` (only when the provider supports it), `interrupt`, `close`, and an `exited` promise.
- **`AdapterHost`**: `emit(AdapterEvent)`, `approve(ToolCall)` and `ask(AgentQuestion[])`. Every callback fails closed.
- **`AgentEvent`**: `eventId`, `sessionId`, `turnId`, `toolCallId`, `sequence`, `timestamp`, `payload`. The payload is a discriminated union: `session.ready`, `state`, `turn.started`, `message.delta`, `message.completed`, `tool.started`, `tool.output`, `tool.completed`, `approval.*`, `question.*`, `usage`, `turn.completed`, `diagnostic`.
- **`SessionState`**: `starting`, `ready`, `running`, `awaiting_approval`, `awaiting_user_input`, `interrupted`, `recovering`, `failed`, `closed`. Allowed transitions are in `SESSION_TRANSITIONS`; any other transition throws.
- **`SessionIdentity`**: canonical root + git common directory/worktree + provider + `conversationId`. The key is a sha256 of these fields. Sessions never cross roots, worktrees, providers or conversations.

### Extending to a new provider

Implement `AgentAdapter`: map the provider's protocol to `AdapterEvent`, and send its approvals and questions to `host`. Register it in `NativeChatTransport`. The chat, policy, store and UI need no change.

## 3. Runtime pieces

| Module | Responsibility |
|---|---|
| `event-bridge.ts` | Sequence numbers, dedup of replayed native events, redaction, size limits. Deltas are not retained. Diagnostics are capped at 20 per turn. A failing listener is isolated. |
| `json-rpc.ts` | JSONL request/response correlation, timeouts, server-initiated requests, malformed and oversized lines skipped. |
| `provider-process.ts` | Spawns without a shell, stops the whole process tree, bounds and redacts stderr, reports expected vs. crash exits. |
| `session-store.ts` | Versioned registry (`agent-sessions.json`) in the project's private storage. Atomic fsync + rename under a cross-window lock. Corrupt files are quarantined, newer schemas are refused. Keeps the turn journal. |
| `session-manager.ts` | Lifecycle. Writes a `pending` journal entry before each turn. Resumes by native id, reopens with resume when the role changes, retries a failed start once (R06), starts a new session with a notice when the stored id is unknown (R08), and handles fork and handoff. |
| `approval-broker.ts` | Task and session grants per project chat, keyed by the exact rule. Session grants have an 8 h TTL. Grants are revocable and audited. |
| `provider-policy.ts` | Codex approvals go through the same floor and rules as Claude's. A compound line inside the sandbox is allowed once only. Sandbox escalations are always asked. |
| `native-agent-transport.ts` | Dependency-injected bridge between the chat and the runtime: capability decision, delta reference, `AgentExecution`, timeline steps. |

## 4. Provider adapters

### Codex

- One `codex app-server` per session. Handshake: `initialize` (experimental API on), then `initialized`.
- `thread/start` uses `ephemeral: false`. The thread is resumed with `thread/resume` or branched with `thread/fork`.
- The writer runs with `approvalPolicy: untrusted` and a `workspaceWrite` sandbox limited to the project plus toolchain caches. The conversation runs with `never` and `readOnly`.
- Server requests are mapped as follows:
  - command, file and permission approvals go to `host.approve`;
  - `requestUserInput` goes to `host.ask`;
  - MCP elicitations are declined;
  - anything else is declined with a diagnostic.
- "Esta sesión" maps to `acceptForSession`. Task and always grants stay in the IDE, because Codex has no equivalent.
- Types come from `codex-protocol.generated.ts`, generated by `generate-codex-protocol.mts` from the installed 0.166.0. A different minor version is reported as incompatible, and the chat then keeps the structured transport (S20).

### Claude

- One stream-json process per session and role.
- A new session gets an IDE-chosen `--session-id`, so it is journaled before the first turn. Later processes use `--resume`, and a fork uses `--fork-session`.
- Permission prompts and `AskUserQuestion` go to `--permission-prompt-tool mcp__ats-runner__approve`. Bypass modes are never used.
- To interrupt, the IDE stops the process. The next turn resumes the session.
- A process that dies during the startup grace period (300 ms for a new session, 2.5 s for a resume) is classified: an explained death becomes `ProviderRequestError`, and a silent one is retried.

## 5. Persistence and recovery

- **Journal states:** `pending`, `running`, `completed`, `interrupted`, `failed`, `lost`. On startup, `reconcile()` marks the turns of a dead IDE process as `lost`. Lost turns are never replayed: the runtime keeps only input digests, never the text.
- **`lastInputRef`:** the chat message id that the last completed turn delivered. Follow-up turns send only `buildConversationDelta`. When the provider had to start over, the full instruction (`freshText`) is used instead.
- **Provider switch:** creates a new session with an explicit chat notice. Native ids never cross providers.
- **Migration:** r7 conversations get a `conversationId` on first load. Permission files are untouched. Registry v0 is upgraded in memory.

## 6. Permissions and threat model

| Threat | Control |
|---|---|
| Prompt injection asking for unsafe tools | IDE floor (`commandVerdict`) and permission rules decide; tool results are data; the contract says denials are final |
| Path traversal, junction or symlink escape | `projectFilePath` resolves the real path and refuses `path-outside-project` (test S17) |
| Untrusted workspace | `decideProviderCall` denies before anything else |
| Shell operators | Refused for Claude's unsandboxed Bash; for Codex, inside its sandbox, allowed once with the exact line shown and high risk |
| Scope escalation (`docker` allows `aws`) | Grants are exact rules per project, and brokers are per project chat (unit test) |
| Replayed or late approvals | Card ids are single-use; stale ids are ignored; refusals are scoped to the turn (`turnEpochs`) |
| Missing UI or timeout | Treated as deny; questions unanswered; no answer ever becomes `allow` |
| Secrets in logs and events | `redactSecrets` plus dev-secret redaction in the bridge and transport; the store keeps digests only |
| Crash during a non-idempotent action | Turn marked `lost`, never replayed (R01, R03, R04) |

## 7. Configuration and rollback

`atsHarness.agentTransport` takes `structured` (default, r7 behavior), `native` or `auto`. Both `native` and `auto` fall back to `structured`, with a one-time warning, when the installed CLI is incompatible. To roll back, set `structured`: the chat history and permissions are shared by both transports.
