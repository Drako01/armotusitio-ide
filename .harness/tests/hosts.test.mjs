import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { call, fixture, passedResult, readHandoffs, fakeClaudeBinary, claudePathEnv } from "./helpers.mjs";

test("codex host launcher uses exec with sandbox, schema, result file and stdin prompt", async (t) => {
  const { dir, run } = await fixture(t);
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin);
  const calls = path.join(os.tmpdir(), path.basename(dir) + "-codex-calls.jsonl");
  // Fake `codex` executable on PATH: validates the real launcher contract of Codex CLI `exec`.
  await fs.writeFile(
    path.join(bin, "codex.cjs"),
    `const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const ok = args[0] === "exec" && args.at(-1) === "-" && fs.existsSync(value("--output-schema")) && ["read-only", "workspace-write"].includes(value("--sandbox"));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ role: input.role, sandbox: value("--sandbox"), task: input.task }) + "\\n");
if (!ok) process.exit(5);
console.log("codex transcript noise that must not be parsed as the result");
fs.writeFileSync(value("--output-last-message"), JSON.stringify(${JSON.stringify(passedResult)}));`,
  );
  if (process.platform === "win32")
    await fs.writeFile(path.join(bin, "codex.cmd"), `@"${process.execPath}" "%~dp0codex.cjs" %*\r\n`);
  else {
    await fs.writeFile(
      path.join(bin, "codex"),
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/codex.cjs" "$@"\n`,
    );
    await fs.chmod(path.join(bin, "codex"), 0o755);
  }
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";
  const message = "Codex literal 'q' \"dq\" $(nope) %PATH% ñ";
  const task = JSON.parse(run(["run", "repo", message]).stdout);
  const executed = run(["execute", task.id], {
    HARNESS_HOST: "codex",
    [pathKey]: bin + path.delimiter + process.env[pathKey],
  });
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  assert.equal(JSON.parse(executed.stdout).status, "completed");
  const seen = (await fs.readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    seen.map((c) => [c.role, c.sandbox]),
    [
      ["architect", "workspace-write"],
      ["reviewer", "read-only"],
    ],
  );
  assert.ok(seen.every((c) => c.task === message));
});

// Fake `claude` executable on PATH: validates the real launcher contract of the Claude Code CLI
// print-mode adapter (argv shape, stdin delivery, per-role tool allowlist) without needing a real
// `claude` binary, mirroring the codex fixture above. `FAKE_CLAUDE_MODE` controls the emitted
// `--output-format json` envelope so the same fixture can also exercise fail-closed paths.

test("claude host launcher uses print mode, json output-format, per-role tool allowlist and stdin prompt", async (t) => {
  const { dir, run } = await fixture(t);
  const { bin, calls } = await fakeClaudeBinary(dir);
  const message = "Claude literal 'q' \"dq\" $(nope) %PATH% ñ";
  const task = JSON.parse(run(["run", "repo", message]).stdout);
  const executed = run(["execute", task.id], { HARNESS_HOST: "claude", ...claudePathEnv(bin) });
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  assert.equal(JSON.parse(executed.stdout).status, "completed");
  const seen = (await fs.readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const byRole = Object.fromEntries(seen.map((c) => [c.role, c]));
  assert.ok(byRole.architect, "the write-capable specialist must invoke the claude host");
  assert.ok(byRole.reviewer, "the read-only gate must invoke the claude host");
  for (const call of seen) {
    assert.ok(call.hasPrint, "must run in headless -p print mode");
    assert.equal(call.outputFormat, "json", "must request the structured envelope, not free text");
    assert.equal(
      JSON.parse(call.jsonSchema).additionalProperties,
      false,
      "Claude must receive the native result schema",
    );
    assert.equal(call.task, message, "prompt must reach stdin literally, never the command line");
    assert.ok(
      !call.hasResultFileEnv,
      "claude must never receive HARNESS_RESULT_FILE: the path must not be discoverable",
    );
  }
  assert.equal(byRole.architect.permissionMode, "acceptEdits");
  assert.ok(byRole.architect.allowedTools.split(",").includes("Edit"));
  assert.ok(byRole.architect.allowedTools.split(",").includes("Write"));
  assert.equal(byRole.architect.disallowedTools, null, "write-capable roles need no extra denylist");
  assert.notEqual(byRole.reviewer.permissionMode, "acceptEdits", "reviewer must never auto-accept edits");
  assert.equal(byRole.reviewer.tools, "Read,Grep,Glob,WebFetch");
  assert.equal(byRole.reviewer.strictMcp, true);
  assert.equal(byRole.reviewer.mcpConfig, '{"mcpServers":{}}');
  assert.ok(byRole.reviewer.disallowedTools.split(",").includes("mcp__*"));
  for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]) {
    assert.ok(!byRole.reviewer.allowedTools.split(",").includes(tool), tool + " must not be allowlisted for reviewer");
    assert.ok(byRole.reviewer.disallowedTools.split(",").includes(tool), tool + " must be denylisted for reviewer");
  }
});

