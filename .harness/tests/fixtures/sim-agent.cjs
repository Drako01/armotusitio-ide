// Simulated host for concurrency tests and benchmarks: no tokens, no network, fully deterministic.
// Behaviour comes from the JSON file named by SIM_SPEC, keyed by node id, then role, then "*".
//   ms          milliseconds the "agent" works (default 200)
//   write       [{ path, content }] files to create inside the current checkout; default: <owns[0]>/out.txt
//   failTimes   report status "failed" for the first N attempts of this node
//   exit        exit with this code instead of reporting a result
//   hang        never finish (timeouts, cancellation)
//   grandchild  spawn a detached descendant that keeps running and records its pid in SIM_STATE
//   undeclared  write this extra file without declaring it in `files`
//   escape      write this absolute path (outside the checkout the agent was given)
//   commit      run `git commit` inside the checkout the agent was given (delivery operations are never delegated)
//   findings    report failed with these risks (reviewer gates)
// Every start/end is appended to SIM_LOG so tests can prove overlap from outside the Harness.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const id = input.node?.id ?? input.role;
const spec = process.env.SIM_SPEC ? JSON.parse(fs.readFileSync(process.env.SIM_SPEC, "utf8")) : {};
const mine = { ...(spec["*"] ?? {}), ...(spec[input.role] ?? {}), ...(spec[id] ?? {}) };
const stamp = (event) =>
  process.env.SIM_LOG &&
  fs.appendFileSync(
    process.env.SIM_LOG,
    JSON.stringify({ event, node: id, role: input.role, at: Date.now(), pid: process.pid, cwd: process.cwd() }) + "\n",
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  stamp("start");
  let attempt = 1;
  if (process.env.SIM_STATE) {
    fs.mkdirSync(process.env.SIM_STATE, { recursive: true });
    const counter = path.join(process.env.SIM_STATE, id + ".attempts");
    attempt = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
    fs.writeFileSync(counter, String(attempt));
  }
  if (mine.grandchild && process.env.SIM_STATE) {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    child.unref();
    fs.writeFileSync(path.join(process.env.SIM_STATE, id + ".grandchild"), String(child.pid));
  }
  if (mine.hang) await sleep(600000);
  await sleep(mine.ms ?? 200);
  if (mine.exit) {
    stamp("end");
    process.exit(mine.exit);
  }
  const files = [];
  const writes =
    mine.write ??
    (input.node?.owns
      ? [{ path: input.node.owns[0].replace(/\/?\*\*$/, "") + "/out.txt", content: "work by " + id + "\n" }]
      : []);
  for (const write of writes) {
    fs.mkdirSync(path.dirname(write.path), { recursive: true });
    fs.writeFileSync(write.path, write.content ?? "work by " + id + "\n");
    files.push(write.path);
  }
  if (mine.undeclared) {
    fs.mkdirSync(path.dirname(mine.undeclared), { recursive: true });
    fs.writeFileSync(mine.undeclared, "undeclared\n");
  }
  if (mine.escape) {
    fs.mkdirSync(path.dirname(mine.escape), { recursive: true });
    fs.writeFileSync(mine.escape, "escaped\n");
  }
  if (mine.commit)
    execFileSync("git", [
      "-c",
      "user.name=x",
      "-c",
      "user.email=x@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "delegated commit",
    ]);
  stamp("end");
  const failed = attempt <= (mine.failTimes ?? (mine.findings ? 99 : 0));
  const result = {
    status: failed ? "failed" : "passed",
    changes: files.map((f) => "wrote " + f),
    files,
    decisions: [],
    risks: failed ? (mine.findings ?? ["simulated failure on attempt " + attempt]) : [],
    verification: ["simulated host, attempt " + attempt],
    nextAction: null,
  };
  fs.writeFileSync(process.env.HARNESS_RESULT_FILE, JSON.stringify(result));
})();
