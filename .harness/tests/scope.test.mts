import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fixture, passedResult, fixtureAgent, readHandoffs, interruptedTask, gitIn } from "./helpers.mts";

test("actual writes within scope are auto-declared and audited", async (t) => {
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(
    dir,
    `
    if (process.env.HARNESS_AGENT === "architect") require("node:fs").writeFileSync("undeclared.txt", "changed");
    console.log(JSON.stringify(${JSON.stringify(passedResult)}));
  `,
  );
  const task = JSON.parse(run(["run", "repo", "actual write auto-declaration"]).stdout);
  const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command });
  assert.equal(executed.status, 0, executed.stderr);
  const auditNames = await fs.readdir(path.join(dir, ".harness/logs/audit"));
  const events = await Promise.all(
    auditNames.map(async (name) => JSON.parse(await fs.readFile(path.join(dir, ".harness/logs/audit", name), "utf8"))),
  );
  assert.ok(events.some((entry) => entry.event === "auto-declared"));
});

for (const scenario of [
  { name: "forbidden same-content writes", file: "apps/api/forbidden.txt", agent: "architect", risk: /Actual write/ },
  { name: "read-only mutation", file: "review.txt", agent: "reviewer", risk: /Read-only agent changed/ },
  {
    name: "protected state mutation",
    file: ".harness/state/tampered.json",
    agent: "architect",
    risk: /protected operational state/,
  },
]) {
  test("scope latch survives retry and execute: " + scenario.name, async (t) => {
    const { dir, run } = await fixture(t);
    const command = await fixtureAgent(
      dir,
      `
      const fs=require("node:fs"), path=require("node:path");
      if(process.env.HARNESS_AGENT === ${JSON.stringify(scenario.agent)}) {
        const file=${JSON.stringify(scenario.file)};
        fs.mkdirSync(path.dirname(file),{recursive:true});
        fs.writeFileSync(file,"same content on every attempt");
      }
      console.log(JSON.stringify(${JSON.stringify(passedResult)}));
    `,
    );
    const task = JSON.parse(run(["run", "repo", "scope latch regression"]).stdout);
    const env = { HARNESS_AGENT_COMMAND: command, HARNESS_MAX_RETRIES: "1" };
    const executed = run(["execute", task.id], env);
    assert.notEqual(executed.status, 0, executed.stderr);
    const failed = JSON.parse(run(["status", task.id]).stdout);
    assert.equal(failed.status, "failed");
    assert.equal(failed.dag.find((n) => n.agent === scenario.agent).attempts, 1);
    assert.match(failed.scopeViolation.reason, scenario.risk);
    assert.notEqual(run(["execute", task.id], env).status, 0);
    const retry = run(["retry", task.id, "try unchanged write"]);
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /Unresolved scope violation/);
    assert.deepEqual(JSON.parse(run(["status", task.id]).stdout), failed);
    assert.equal(await fs.readFile(path.join(dir, scenario.file), "utf8"), "same content on every attempt");

    // Simulate interruption after the latch was persisted, before terminal movement.
    const activeFile = path.join(dir, ".harness/tasks/active", task.id + ".json");
    failed.status = "active";
    await fs.writeFile(activeFile, JSON.stringify(failed));
    await fs.unlink(path.join(dir, ".harness/tasks/failed", task.id + ".json"));
    assert.notEqual(run(["execute", task.id], env).status, 0);
    const resumed = JSON.parse(run(["status", task.id]).stdout);
    assert.equal(resumed.dag.find((n) => n.agent === scenario.agent).attempts, 1);
    assert.deepEqual(resumed.scopeViolation, failed.scopeViolation);
  });
}

test("free-text files declarations are ignored when actual scope is valid", async (t) => {
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(
    dir,
    `
    if (process.env.HARNESS_AGENT === "architect") require("node:fs").writeFileSync("valid.txt", "ok");
    console.log(JSON.stringify({ ...${JSON.stringify(passedResult)}, files: ["RENOMBRADO: old -> new"] }));
  `,
  );
  const task = JSON.parse(run(["run", "repo", "free-text files ignored"]).stdout);
  const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command });
  assert.equal(executed.status, 0, executed.stderr);
});

