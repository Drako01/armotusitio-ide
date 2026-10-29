import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const root = process.cwd();
// git >= 2.29 detaches background maintenance after commit; it must never outlive a fixture directory.
export const gitEnv = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  // Temporary fixtures must not discover an unrelated repository in the user's home.
  GIT_CEILING_DIRECTORIES: os.tmpdir(),
};
export const gitIn =
  (cwd) =>
  (...args) =>
    spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
export const core = path.join(root, ".harness", "core.mts");
export const call = (args) => spawnSync(process.execPath, [core, ...args], { cwd: root, encoding: "utf8" });

// Every test that creates tasks runs in an isolated temporary copy of the Harness so that
// failing assertions can never leave runtime residue (tasks, state, handoffs, logs) in the repository.
export async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "redevent-harness-test-"));
  // Windows job cancellation releases cwd handles asynchronously. Retry only
  // transient filesystem cleanup errors; persistent failures still fail the test.
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.cp(path.join(root, ".harness", "manifests"), path.join(dir, ".harness", "manifests"), { recursive: true });
  await fs.copyFile(core, path.join(dir, ".harness", "core.mts"));
  await fs.copyFile(path.join(root, ".harness", "bootstrap.mts"), path.join(dir, ".harness", "bootstrap.mts"));
  await fs.copyFile(path.join(root, ".harness", "cli.py"), path.join(dir, ".harness", "cli.py"));
  await fs.cp(path.join(root, ".harness", "core"), path.join(dir, ".harness", "core"), { recursive: true });
  await fs.cp(path.join(root, ".harness", "lib"), path.join(dir, ".harness", "lib"), { recursive: true });
  await fs.copyFile(path.join(root, ".harness", "README.md"), path.join(dir, ".harness", "README.md"));
  // Fixture skills are isolated synthetic metadata: the IDE checkout does not ship RedEvent skills.
  // Never follow host symlinks or depend on operator-specific .codex/.claude directories.
  const agentsManifest = JSON.parse(await fs.readFile(path.join(dir, ".harness", "manifests", "agents.json"), "utf8"));
  const domainsManifest = JSON.parse(await fs.readFile(path.join(dir, ".harness", "manifests", "domains.json"), "utf8"));
  const skillNames = new Set([
    ...agentsManifest.agents.flatMap((agent) => agent.skills || []),
    ...domainsManifest.domains.flatMap((domain) => domain.skills || []),
  ]);
  for (const name of skillNames) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error("Unsafe fixture skill name");
    const directory = path.join(dir, ".codex", "skills", name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), "# " + name + "\n\nSynthetic fixture metadata only.\n");
  }
  for (const name of [
    "tasks/inbox",
    "tasks/active",
    "tasks/completed",
    "tasks/failed",
    "state",
    "handoffs",
    "runtime",
    "logs/execution",
    "logs/errors",
    "logs/audit",
    "logs/completed",
  ])
    await fs.mkdir(path.join(dir, ".harness", name), { recursive: true });
  const file = path.join(dir, ".harness", "manifests", "domains.json");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  for (const domain of manifest.domains) domain.verification = [[process.execPath, "-e", "process.exit(0)"]];
  await fs.writeFile(file, JSON.stringify(manifest));
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [path.join(dir, ".harness", "core.mts"), ...args], {
      cwd: dir,
      encoding: "utf8",
      // Lifecycle fixtures are independent of the operator's readiness receipts
      // and cleanup policy; explicit test overrides still exercise those controls.
      env: {
        ...process.env,
        HARNESS_IGNORE_ENV_FILE: "1",
        HARNESS_PREFLIGHT: "off",
        HARNESS_KEEP_ARTIFACTS: "1",
        HARNESS_HOST: "",
        HARNESS_AGENT_COMMAND: "",
        HARNESS_MAX_RETRIES: "0",
        ...gitEnv,
        ...env,
      },
    });
  return { dir, run };
}

export const passedResult = {
  status: "passed",
  changes: [],
  files: [],
  decisions: [],
  risks: [],
  verification: ["Synthetic host transport, schema and assigned scope verified by fixture"],
  nextAction: null,
};

export async function fixtureAgent(dir, code) {
  const name = path.join(dir, "agent.cjs");
  await fs.writeFile(name, code);
  return `"${process.execPath}" "${name}"`;
}

export const readHandoffs = async (dir, taskId) => {
  const base = path.join(dir, ".harness", "handoffs");
  const out = [];
  for (const name of await fs.readdir(base))
    if (name.startsWith(taskId + "-")) out.push(JSON.parse(await fs.readFile(path.join(base, name), "utf8")));
  return out;
};

export async function fakeClaudeBinary(dir) {
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin, { recursive: true });
  const calls = path.join(os.tmpdir(), path.basename(dir) + "-claude-calls.jsonl");
  const fence = String.fromCharCode(96, 96, 96);
  await fs.writeFile(
    path.join(bin, "claude.cjs"),
    `const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const mode = process.env.FAKE_CLAUDE_MODE || "pass";
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  role: input.role,
  hasPrint: args[0] === "-p",
  outputFormat: value("--output-format"),
  permissionMode: value("--permission-mode"),
  allowedTools: value("--allowedTools"),
  disallowedTools: value("--disallowedTools"),
  tools: value("--tools"),
  jsonSchema: value("--json-schema"),
  strictMcp: args.includes("--strict-mcp-config"),
  mcpConfig: value("--mcp-config"),
  model: value("--model"),
  maxTurns: value("--max-turns"),
  hasResultFileEnv: !!process.env.HARNESS_RESULT_FILE,
  task: input.task,
}) + "\\n");
if (mode === "plaintext") { console.log("Claude transcript noise that must not be parsed as the result"); process.exit(0); }
if (mode === "is_error") { console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "boom" })); process.exit(0); }
if (mode === "fenced") { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: null, result: ${JSON.stringify(fence)} + "json\\n" + JSON.stringify(${JSON.stringify(passedResult)}) + "\\n" + ${JSON.stringify(fence)} })); process.exit(0); }
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: ${JSON.stringify(passedResult)}, result: "" }));`,
  );
  if (process.platform === "win32")
    await fs.writeFile(path.join(bin, "claude.cmd"), `@"${process.execPath}" "%~dp0claude.cjs" %*\r\n`);
  else {
    await fs.writeFile(
      path.join(bin, "claude"),
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/claude.cjs" "$@"\n`,
    );
    await fs.chmod(path.join(bin, "claude"), 0o755);
  }
  return { bin, calls };
}

export function claudePathEnv(bin) {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";
  return { [pathKey]: bin + path.delimiter + process.env[pathKey] };
}

export async function snapshotEntries(dir) {
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { snapshot, serializeSnapshot } from './.harness/lib/snapshot.mts'; console.log(serializeSnapshot(await snapshot()));",
    ],
    { cwd: dir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

export async function interruptedTask(dir, run, agentIndex = 1) {
  const task = JSON.parse(run(["run", "repo", "interrupted attempt"]).stdout);
  const file = path.join(dir, ".harness", "tasks", "active", task.id + ".json");
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  for (const [index, node] of persisted.dag.entries())
    if (index < agentIndex) ((node.status = "passed"), (node.attempts = 1));
  persisted.dag[agentIndex].status = "running";
  persisted.dag[agentIndex].attempts = 1;
  await fs.writeFile(file, JSON.stringify(persisted));
  const agent = persisted.dag[agentIndex].agent;
  await fs.writeFile(
    path.join(dir, ".harness", "runtime", task.id + "-" + agent + "-1-baseline.json"),
    await snapshotEntries(dir),
  );
  return task;
}