test("claude host fails closed when output-format json does not return a JSON envelope", async (t) => {
  const { dir, run } = await fixture(t);
  const { bin } = await fakeClaudeBinary(dir);
  const task = JSON.parse(run(["run", "repo", "fixture claude plaintext output"]).stdout);
  const executed = run(["execute", task.id], {
    HARNESS_HOST: "claude",
    FAKE_CLAUDE_MODE: "plaintext",
    ...claudePathEnv(bin),
  });
  assert.notEqual(executed.status, 0);
  assert.equal(JSON.parse(run(["status", task.id]).stdout).status, "failed");
});

test("claude host never trusts a resultFile even if a passed result is forged into it", async (t) => {
  const { dir, run } = await fixture(t);
  const { bin } = await fakeClaudeBinary(dir);
  const task = JSON.parse(run(["run", "repo", "fixture claude resultFile forgery"]).stdout);
  // Simulate a write-capable Claude-hosted role (architect has Bash/Write under acceptEdits)
  // forging a passed envelope straight onto the runtime result-file path that Codex's
  // --output-last-message would legitimately populate. Claude must never read this file: its
  // result must come from captured stdout only, which here genuinely reports is_error.
  const forged = path.join(dir, ".harness", "runtime", task.id + "-architect-1-result.json");
  await fs.mkdir(path.dirname(forged), { recursive: true });
  await fs.writeFile(forged, JSON.stringify(passedResult));
  const executed = run(["execute", task.id], {
    HARNESS_HOST: "claude",
    FAKE_CLAUDE_MODE: "is_error",
    ...claudePathEnv(bin),
  });
  assert.notEqual(executed.status, 0, "a forged resultFile must never make the task succeed");
  assert.equal(JSON.parse(run(["status", task.id]).stdout).status, "failed");
  const risks = (await readHandoffs(dir, task.id)).flatMap((h) => h.risks);
  assert.ok(
    risks.some((r) => /is_error/.test(r)),
    "the real stdout envelope, not the forged file, must drive the outcome",
  );
});

test("claude host fails closed on an is_error envelope even with a successful process exit", async (t) => {
  const { dir, run } = await fixture(t);
  const { bin } = await fakeClaudeBinary(dir);
  const task = JSON.parse(run(["run", "repo", "fixture claude is_error envelope"]).stdout);
  const executed = run(["execute", task.id], {
    HARNESS_HOST: "claude",
    FAKE_CLAUDE_MODE: "is_error",
    ...claudePathEnv(bin),
  });
  assert.notEqual(executed.status, 0);
  assert.equal(JSON.parse(run(["status", task.id]).stdout).status, "failed");
});

test("claude host fails closed on a markdown-fenced result instead of stripping fences", async (t) => {
  const { dir, run } = await fixture(t);
  const { bin } = await fakeClaudeBinary(dir);
  const task = JSON.parse(run(["run", "repo", "fixture claude fenced result"]).stdout);
  const executed = run(["execute", task.id], {
    HARNESS_HOST: "claude",
    FAKE_CLAUDE_MODE: "fenced",
    ...claudePathEnv(bin),
  });
  assert.notEqual(executed.status, 0);
  assert.equal(JSON.parse(run(["status", task.id]).stdout).status, "failed");
});

test("claude host forwards optional model and max-turns only when configured and validated", async (t) => {
  const { dir, run } = await fixture(t);
  const { bin, calls } = await fakeClaudeBinary(dir);
  const task = JSON.parse(run(["run", "repo", "claude knobs"]).stdout);
  const executed = run(["execute", task.id], {
    HARNESS_HOST: "claude",
    HARNESS_CLAUDE_MODEL: "claude-sonnet-5-5",
    HARNESS_CLAUDE_MAX_TURNS: "12",
    ...claudePathEnv(bin),
  });
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  for (const line of (await fs.readFile(calls, "utf8")).trim().split("\n")) {
    const call = JSON.parse(line);
    assert.equal(call.model, "claude-sonnet-5-5");
    assert.equal(call.maxTurns, "12");
  }
  const bad = JSON.parse(run(["run", "repo", "claude bad knob"]).stdout);
  const rejected = run(["execute", bad.id], {
    HARNESS_HOST: "claude",
    HARNESS_CLAUDE_MAX_TURNS: "0",
    ...claudePathEnv(bin),
  });
  assert.notEqual(rejected.status, 0);
});