test("new files must be removed by operator before scope retry", async (t) => {
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(
    dir,
    `
    const fs = require("node:fs");
    fs.mkdirSync("apps/api", { recursive: true });
    fs.writeFileSync("apps/api/new.txt", "new");
    console.log(JSON.stringify(${JSON.stringify(passedResult)}));
  `,
  );
  const task = JSON.parse(run(["run", "repo", "new file restoration"]).stdout);
  assert.notEqual(run(["execute", task.id], { HARNESS_AGENT_COMMAND: command }).status, 0);
  await fs.writeFile(path.join(dir, "apps/api/new.txt"), "");
  assert.notEqual(run(["retry", task.id]).status, 0);
  await fs.unlink(path.join(dir, "apps/api/new.txt"));
  assert.equal(run(["retry", task.id]).status, 0);
});

test("parent retry preflights all children before reopening any", async (t) => {
  const { dir, run } = await fixture(t);
  const task = JSON.parse(run(["run", "auto", "modify apps/api and infra docker"]).stdout);
  assert.equal(task.domain, "multi");
  assert.equal(run(["abort", task.id, "fixture setup"]).status, 0);
  const childId = task.children.at(-1);
  const childFile = path.join(dir, ".harness/tasks/failed", childId + ".json");
  const child = JSON.parse(await fs.readFile(childFile, "utf8"));
  child.scopeViolation = {
    agent: "infra",
    attempt: 1,
    reason: "fixture violation",
    protectedState: false,
    restoration: [{ file: "forbidden.txt", fingerprint: null }],
  };
  await fs.writeFile(childFile, JSON.stringify(child));
  await fs.writeFile(path.join(dir, "forbidden.txt"), "still present");
  const retry = run(["retry", task.id]);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /Unresolved scope violation/);
  for (const id of [task.id, ...task.children]) assert.equal(JSON.parse(run(["status", id]).stdout).status, "failed");
  await fs.unlink(path.join(dir, "forbidden.txt"));
  assert.equal(run(["retry", task.id]).status, 0);
  for (const id of [task.id, ...task.children]) assert.equal(JSON.parse(run(["status", id]).stdout).status, "active");
});

for (const failure of ["exit", "invalid-result"]) {
  test("legal changes retain transient retry semantics on " + failure, async (t) => {
    const { dir, run } = await fixture(t);
    const command = await fixtureAgent(
      dir,
      `
      const fs=require("node:fs");
      if(process.env.HARNESS_AGENT === "architect" && !fs.existsSync("legal.txt")) {
        fs.writeFileSync("legal.txt","legal partial work");
        ${failure === "exit" ? "process.exit(7);" : 'console.log("invalid result"); process.exit(0);'}
      }
      console.log(JSON.stringify(${JSON.stringify(passedResult)}));
    `,
    );
    const task = JSON.parse(run(["run", "repo", "transient retry regression"]).stdout);
    const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command, HARNESS_MAX_RETRIES: "1" });
    assert.equal(executed.status, 0, executed.stderr + executed.stdout);
    const completed = JSON.parse(executed.stdout);
    assert.equal(completed.dag.find((n) => n.agent === "architect").attempts, 2);
    assert.equal(completed.scopeViolation, undefined);
    const risks = (await readHandoffs(dir, task.id)).flatMap((h) => h.risks);
    assert.ok(
      risks.some((risk) => (failure === "exit" ? /Host exit 7/ : /Invalid structured agent result/).test(risk)),
    );
  });
}

test("protected operational writes fail regardless of declaration", async (t) => {
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(
    dir,
    `const fs=require("node:fs"); fs.writeFileSync(".harness/state/forbidden.json","{}"); console.log(JSON.stringify(${JSON.stringify(passedResult)}));`,
  );
  const task = JSON.parse(run(["run", "repo", "deleted file detection"]).stdout);
  const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: command });
  assert.notEqual(executed.status, 0);
  const risks = (await readHandoffs(dir, task.id)).flatMap((h) => h.risks);
  assert.ok(risks.some((risk) => /protected operational state/.test(risk)));
});

