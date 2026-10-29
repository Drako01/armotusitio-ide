import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixture, passedResult, fixtureAgent, readHandoffs, snapshotEntries } from "./helpers.mjs";

test("run persists resumable lifecycle state and DAG with sequential tester", async (t) => {
  const { dir, run } = await fixture(t);
  const r = run(["run", "api", "test coverage lifecycle"]);
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(r.stdout);
  assert.equal(task.status, "active");
  assert.equal(task.dag[0].agent, "context-manager");
  const tester = task.dag.find((n) => n.agent === "tester");
  assert.ok(tester);
  assert.deepEqual(tester.dependsOn, ["backend"], "tester must run after the implementer, not concurrently");
  assert.ok(task.dag.some((n) => n.agent === "reviewer"));
  assert.ok(task.dag.some((n) => n.agent === "verifier"));
  assert.ok(await fs.stat(path.join(dir, ".harness", "tasks", "active", task.id + ".json")));
  assert.ok(await fs.stat(path.join(dir, ".harness", "state", task.id + ".json")));
});

test("exhausted agent failures close downstream DAG and exit non-zero", async (t) => {
  const { dir, run } = await fixture(t);
  const created = run(["run", "api", "terminal failure regression"]);
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout);
  const executed = run(["execute", task.id], {
    HARNESS_HOST: "missing-test-host",
    HARNESS_AGENT_COMMAND: process.platform === "win32" ? "exit /b 7" : "exit 7",
  });
  assert.notEqual(executed.status, 0, "a failed task must return a truthful non-zero exit code");
  const result = JSON.parse(executed.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.dag.filter((n) => n.status === "pending").length, 0);
  assert.ok(await fs.stat(path.join(dir, ".harness", "tasks", "failed", task.id + ".json")));
  await assert.rejects(fs.stat(path.join(dir, ".harness", "tasks", "active", task.id + ".json")), { code: "ENOENT" });
});

test("missing host blocks explicitly without passing the task", async (t) => {
  const { run } = await fixture(t);
  const task = JSON.parse(run(["run", "repo", "fixture no host"]).stdout);
  const executed = run(["execute", task.id]);
  assert.notEqual(executed.status, 0);
  const state = JSON.parse(executed.stdout);
  assert.equal(state.status, "active");
  assert.ok(state.dag.some((n) => n.status === "blocked"));
});

test("structured failed result cannot pass a successful process", async (t) => {
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(
    dir,
    `console.log(JSON.stringify(${JSON.stringify({ ...passedResult, status: "failed", risks: ["expected rejection"] })}));`,
  );
  const task = JSON.parse(run(["run", "repo", "fixture rejection"]).stdout);
  const result = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command });
  assert.notEqual(result.status, 0);
  const state = JSON.parse(run(["status", task.id]).stdout);
  assert.equal(state.status, "failed");
});

test("unstructured successful output fails closed", async (t) => {
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(dir, 'console.log("Everything passed");');
  const task = JSON.parse(run(["run", "repo", "fixture malformed outcome"]).stdout);
  const result = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command });
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(run(["status", task.id]).stdout).status, "failed");
});

test("task text reaches custom agent stdin literally without shell interpretation", async (t) => {
  const { dir, run } = await fixture(t);
  const message = "Literal: \"doble\" 'simple' áéíóú ñ & | %PATH% $HOME $(echo unsafe)";
  // The prompt is a JSON document on stdin: the task must round-trip byte-exact after parsing.
  const command = await fixtureAgent(
    dir,
    `const fs = require("node:fs"); const input = JSON.parse(fs.readFileSync(0, "utf8")); if (input.task !== ${JSON.stringify(message)} || process.env.HARNESS_AGENT !== input.role) process.exit(9); console.log(JSON.stringify(${JSON.stringify(passedResult)}));`,
  );
  const task = JSON.parse(run(["run", "repo", message]).stdout);
  const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command });
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  assert.equal(JSON.parse(run(["status", task.id]).stdout).status, "completed");
});

test("{prompt} interpolation in custom agent command is rejected", async (t) => {
  const { dir, run } = await fixture(t);
  const task = JSON.parse(run(["run", "repo", "fixture unsafe interpolation"]).stdout);
  const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: "echo {prompt}" });
  assert.notEqual(executed.status, 0);
  const risks = (await readHandoffs(dir, task.id)).flatMap((h) => h.risks);
  assert.ok(risks.some((r) => /Unsafe \{prompt\}/.test(r)));
});

