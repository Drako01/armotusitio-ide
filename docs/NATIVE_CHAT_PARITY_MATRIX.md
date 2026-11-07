# Native chat parity matrix (r8)

Status legend:
- PASS = verified with the real provider.
- PASS (fake) = contract verified against a protocol-faithful fake run as a real process.
- BLOCKED = the provider was not available (quota).
- N/A = excluded before implementation (see R8_BASELINE.md §6.5).

| Capability | Claude Code 2.1.316 (CLI) | Codex 0.166.0 (app-server) | ArmoTuSitio IDE implementation | Claude | Codex |
|---|---|---|---|---|---|
| C01 multi-turn session | stream-json, one process | thread + turns | `ManagedSession.runTurn` | PASS (E01) | PASS (fake), BLOCKED |
| C02 token streaming | `--include-partial-messages` | `agentMessage/delta` | `message.delta` → partial in the chat | PASS (E01) | PASS (fake), BLOCKED |
| C03 tool lifecycle | tool_use / tool_result | item started/completed | `tool.*` → timeline steps | PASS (E04) | PASS (fake), BLOCKED |
| C04 approvals once/task/session/always/deny | permission prompt tool | server requests | ApprovalBroker + cards with risk | PASS (E03, E05) | PASS (fake), BLOCKED |
| C05 cancellation | stop process, resume | `turn/interrupt` | `interrupt()` | PASS (E07) | PASS (fake), BLOCKED |
| C06 resume after IDE restart | `--resume` | `thread/resume` | registry + journal | PASS (E02) | PASS (fake), BLOCKED |
| C07 agent question in the chat | AskUserQuestion | `requestUserInput` (experimental) | question card | PASS (E06) | PASS (fake), BLOCKED |
| C08 edits, diff, rollback | Edit/Write via the IDE | fileChange | run diff + discard | PASS (E08) | PASS (fake), BLOCKED |
| C09 terminal command and exit code | Bash via the IDE policy | commandExecution + output deltas | steps with output | PASS (E04) | PASS (fake), BLOCKED |
| C10 git structured tools | ats-runner MCP | ats-runner MCP | approvals per action | PASS (E09, A07) | BLOCKED |
| C11 MCP tools | `--mcp-config --strict-mcp-config` | `mcp_servers` | ats-runner + Work Management bridge | PASS (E10) | BLOCKED |
| C12 provider switch with handoff | new session | new thread | `handoff()` + notice | PASS (fake) | PASS (fake) |
| C13 project Harness delegation | runner `command-runner` | same | r7, unchanged | PASS (r7) | PASS (r7) |
| C14 multiroot isolation | identity per root | identity per root | `sessionKey` | PASS (fake) | PASS (fake, S15) |
| C15 usage only when reported | `result.usage` | `tokenUsage/updated` | `usage` event | PASS | PASS (fake) |
| Fork | `--fork-session` | `thread/fork` | `/bifurcar` | PASS (fake) | PASS (fake) |
| Steer a running turn | unavailable | `turn/steer` | `steer()` | N/A | PASS (fake) |
| Incremental command output | unavailable | output deltas | `tool.output` | N/A | PASS (fake) |