test("crash mid-agent cannot turn an out-of-scope write into the next baseline", async (t) => {
  const { dir, run } = await fixture(t);
  const safe = await fixtureAgent(dir, `console.log(JSON.stringify(${JSON.stringify(passedResult)}));`);
  const task = await interruptedTask(dir, run);
  await fs.mkdir(path.join(dir, "apps/api"), { recursive: true });
  await fs.writeFile(path.join(dir, "apps/api/forbidden.txt"), "written before the crash");
  const env = { HARNESS_AGENT_COMMAND: safe, HARNESS_MAX_RETRIES: "1" };
  assert.notEqual(run(["execute", task.id], env).status, 0);
  const failed = JSON.parse(run(["status", task.id]).stdout);
  assert.equal(failed.status, "failed");
  assert.match(failed.scopeViolation.reason, /Interrupted attempt/);
  assert.equal(failed.dag[1].attempts, 1, "no new attempt may start over an unresolved violation");
  assert.notEqual(run(["retry", task.id]).status, 0);
  await fs.unlink(path.join(dir, "apps/api/forbidden.txt"));
  const recovered = run(["retry", task.id]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const completed = run(["execute", task.id], env);
  assert.equal(completed.status, 0, completed.stderr + completed.stdout);
});

test("crash mid-agent keeps legal partial work and resumes normally", async (t) => {
  const { dir, run } = await fixture(t);
  const safe = await fixtureAgent(dir, `console.log(JSON.stringify(${JSON.stringify(passedResult)}));`);
  const task = await interruptedTask(dir, run);
  await fs.writeFile(path.join(dir, "legal.txt"), "legal partial work");
  const executed = run(["execute", task.id], { HARNESS_AGENT_COMMAND: safe });
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  assert.equal(JSON.parse(executed.stdout).scopeViolation, undefined);
});

test("gitignored files are covered by the scope check", async (t) => {
  const { dir, run } = await fixture(t);
  const git = gitIn(dir);
  assert.equal(git("init").status, 0);
  await fs.writeFile(path.join(dir, ".gitignore"), ".env\nsecrets\n");
  const command = await fixtureAgent(
    dir,
    `
    const fs=require("node:fs");
    fs.mkdirSync("secrets",{recursive:true});
    fs.writeFileSync("secrets/key.txt","x");
    fs.writeFileSync(".env","x");
    console.log(JSON.stringify(${JSON.stringify(passedResult)}));
  `,
  );
  const task = JSON.parse(run(["run", "repo", "ignored write regression"]).stdout);
  assert.notEqual(run(["execute", task.id], { HARNESS_AGENT_COMMAND: command }).status, 0);
  const failed = JSON.parse(run(["status", task.id]).stdout);
  assert.equal(failed.status, "failed");
  assert.ok(failed.scopeViolation.restoration.some((entry) => entry.file === "secrets/key.txt"));
});

test("unreadable out-of-scope files still latch the violation", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("chmod 000 is not enforceable here");
  const { dir, run } = await fixture(t);
  const command = await fixtureAgent(
    dir,
    `
    const fs=require("node:fs");
    fs.mkdirSync("apps/api", { recursive: true });
    fs.writeFileSync("apps/api/locked.txt", "x");
    fs.chmodSync("apps/api/locked.txt", 0);
    console.log(JSON.stringify(${JSON.stringify(passedResult)}));
  `,
  );
  const task = JSON.parse(run(["run", "repo", "unreadable write regression"]).stdout);
  assert.notEqual(run(["execute", task.id], { HARNESS_AGENT_COMMAND: command }).status, 0);
  const failed = JSON.parse(run(["status", task.id]).stdout);
  assert.ok(failed.scopeViolation, "an unreadable write must not bypass the latch");
});

test("fingerprints of gitignored files are sealed and never stored as a bare hash", async (t) => {
  const { dir, run } = await fixture(t);
  const git = gitIn(dir);
  assert.equal(git("init").status, 0);
  await fs.writeFile(path.join(dir, ".gitignore"), "secrets\n");
  await fs.mkdir(path.join(dir, "secrets"));
  await fs.writeFile(path.join(dir, "secrets/key.txt"), "short-secret");
  const command = await fixtureAgent(
    dir,
    `
    require("node:fs").writeFileSync("secrets/key.txt","tampered");
    console.log(JSON.stringify(${JSON.stringify(passedResult)}));
  `,
  );
  const task = JSON.parse(run(["run", "repo", "sealed fingerprint regression"]).stdout);
  assert.notEqual(run(["execute", task.id], { HARNESS_AGENT_COMMAND: command }).status, 0);
  const failed = JSON.parse(run(["status", task.id]).stdout);
  const entry = failed.scopeViolation.restoration.find((item) => item.file === "secrets/key.txt");
  assert.match(entry.fingerprint, /^hmac:[0-9a-f]{64}$/);
  const audits = await fs.readdir(path.join(dir, ".harness/logs/audit"));
  for (const name of audits) {
    const text = await fs.readFile(path.join(dir, ".harness/logs/audit", name), "utf8");
    assert.doesNotMatch(text, /\d+:[0-9a-f]{64}/, "audit evidence must not carry a bare content hash");
  }
  assert.notEqual(run(["retry", task.id]).status, 0);
  await fs.writeFile(path.join(dir, "secrets/key.txt"), "short-secret");
  assert.equal(run(["retry", task.id]).status, 0);
});
