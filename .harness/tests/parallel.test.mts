// End-to-end proof of the parallel scheduler. The "host" is tests/fixtures/sim-agent.cts: deterministic, tokenless,
// and it logs every start/end so overlap is measured from outside the Harness, never inferred from it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixture, root, gitEnv, gitIn, fakeClaudeBinary, claudePathEnv } from "./helpers.mts";

const SIM = path.join(root, ".harness", "tests", "fixtures", "sim-agent.cts");
const IGNORES = [
  ".harness/runtime/*",
  "!.harness/runtime/.gitkeep",
  ".harness/tasks/*/*",
  ".harness/handoffs/*",
  ".harness/state/*",
  ".harness/logs/*/*",
  "__pycache__/",
].join("\n");

async function parallelFixture(t, { spec = {}, env = {} } = {}) {
  const base = await fixture(t);
  const aux = await fs.mkdtemp(path.join(os.tmpdir(), "redevent-sim-"));
  t.after(() => fs.rm(aux, { recursive: true, force: true }));
  await fs.writeFile(path.join(base.dir, ".gitignore"), IGNORES + "\n");
  const git = gitIn(base.dir);
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "base"],
  ])
    assert.equal(git(...args).status, 0, git(...args).stderr);
  const files = {
    spec: path.join(aux, "spec.json"),
    log: path.join(aux, "sim.log"),
    state: path.join(aux, "state"),
    worktrees: path.join(aux, "wt"),
  };
  await fs.writeFile(files.spec, JSON.stringify(spec));
  const agent = `"${process.execPath}" "${SIM}"`;
  const baseEnv = {
    HARNESS_AGENT_COMMAND: agent,
    SIM_SPEC: files.spec,
    SIM_LOG: files.log,
    SIM_STATE: files.state,
    HARNESS_WORKTREE_DIR: files.worktrees,
    HARNESS_MAX_WORKERS: "3",
    HARNESS_HOST_LIMIT: "3",
    HARNESS_ROLE_LIMITS: "documentation=3,backend=3,infra=2",
    HARNESS_MAX_RETRIES: "0",
    HARNESS_GATE_TIMEOUT_MS: "20000",
    ...env,
  };
  const exec = (args, extra = {}) => base.run(args, { ...baseEnv, ...extra });
  // A failing test must never leave hanging simulated agents (or their descendants) holding the runner's pipes.
  t.after(() => {
    const pids = [];
    try {
      for (const line of readFileSync(files.log, "utf8").trim().split("\n")) pids.push(JSON.parse(line).pid);
    } catch {}
    try {
      for (const name of readdirSync(files.state))
        if (name.endsWith(".grandchild")) pids.push(Number(readFileSync(path.join(files.state, name), "utf8")));
    } catch {}
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
  const events = () =>
    existsSync(files.log)
      ? readFileSync(files.log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { ...base, git, aux, files, baseEnv, exec, events, agent };
}

const unitsTask = (units, head = "Crear la documentación de las áreas de la plataforma") =>
  head + "\n\n" + units.map((u) => `unit: ${u}`).join("\n") + "\n";

const plan = (f, text, domain = "docs") => {
  const created = f.exec(["run", domain, text]);
  assert.equal(created.status, 0, created.stderr + created.stdout);
  return JSON.parse(created.stdout);
};
const loadTask = async (dir, id) => {
  for (const status of ["active", "completed", "failed"]) {
    const file = path.join(dir, ".harness", "tasks", status, id + ".json");
    if (existsSync(file)) return JSON.parse(await fs.readFile(file, "utf8"));
  }
  throw new Error("task not found " + id);
};
const span = (events, node) => {
  const mine = events.filter((e) => e.node === node);
  return {
    start: Math.min(...mine.filter((e) => e.event === "start").map((e) => e.at)),
    end: Math.max(...mine.filter((e) => e.event === "end").map((e) => e.at)),
  };
};
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (condition, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await condition()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const threeUnits = [
  "a | agent=documentation | owns=docs/a/** | weight=2",
  "b | agent=documentation | owns=docs/b/** | weight=2",
  "c | agent=documentation | owns=docs/c/** | weight=2",
];

test("independent units run simultaneously in isolated worktrees and integrate deterministically", async (t) => {
  // 6000 ms keeps the fixed per-node process/worktree overhead on Windows (~12 s) from dominating the wall-clock bound.
  const ms = 6000;
  const f = await parallelFixture(t, { spec: { "*": { ms } } });
  const task = plan(f, unitsTask(threeUnits));
  assert.equal(task.plan.source, "directive");
  assert.equal(task.plan.parallel, true);
  assert.deepEqual(
    task.dag.filter((n) => n.unit).map((n) => n.id),
    ["documentation-a", "documentation-b", "documentation-c"],
  );
  const started = Date.now();
  const executed = f.exec(["execute", task.id]);
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  const wall = Date.now() - started;
  const done = JSON.parse(executed.stdout);
  assert.equal(done.status, "completed");
  const events = f.events();
  const [a, b, c] = ["documentation-a", "documentation-b", "documentation-c"].map((n) => span(events, n));
  assert.ok(
    overlap(a, b) && overlap(b, c) && overlap(a, c),
    "all three writers must have been running at the same time",
  );
  assert.ok(new Set(events.map((e) => e.cwd)).size >= 3, "every node works in its own checkout");
  for (const e of events.filter((e) => e.node.startsWith("documentation-")))
    assert.notEqual(e.cwd, f.dir, "writers never run in the main checkout");
  for (const unit of ["a", "b", "c"])
    assert.equal(
      await fs.readFile(path.join(f.dir, "docs", unit, "out.txt"), "utf8"),
      `work by documentation-${unit}\n`,
    );
  assert.ok(done.metrics.peakConcurrency >= 3, JSON.stringify(done.metrics));
  assert.equal(done.metrics.mode, "parallel");
  assert.ok(
    done.metrics.speedup > 1.4,
    "measured speedup versus the sum of the node wall times: " + done.metrics.speedup,
  );
  // Sequential execution would take about 3 * (ms + per-node overhead); this bound only has to separate the two with
  // room for slow Windows disks and antivirus scans, so it must not sit near the measured wall time.
  assert.ok(
    wall < 3 * ms + 12000,
    "wall time must be well below sequential execution of the three units plus gates: " + wall,
  );
  assert.equal(
    f.git("worktree", "list", "--porcelain").stdout.split("worktree ").length - 1,
    1,
    "no worktree is left behind after completion",
  );
  assert.ok(
    existsSync(path.join(f.dir, ".harness", "runtime", "integration")),
    "integration journal and patch are kept as evidence",
  );
});

test("dependent units wait for their dependencies and the review waits for every writer", async (t) => {
  const f = await parallelFixture(t, { spec: { "*": { ms: 700 } } });
  const task = plan(
    f,
    unitsTask([
      "a | agent=documentation | owns=docs/a/**",
      "b | agent=documentation | owns=docs/b/** | after=a",
      "c | agent=documentation | owns=docs/c/**",
    ]),
  );
  const executed = f.exec(["execute", task.id]);
  assert.equal(executed.status, 0, executed.stderr);
  const events = f.events();
  const [a, b, c] = ["documentation-a", "documentation-b", "documentation-c"].map((n) => span(events, n));
  assert.ok(b.start >= a.end, "b declares after=a: it must not start before a finished");
  assert.ok(overlap(a, c), "c is independent of a and runs beside it");
  const review = span(events, "reviewer");
  assert.ok(review.start >= Math.max(a.end, b.end, c.end), "the reviewer needs every writer integrated first");
});

test("overlapping ownership is serialized by the planner and never runs concurrently", async (t) => {
  const f = await parallelFixture(t, { spec: { "*": { ms: 600 } } });
  const task = plan(
    f,
    unitsTask([
      "wide | agent=documentation | owns=docs/**",
      "narrow | agent=documentation | owns=docs/deep/** ",
      "other | agent=documentation | owns=docs/elsewhere/**",
    ]),
  );
  assert.ok(
    task.plan.notes.some((n) => /narrow serialized after wide/.test(n)),
    JSON.stringify(task.plan.notes),
  );
  const executed = f.exec(["execute", task.id]);
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  const events = f.events();
  assert.ok(!overlap(span(events, "documentation-wide"), span(events, "documentation-narrow")));
  assert.ok(
    !overlap(span(events, "documentation-wide"), span(events, "documentation-other")),
    "docs/** overlaps everything under docs/",
  );
});

test("multiple instances of one role keep distinct node ids, handoffs and attempts", async (t) => {
  const f = await parallelFixture(t, { spec: { "*": { ms: 300 } } });
  const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
  const executed = f.exec(["execute", task.id]);
  assert.equal(executed.status, 0, executed.stderr);
  const handoffs = (await fs.readdir(path.join(f.dir, ".harness", "handoffs"))).filter((n) => n.startsWith(task.id));
  for (const name of ["documentation-a-1", "documentation-b-1", "reviewer-1", "verifier-1"])
    assert.ok(handoffs.includes(`${task.id}-${name}.json`), name + " in " + handoffs);
  const handoff = JSON.parse(
    await fs.readFile(path.join(f.dir, ".harness", "handoffs", `${task.id}-documentation-a-1.json`), "utf8"),
  );
  assert.equal(handoff.agent, "documentation");
  assert.equal(handoff.node, "documentation-a");
  assert.ok(handoff.runId);
  assert.deepEqual(
    (await loadTask(f.dir, task.id)).agents.sort(),
    ["context-manager", "documentation", "logger", "reviewer", "verifier"].sort(),
  );
});

test("a node can only write inside the paths it owns", async (t) => {
  const f = await parallelFixture(t, {
    spec: { "documentation-a": { ms: 100, write: [{ path: "docs/b/stolen.txt" }, { path: "docs/a/out.txt" }] } },
  });
  const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
  const executed = f.exec(["execute", task.id]);
  assert.notEqual(executed.status, 0);
  const final = await loadTask(f.dir, task.id);
  assert.equal(final.status, "failed");
  assert.match(final.scopeViolation.reason, /outside allowed scope: docs\/b\/stolen\.txt/);
  assert.equal(final.scopeViolation.contained, true, "the write happened in a throw-away worktree");
  assert.equal(
    existsSync(path.join(f.dir, "docs", "b", "stolen.txt")),
    false,
    "nothing escaped into the main checkout",
  );
});

test("an agent that commits inside its worktree is a violation: delivery is never delegated", async (t) => {
  const f = await parallelFixture(t, { spec: { "*": { ms: 100 }, "documentation-a": { commit: true } } });
  const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
  const executed = f.exec(["execute", task.id]);
  assert.notEqual(executed.status, 0);
  const final = await loadTask(f.dir, task.id);
  assert.equal(final.status, "failed");
  assert.match(final.scopeViolation.reason, /moved HEAD inside its worktree/);
  assert.equal(final.scopeViolation.contained, true);
  assert.equal(
    existsSync(path.join(f.dir, "docs", "a", "out.txt")),
    false,
    "nothing from the offending node is integrated",
  );
  assert.equal(f.git("rev-list", "--count", "HEAD").stdout.trim(), "1", "the repository history is untouched");
});

test("writes that bypass the worktree and hit the main checkout are caught by the integration guard", async (t) => {
  const f = await parallelFixture(t, {});
  const escape = path.join(f.dir, "docs", "a", "sneaky.txt");
  await fs.writeFile(f.files.spec, JSON.stringify({ "documentation-a": { ms: 200, escape } }));
  const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
  const executed = f.exec(["execute", task.id]);
  assert.notEqual(executed.status, 0);
  const final = await loadTask(f.dir, task.id);
  assert.equal(final.status, "failed");
  assert.match(
    final.scopeViolation.reason,
    /Parallel phase wrote to the main checkout outside integration: docs\/a\/sneaky\.txt/,
  );
});

test("a failed unit never yields a successful task and blocks only its dependents", async (t) => {
  const f = await parallelFixture(t, { spec: { "*": { ms: 300 }, "documentation-b": { failTimes: 9 } } });
  const task = plan(f, unitsTask(threeUnits));
  const executed = f.exec(["execute", task.id]);
  assert.notEqual(executed.status, 0);
  const final = await loadTask(f.dir, task.id);
  assert.equal(final.status, "failed");
  const status = Object.fromEntries(final.dag.map((n) => [n.id, n.status]));
  assert.equal(status["documentation-a"], "passed");
  assert.equal(status["documentation-c"], "passed");
  assert.equal(status["documentation-b"], "failed");
  assert.equal(status.reviewer, "blocked");
  assert.equal(status.verifier, "blocked");
  assert.equal(existsSync(path.join(f.dir, "docs", "b", "out.txt")), false, "a failed unit integrates nothing");
  assert.equal(existsSync(path.join(f.dir, "docs", "a", "out.txt")), true, "independent valid work is preserved");
});

test("only the failed unit is retried, with a fresh worktree and bounded attempts", async (t) => {
  const f = await parallelFixture(t, {
    spec: { "*": { ms: 200 }, "documentation-b": { failTimes: 1 } },
    env: { HARNESS_MAX_RETRIES: "2" },
  });
  const task = plan(f, unitsTask(threeUnits));
  const executed = f.exec(["execute", task.id]);
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  const final = await loadTask(f.dir, task.id);
  const attempts = Object.fromEntries(final.dag.map((n) => [n.id, n.attempts]));
  assert.equal(attempts["documentation-a"], 1);
  assert.equal(attempts["documentation-b"], 2);
  assert.equal(attempts["documentation-c"], 1);
  assert.equal(final.metrics.retries >= 1, true);
});

test("a reviewer finding reopens only the writer that owns the cited path", async (t) => {
  const f = await parallelFixture(t, {
    spec: { "*": { ms: 200 }, reviewer: { findings: ["docs/b/out.txt is wrong"], failTimes: 1 } },
    env: { HARNESS_MAX_RETRIES: "2" },
  });
  const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
  const executed = f.exec(["execute", task.id]);
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  const final = await loadTask(f.dir, task.id);
  const attempts = Object.fromEntries(final.dag.map((n) => [n.id, n.attempts]));
  assert.equal(attempts["documentation-a"], 1, "the writer that owns nothing cited is left alone");
  assert.equal(attempts["documentation-b"], 2, "the owner of docs/b/** is corrected");
  assert.equal(attempts.reviewer, 2, "and the review is repeated on the integrated result");
  assert.equal(final.status, "completed");
});

test("a per-node timeout kills the whole descendant tree and does not stop its siblings", async (t) => {
  const f = await parallelFixture(t, {
    spec: { "*": { ms: 300 }, "documentation-b": { hang: true, grandchild: true } },
  });
  const text = unitsTask([
    "a | agent=documentation | owns=docs/a/**",
    `b | agent=documentation | owns=docs/b/** | timeoutMs=${process.platform === "win32" ? 5000 : 1500}`,
  ]);
  const task = plan(f, text);
  const executed = f.exec(["execute", task.id]);
  assert.notEqual(executed.status, 0);
  const final = await loadTask(f.dir, task.id);
  const b = final.dag.find((n) => n.id === "documentation-b");
  assert.equal(b.status, "failed");
  assert.equal(b.failureCategory, "timeout");
  assert.equal(final.dag.find((n) => n.id === "documentation-a").status, "passed");
  const pid = Number(await fs.readFile(path.join(f.files.state, "documentation-b.grandchild"), "utf8"));
  assert.equal(await waitFor(() => !alive(pid), 5000), true, "descendant processes must die with the node");
});

test(
  "Ctrl+C cancels every worker tree, keeps evidence and leaves the task resumable",
  { skip: process.platform === "win32" && "SIGINT cannot be delivered to a console-less child on Windows" },
  async (t) => {
    const f = await parallelFixture(t, {
      spec: {
        "*": { ms: 300 },
        "documentation-a": { hang: true, grandchild: true },
        "documentation-b": { hang: true, grandchild: true },
      },
    });
    const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
    const child = spawn(process.execPath, [path.join(f.dir, ".harness", "core.mts"), "execute", task.id], {
      cwd: f.dir,
      detached: true,
      env: { ...process.env, ...gitEnv, HARNESS_HOST: "", ...f.baseEnv },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    assert.equal(
      await waitFor(() => f.events().filter((e) => e.event === "start").length >= 2),
      true,
      "both writers started: " + output,
    );
    assert.equal(
      await waitFor(() =>
        ["documentation-a", "documentation-b"].every((n) => existsSync(path.join(f.files.state, n + ".grandchild"))),
      ),
      true,
      "both simulated agents spawned their descendant",
    );
    const pids = [];
    for (const n of ["documentation-a", "documentation-b"])
      pids.push(Number(await fs.readFile(path.join(f.files.state, n + ".grandchild"), "utf8")));
    process.kill(-child.pid, "SIGINT"); // a terminal delivers Ctrl+C to the whole foreground process group
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.notEqual(code, 0);
    for (const pid of pids)
      assert.equal(await waitFor(() => !alive(pid), 5000), true, "grandchild " + pid + " must be killed");
    const interrupted = await loadTask(f.dir, task.id);
    assert.equal(interrupted.status, "active", "the task is interrupted, not failed or completed");
    assert.ok(interrupted.dag.filter((n) => n.unit).every((n) => n.status === "pending" && n.interrupted));
    const kept = await fs.readdir(path.join(f.files.worktrees, (await fs.readdir(f.files.worktrees))[0]));
    assert.ok(kept.length >= 2, "worktrees of cancelled runs stay as evidence");
    // Resume with a cooperative host: the task completes and no work is duplicated in main.
    await fs.writeFile(f.files.spec, JSON.stringify({ "*": { ms: 200 } }));
    const resumed = f.exec(["execute", task.id]);
    assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
    assert.equal(JSON.parse(resumed.stdout).status, "completed");
  },
);

test(
  "a crashed scheduler is recovered: orphan agents are reaped, the interrupted node is rerun, evidence is kept",
  {
    skip:
      !process.platform.startsWith("linux") && "orphan identification is implemented for Linux/macOS process tables",
  },
  async (t) => {
    const f = await parallelFixture(t, {
      spec: {
        "*": { ms: 300 },
        "documentation-a": { hang: true, grandchild: true },
        "documentation-b": { hang: true },
      },
    });
    const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
    const child = spawn(process.execPath, [path.join(f.dir, ".harness", "core.mts"), "execute", task.id], {
      cwd: f.dir,
      detached: true,
      env: { ...process.env, ...gitEnv, HARNESS_HOST: "", ...f.baseEnv },
    });
    child.stdout.resume();
    child.stderr.resume();
    assert.equal(await waitFor(() => f.events().filter((e) => e.event === "start").length >= 2), true);
    const lock = JSON.parse(await fs.readFile(path.join(f.dir, ".harness", "state", "workspace.lock"), "utf8"));
    process.kill(lock.pid, "SIGKILL"); // no cleanup of any kind: the agents become orphans
    await new Promise((resolve) => child.on("close", resolve));
    const orphans = f
      .events()
      .filter((e) => e.event === "start")
      .map((e) => e.pid);
    assert.ok(orphans.some(alive), "the simulated agents survived the scheduler");
    await fs.writeFile(f.files.spec, JSON.stringify({ "*": { ms: 200 } }));
    const resumed = f.exec(["execute", task.id]);
    assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
    assert.equal(JSON.parse(resumed.stdout).status, "completed");
    assert.equal(
      await waitFor(() => orphans.every((pid) => !alive(pid)), 5000),
      true,
      "orphans of the dead scheduler are terminated",
    );
    const audit = (await fs.readdir(path.join(f.dir, ".harness", "logs", "audit"))).map((n) =>
      JSON.parse(readFileSync(path.join(f.dir, ".harness", "logs", "audit", n), "utf8")),
    );
    assert.ok(
      audit.some((e) => e.event === "recovered-abandoned-runs"),
      "recovery is audited",
    );
  },
);

test("final gates run against the integrated result, not against any single worktree", async (t) => {
  const f = await parallelFixture(t, { spec: { "*": { ms: 300 } } });
  const manifest = path.join(f.dir, ".harness", "manifests", "domains.json");
  const domains = JSON.parse(await fs.readFile(manifest, "utf8"));
  const gate =
    "process.exit(require('fs').existsSync('docs/a/out.txt') && require('fs').existsSync('docs/b/out.txt') ? 0 : 1)";
  for (const d of domains.domains) if (d.domain === "docs") d.verification = [[process.execPath, "-e", gate]];
  await fs.writeFile(manifest, JSON.stringify(domains));
  assert.equal(f.git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qam", "gate").status, 0);
  const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
  const executed = f.exec(["execute", task.id]);
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  const verifier = JSON.parse(
    await fs.readFile(path.join(f.dir, ".harness", "handoffs", `${task.id}-verifier-1.json`), "utf8"),
  );
  assert.equal(verifier.status, "passed");
});

test("HARNESS_MAX_WORKERS=1 keeps the historical sequential behaviour for the same plan", async (t) => {
  const f = await parallelFixture(t, { spec: { "*": { ms: 400 } }, env: { HARNESS_MAX_WORKERS: "1" } });
  const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
  const executed = f.exec(["execute", task.id]);
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  const events = f.events();
  assert.ok(
    !overlap(span(events, "documentation-a"), span(events, "documentation-b")),
    "one worker means one agent at a time",
  );
  assert.ok(
    events.filter((e) => e.node.startsWith("documentation-")).every((e) => e.cwd === f.dir),
    "sequential mode runs in the main checkout, as before",
  );
  assert.equal(JSON.parse(executed.stdout).metrics.mode, "sequential");
});

test("legacy tasks are unchanged: node id equals agent, historical handoff names, chained DAG", async (t) => {
  const f = await parallelFixture(t, { spec: { "*": { ms: 100 } } });
  const task = plan(f, "Crear la documentación del proceso", "docs");
  assert.equal(task.plan, undefined);
  assert.ok(task.dag.every((n) => n.id === n.agent));
  const executed = f.exec(["execute", task.id]);
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  const handoffs = (await fs.readdir(path.join(f.dir, ".harness", "handoffs"))).filter((n) => n.startsWith(task.id));
  assert.ok(handoffs.includes(`${task.id}-documentation-1.json`));
});

test("planner declines to parallelize when coordination costs more than it saves", async (t) => {
  const f = await parallelFixture(t, {});
  const tiny = plan(
    f,
    unitsTask([
      "a | agent=documentation | owns=docs/a/** | weight=0.05",
      "b | agent=documentation | owns=docs/b/** | weight=0.05",
    ]),
  );
  assert.equal(tiny.plan.parallel, false);
  assert.match(tiny.plan.notes.join(" "), /ordered chain/);
  const node = (id) => tiny.dag.find((n) => n.id === id);
  assert.ok(node("documentation-b").dependsOn.includes("documentation-a"));
});

test("bulleted work on disjoint paths is split automatically; one bullet is not", async (t) => {
  const f = await parallelFixture(t, {});
  const many = plan(
    f,
    "Crear documentación:\n- Crear la guía en `docs/guide/intro.md` con ejemplos extensos de uso para operadores nuevos de la plataforma completa de eventos\n- Agregar el índice en `docs/index/readme.md` con enlaces cruzados para todos los módulos de eventos y proveedores actuales\n- Actualizar el glosario en `docs/glossary/terms.md` incluyendo las definiciones de los roles y permisos de cada portal\n",
  );
  assert.equal(many.plan.source, "auto");
  assert.equal(many.plan.units.length, 3);
  const single = plan(f, "Crear documentación:\n- Crear la guía en `docs/guide/intro.md` con ejemplos\n");
  assert.equal(single.plan, undefined, "a single owner never spawns extra agents");
  const preview = f.exec(["plan", "docs", unitsTask(threeUnits)]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout)[0].plan.parallel, true);
  assert.deepEqual(
    (await fs.readdir(path.join(f.dir, ".harness", "tasks", "active"))).length,
    2,
    "plan preview persists nothing",
  );
});

async function fakeHosts(aux) {
  const bin = path.join(aux, "hosts");
  await fs.mkdir(bin, { recursive: true });
  const calls = path.join(aux, "host-calls.jsonl");
  const body = (host) => `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
const input = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ host: ${JSON.stringify(host)}, role: input.role, node: input.node?.id ?? null, args, cwd: process.cwd(), resultEnv: !!process.env.HARNESS_RESULT_FILE, handoffPaths: input.handoffs.map((h) => h.path) }) + "\\n");
const files = [];
if (input.node?.owns) {
  const file = input.node.owns[0].replace(/\\/?\\*\\*$/, "") + "/out.txt";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "by " + input.node.id + "\\n");
  files.push(file);
}
const result = { status: "passed", changes: files.map((f) => "wrote " + f), files, decisions: [], risks: [], verification: ["fake ${host}"], nextAction: null };
if (${JSON.stringify(host)} === "codex") fs.writeFileSync(value("--output-last-message"), JSON.stringify(result));
else console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: result, usage: { input_tokens: 11, output_tokens: 7 }, result: "" }));`;
  for (const host of ["codex", "claude"]) {
    await fs.writeFile(path.join(bin, host + ".cjs"), body(host));
    if (process.platform === "win32")
      await fs.writeFile(path.join(bin, host + ".cmd"), `@"${process.execPath}" "%~dp0${host}.cjs" %*\r\n`);
    else {
      await fs.writeFile(
        path.join(bin, host),
        `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${host}.cjs" "$@"\n`,
      );
      await fs.chmod(path.join(bin, host), 0o755);
    }
  }
  return { bin, calls };
}

for (const host of ["codex", "claude"]) {
  test(`${host} host: delegated nodes run in worktrees, results integrate, host-specific contract is preserved`, async (t) => {
    const f = await parallelFixture(t, { env: { HARNESS_AGENT_COMMAND: "" } });
    const { bin, calls } = await fakeHosts(f.aux);
    const task = plan(f, unitsTask(threeUnits.slice(0, 2)));
    const executed = f.exec(["execute", task.id], { HARNESS_HOST: host, ...claudePathEnv(bin) });
    assert.equal(executed.status, 0, executed.stderr + executed.stdout);
    const final = JSON.parse(executed.stdout);
    assert.equal(final.status, "completed");
    const seen = (await fs.readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const writers = seen.filter((c) => c.role === "documentation");
    assert.equal(writers.length, 2);
    const inWorktree = (c) => c.cwd.startsWith(realpathSync(f.files.worktrees));
    for (const call of writers) assert.ok(inWorktree(call), "concurrent writers run inside a worktree: " + call.cwd);
    const reviewer = seen.find((c) => c.role === "reviewer");
    assert.ok(!inWorktree(reviewer), "a node that runs alone needs no worktree and works in the main checkout");
    for (const unit of ["a", "b"])
      assert.equal(await fs.readFile(path.join(f.dir, "docs", unit, "out.txt"), "utf8"), `by documentation-${unit}\n`);
    if (host === "claude") {
      for (const call of seen) assert.equal(call.resultEnv, false, "Claude never learns a result file path");
      for (const call of writers)
        assert.deepEqual(
          call.args.filter((a, i) => call.args[i - 1] === "--add-dir").sort(),
          [path.join(f.dir, ".harness", "handoffs"), path.join(f.dir, ".harness", "tasks")].sort(),
          "isolated Claude reads handoffs and sources from the main checkout",
        );
      assert.ok(!reviewer.args.includes("--add-dir"));
      assert.equal(writers[0].args[writers[0].args.indexOf("--permission-mode") + 1], "acceptEdits");
      assert.equal(reviewer.args[reviewer.args.indexOf("--permission-mode") + 1], "default");
      assert.ok(reviewer.args.includes("--strict-mcp-config"), "read-only reviewers keep their closed tool set");
      assert.equal(final.metrics.tokens.input_tokens, 11 * seen.length, "usage reported by Claude is aggregated");
    } else {
      for (const call of seen) {
        assert.equal(call.resultEnv, true);
        assert.ok(!call.args.includes("--add-dir"));
      }
      for (const call of writers) {
        const out = call.args[call.args.indexOf("--output-last-message") + 1];
        assert.ok(out.startsWith(call.cwd), "Codex writes its result inside its own worktree: " + out);
      }
      assert.equal(writers[0].args[writers[0].args.indexOf("--sandbox") + 1], "workspace-write");
      assert.equal(reviewer.args[reviewer.args.indexOf("--sandbox") + 1], "read-only");
      assert.equal(final.metrics.tokens, "not reported by host", "Codex reports no usage: never invented");
    }
    assert.ok(
      writers.every((c) => c.handoffPaths.every((p) => path.isAbsolute(p))),
      "isolated nodes get absolute handoff paths",
    );
  });
}