test("failed gate feedback reaches corrective implementer and retry completes", async (t) => {
  const { dir, run } = await fixture(t);
  const counter = path.join(os.tmpdir(), path.basename(dir) + "-counter.json");
  t.after(() => fs.rm(counter, { force: true }));
  const command = await fixtureAgent(
    dir,
    `const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const file = ${JSON.stringify(counter)};
const seen = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
seen[input.role] = (seen[input.role] || 0) + 1;
fs.writeFileSync(file, JSON.stringify(seen));
const result = ${JSON.stringify(passedResult)};
if (input.role === "reviewer" && seen.reviewer === 1) { result.status = "failed"; result.risks = ["REVIEW-FINDING-42"]; }
if (input.role === "architect" && seen.architect === 2 && !input.handoffs.some((h) => h.agent === "reviewer" && h.status === "failed" && h.risks.includes("REVIEW-FINDING-42"))) process.exit(8);
console.log(JSON.stringify(result));`,
  );
  const task = JSON.parse(run(["run", "repo", "fixture corrective loop"]).stdout);
  const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command, HARNESS_MAX_RETRIES: "1" });
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  assert.equal(JSON.parse(executed.stdout).status, "completed");
  assert.deepEqual(JSON.parse(await fs.readFile(counter, "utf8")), { architect: 2, reviewer: 2 });
});

test("interrupted running node resumes on the next execute", async (t) => {
  const { dir, run } = await fixture(t);
  const task = JSON.parse(run(["run", "repo", "fixture resume"]).stdout);
  const file = path.join(dir, ".harness", "tasks", "active", task.id + ".json");
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  persisted.dag[0].status = "passed";
  persisted.dag[0].attempts = 1;
  persisted.dag[1].status = "running";
  persisted.dag[1].attempts = 1;
  await fs.writeFile(file, JSON.stringify(persisted));
  // A real interrupted delegated attempt always has its persisted pre-spawn baseline.
  await fs.writeFile(
    path.join(dir, ".harness/runtime", task.id + "-architect-1-baseline.json"),
    await snapshotEntries(dir),
  );
  const command = await fixtureAgent(dir, `console.log(JSON.stringify(${JSON.stringify(passedResult)}));`);
  const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command });
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  const result = JSON.parse(executed.stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.dag[1].attempts, 2);
});

test("agent processes exceeding HARNESS_AGENT_TIMEOUT_MS are killed and fail the node", async (t) => {
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(dir, "setTimeout(() => {}, 60000);");
  const task = JSON.parse(run(["run", "repo", "timeout regression"]).stdout);
  const started = Date.now();
  const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command, HARNESS_AGENT_TIMEOUT_MS: "400" });
  assert.ok(Date.now() - started < 30000, "the hung agent must be killed, not awaited");
  assert.notEqual(executed.status, 0);
  const handoffs = await readHandoffs(dir, task.id);
  assert.ok(
    handoffs.some((h) => h.status === "failed" && /timeout/i.test(JSON.stringify(h.risks))),
    JSON.stringify(handoffs.map((h) => ({ agent: h.agent, status: h.status, risks: h.risks }))),
  );
});

test("a live lock blocks concurrent execute while a stale lock is reclaimed", async (t) => {
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(dir, `console.log(JSON.stringify(${JSON.stringify(passedResult)}));`);
  const task = JSON.parse(run(["run", "repo", "lock regression"]).stdout);
  const lock = path.join(dir, ".harness", "state", task.id + ".lock");
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const blocked = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already executing/);
  await fs.writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  const reclaimed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command });
  assert.equal(reclaimed.status, 0, reclaimed.stderr + reclaimed.stdout);
  await assert.rejects(fs.stat(lock), { code: "ENOENT" }, "the lock must be released after execution");
});

test("list and abort report tasks and move an active task to failed without deleting evidence", async (t) => {
  const { dir, run } = await fixture(t);
  const task = JSON.parse(run(["run", "api", "abort regression"]).stdout);
  const listed = JSON.parse(run(["list"]).stdout);
  assert.ok(listed.some((row) => row.id === task.id && row.status === "active" && row.domain === "api"));
  const aborted = run(["abort", task.id, "superseded", "by", "newer", "run"]);
  assert.equal(aborted.status, 0, aborted.stderr);
  assert.equal(JSON.parse(aborted.stdout).aborted.reason, "superseded by newer run");
  const state = JSON.parse(run(["status", task.id]).stdout);
  assert.equal(state.status, "failed");
  assert.ok(await fs.stat(path.join(dir, ".harness", "tasks", "failed", task.id + ".json")));
  assert.notEqual(run(["abort", task.id]).status, 0, "only active tasks can be aborted");
});

