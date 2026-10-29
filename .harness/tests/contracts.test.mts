import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root, call, fixture } from "./helpers.mts";

test("check validates fixed agents, domains and skills", () => {
  const r = call(["check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Harness check: OK/);
});

test("check rejects manifests that violate their schema and stale agent contracts", async (t) => {
  const { dir, run } = await fixture(t);
  await fs.cp(path.join(root, ".harness", "agents"), path.join(dir, ".harness", "agents"), { recursive: true });
  const initial = run(["check"]);
  assert.equal(initial.status, 0, initial.stderr);
  const file = path.join(dir, ".harness", "manifests", "domains.json");
  const original = await fs.readFile(file, "utf8");
  const broken = JSON.parse(original);
  broken.domains[0].tokenBudget = "many";
  await fs.writeFile(file, JSON.stringify(broken));
  const schemaFailure = run(["check"]);
  assert.notEqual(schemaFailure.status, 0);
  assert.match(schemaFailure.stderr, /domains\.json inválido/);
  await fs.writeFile(file, original);
  await fs.appendFile(path.join(dir, ".harness", "agents", "backend.md"), "drift\n");
  const drift = run(["check"]);
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /desactualizados/);
  assert.equal(run(["agents-doc"]).status, 0);
  assert.equal(run(["check"]).status, 0);
});

test("orchestrator guard hook blocks host product writes but allows Harness state and delegated specialists", async (t) => {
  const { dir } = await fixture(t);
  const hook = path.join(root, ".harness", "hooks", "guard-orchestrator.mts");
  const attempt = (file, env = {}) =>
    spawnSync(process.execPath, [hook], {
      cwd: dir,
      encoding: "utf8",
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }),
      env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: dir, ...env },
    });
  assert.equal(attempt("apps/api/main.go").status, 2);
  assert.equal(attempt(path.join(dir, "apps", "backoffice", "src", "x.ts")).status, 2);
  assert.equal(attempt(path.join(dir, ".harness", "state", "x.json")).status, 0);
  assert.equal(
    attempt(path.join(path.dirname(dir), "external-scratch.txt")).status,
    0,
    "files outside the repository are not product writes",
  );
  assert.equal(attempt("apps/api/main.go", { HARNESS_AGENT: "backend" }).status, 0);
  assert.equal(attempt("apps/api/main.go", { HARNESS_ALLOW_HOST_WRITES: "1" }).status, 0);
});

test("check rejects malformed completed task state instead of trusting historical status", async (t) => {
  const { dir, run } = await fixture(t);
  const task = JSON.parse(run(["run", "repo", "task integrity regression"]).stdout);
  const active = path.join(dir, ".harness", "tasks", "active", task.id + ".json");
  const broken = JSON.parse(await fs.readFile(active, "utf8"));
  broken.status = "completed";
  broken.dag[0].status = "passed";
  broken.dag[0].attempts = 1;
  await fs.writeFile(path.join(dir, ".harness", "tasks", "completed", task.id + ".json"), JSON.stringify(broken));
  await fs.unlink(active);
  const checked = run(["check"]);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /completed with unpassed nodes/);
});

test("guard hook denies unreadable input instead of failing open", () => {
  const hook = path.join(root, ".harness", "hooks", "guard-orchestrator.mts");
  const result = spawnSync(process.execPath, [hook], {
    input: "not json",
    encoding: "utf8",
    env: { ...process.env, HARNESS_AGENT: "", HARNESS_ALLOW_HOST_WRITES: "" },
  });
  assert.equal(result.status, 2);
});

test("active guard rejects operational junctions to core, managed runtime and external scratch", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-guard-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "harness-outside-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const state = path.join(dir, ".harness", "state");
  const core = path.join(dir, ".harness", "core");
  const managed = path.join(dir, ".harness", "runtime", "python");
  for (const folder of [state, core, managed]) await fs.mkdir(folder, { recursive: true });
  for (const [name, target] of [
    ["core-link", core],
    ["python-link", managed],
    ["outside-link", outside],
  ])
    await fs.symlink(target, path.join(state, name), process.platform === "win32" ? "junction" : "dir");
  const attempt = (file) =>
    spawnSync(process.execPath, [path.join(root, ".harness", "hooks", "guard-orchestrator.mts")], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({ tool_input: { file_path: file } }),
      env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: dir },
    });
  for (const name of ["core-link", "python-link", "outside-link"])
    assert.equal(attempt(path.join(state, name, "synthetic.txt")).status, 2, name);
  assert.equal(attempt(path.join(state, "synthetic.json")).status, 0);
  assert.equal(attempt(path.join(outside, "synthetic.txt")).status, 0);
  assert.equal(attempt(undefined).status, 2);
});

test("schema keywords outside the supported subset are reported instead of ignored", async () => {
  const { validateSchema } = await import(pathToFileURL(path.join(root, ".harness", "lib", "util.mts")).href);
  const errors = validateSchema("x", { type: "string", pattern: "^y$" });
  assert.ok(errors.some((message) => /unsupported schema keyword pattern/.test(message)));
  assert.deepEqual(validateSchema("x", { $schema: "s", $id: "i", type: "string" }), []);
});

test("moveTask compatibility shim updates its supplied task object", async (t) => {
  const { dir, run } = await fixture(t);
  const task = JSON.parse(run(["run", "repo", "by-reference compatibility fixture"]).stdout);
  const uri = pathToFileURL(path.join(dir, ".harness", "lib", "state.mts")).href;
  const script = `import {moveTask} from ${JSON.stringify(uri)}; const task=JSON.parse(process.argv[1]); await moveTask(task,"failed"); if(task.status!=="failed") throw Error("task mutation lost");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(task)], {
    cwd: dir,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
});