test("workspace lock blocks a different task and dead owner is recovered", async (t) => {
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(dir, `console.log(JSON.stringify(${JSON.stringify(passedResult)}));`);
  const first = JSON.parse(run(["run", "repo", "workspace lock first"]).stdout);
  const second = JSON.parse(run(["run", "repo", "workspace lock second"]).stdout);
  const lock = path.join(dir, ".harness", "state", "workspace.lock");
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: "live" }));
  const blocked = run(["execute", second.id], { HARNESS_AGENT_COMMAND: command });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already executing/);
  await fs.writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 54321, at: 1, token: "dead" }));
  const recovered = run(["execute", first.id], { HARNESS_AGENT_COMMAND: command });
  assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
});

test("retry reopens failed task without erasing attempts or handoff evidence", async (t) => {
  const { dir, run } = await fixture(t);
  const task = JSON.parse(run(["run", "repo", "retry quota failure"]).stdout);
  const failed = run(["execute", task.id], {
    HARNESS_AGENT_COMMAND: process.platform === "win32" ? "exit /b 7" : "exit 7",
  });
  assert.notEqual(failed.status, 0);
  const before = await readHandoffs(dir, task.id);
  const retried = run(["retry", task.id, "quota restored"]);
  assert.equal(retried.status, 0, retried.stderr);
  const active = JSON.parse(run(["status", task.id]).stdout);
  assert.equal(active.status, "active");
  assert.ok(
    active.dag.some((node) => node.attempts > 0),
    "attempt history must be preserved",
  );
  const after = await readHandoffs(dir, task.id);
  assert.equal(after.length, before.length, "retry must preserve prior handoffs");
});

test("verification gates honor bounded HARNESS_GATE_TIMEOUT_MS", async (t) => {
  const { dir, run } = await fixture(t);
  const manifestFile = path.join(dir, ".harness", "manifests", "domains.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.domains.find((domain) => domain.domain === "repo").verification = [
    [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
  ];
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const started = Date.now();
  const result = run(["verify", "repo"], { HARNESS_GATE_TIMEOUT_MS: "300" });
  assert.ok(Date.now() - started < 30000);
  assert.notEqual(result.status, 0);
});

test("aborting a multi task closes active children instead of orphaning them", async (t) => {
  const { run } = await fixture(t);
  const parent = JSON.parse(run(["run", "auto", "api backoffice coordinated abort"]).stdout);
  assert.equal(parent.domain, "multi");
  const aborted = run(["abort", parent.id, "operator stop"]);
  assert.equal(aborted.status, 0, aborted.stderr);
  for (const childId of parent.children) {
    const child = JSON.parse(run(["status", childId]).stdout);
    assert.equal(child.status, "failed");
    assert.equal(child.aborted.reason, "operator stop");
  }
});

test("a completed task can never carry a scope violation", async (t) => {
  const { dir, run } = await fixture(t);
  const safe = await fixtureAgent(dir, `console.log(JSON.stringify(${JSON.stringify(passedResult)}));`);
  const task = JSON.parse(run(["run", "repo", "completed invariant"]).stdout);
  assert.equal(run(["execute", task.id], { HARNESS_AGENT_COMMAND: safe }).status, 0);
  const file = path.join(dir, ".harness/tasks/completed", task.id + ".json");
  const completed = JSON.parse(await fs.readFile(file, "utf8"));
  completed.scopeViolation = {
    agent: "architect",
    attempt: 1,
    reason: "forged",
    protectedState: false,
    restoration: [],
  };
  await fs.writeFile(file, JSON.stringify(completed));
  const checked = run(["check"]);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /completed with unresolved scope violation/);
});

test("a lock created by another platform is never recovered automatically", async (t) => {
  const { dir, run } = await fixture(t);
  const task = JSON.parse(run(["run", "repo", "cross environment lock"]).stdout);
  const foreign = process.platform === "win32" ? "linux" : "win32";
  await fs.writeFile(
    path.join(dir, ".harness/state/workspace.lock"),
    JSON.stringify({ pid: 999999, at: 1, token: "x", platform: foreign, host: "other" }),
  );
  const blocked = run(["execute", task.id]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Lock owned by another environment/);
});
