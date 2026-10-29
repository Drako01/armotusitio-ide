import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { root, call, fixture } from "./helpers.mts";

test("context is bounded and domain-specific", () => {
  const r = call(["context", "api", "small validation task"]);
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.equal(c.domain, "api");
  assert.ok(c.estimatedTokens <= c.tokenBudget);
  assert.ok(c.paths.includes("apps/api/**"));
});

test("oversized context never silently removes the end of task restrictions", async (t) => {
  const { run } = await fixture(t);
  // Stay below the Windows command-line limit (32767 chars) so argv is delivered intact.
  const task = "x".repeat(24000) + " Never change permissions or secrets.";
  const result = run(["context", "repo", task]);
  assert.ok(!result.error, String(result.error));
  if (result.status === 0) {
    const context = JSON.parse(result.stdout);
    assert.equal(context.task, task);
    assert.ok(context.exclude.includes(".harness/logs/**"));
  } else assert.match(result.stderr, /budget|presupuesto|context/i);
});

test("large inbox persists one integral source and bounded slice", async (t) => {
  const { dir, run } = await fixture(t);
  const inbox = path.join(dir, ".harness/tasks/inbox/huge.txt");
  const text = "domain: repo\n" + "y".repeat(80000) + " Never change permissions or secrets.";
  await fs.writeFile(inbox, text);
  const result = run(["dispatch"]);
  assert.equal(result.status, 0, result.stderr);
  const task = JSON.parse(result.stdout);
  assert.equal(await fs.readFile(path.join(dir, task.sourceRef.path), "utf8"), text);
  assert.ok(task.task.length < 4000);
  assert.match(task.task, /EXPLICIT PARTIAL VIEW/);
  await assert.rejects(fs.stat(inbox), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.join(dir, ".harness/runtime")), ["context-index.json"]);
});

test("large --file multi shares source, selects domain sections and expands losslessly", async (t) => {
  const { dir, run } = await fixture(t);
  const text =
    "Implementar API y backoffice\n# API\nAgregar endpoint invoices\n" +
    "Backend invoice details\n".repeat(4000) +
    "# Backoffice\nAgregar pantalla invoices\n" +
    "Frontend invoice details\n".repeat(4000) +
    "Never change secrets.\n";
  await fs.writeFile(path.join(dir, "spec (1).txt"), text);
  // This isolated fixture exercises source preservation; readiness receipts have their own preflight suite.
  const result = run(["run", "auto", "--file", "spec (1).txt"], { HARNESS_PREFLIGHT: "off" });
  assert.equal(result.status, 0, result.stderr);
  const parent = JSON.parse(result.stdout);
  const children = parent.children.map((id) => JSON.parse(run(["status", id]).stdout));
  assert.ok(children.some((c) => c.domain === "api"));
  assert.ok(children.some((c) => c.domain === "backoffice"));
  for (const child of children) {
    assert.deepEqual(child.sourceRef, parent.sourceRef);
    assert.ok(JSON.stringify(child).length < 45000);
    if (child.domain === "api") assert.match(child.task, /endpoint invoices/);
    if (child.domain === "backoffice") assert.match(child.task, /pantalla invoices/);
  }
  assert.equal((await fs.readdir(path.join(dir, ".harness/tasks/sources"))).length, 1);
  let expanded = "",
    offset = 0;
  do {
    const page = run(["source", children[0].id, String(offset), "12000"]);
    assert.equal(page.status, 0, page.stderr);
    const value = JSON.parse(page.stdout);
    expanded += value.text;
    offset = value.nextOffset;
    if (value.complete) break;
  } while (offset < text.length);
  assert.equal(expanded, text);
  assert.notEqual(run(["source", parent.id, "0", "12001"]).status, 0);
  await fs.appendFile(path.join(dir, parent.sourceRef.path), "tampered");
  assert.match(run(["source", parent.id]).stderr, /integrity/);
  assert.notEqual(run(["execute", children[0].id]).status, 0);
});

test("frontend API consumers do not acquire backend, docs or infrastructure writes", async (t) => {
  const { run } = await fixture(t);
  const r = run([
    "run",
    "auto",
    "Implementar pantalla backoffice que consume API/OpenAPI/RBAC existentes, docs y CI.\nImplementar una capa de acceso a API consistente.\n# Prohibido\nNo:\n- modificar backend para acomodar frontend.",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(r.stdout);
  assert.equal(task.domain, "backoffice");
  assert.deepEqual(task.contextSlice.paths, ["apps/backoffice/**"]);
});

test("bootstrap uses repo architect and blocks app until bootstrap passes", async (t) => {
  const { run } = await fixture(t);
  const r = run(["run", "auto", "Crear backoffice completo del MVP usando API existente"]);
  assert.equal(r.status, 0, r.stderr);
  const parent = JSON.parse(r.stdout);
  assert.ok(parent.bootstrap);
  const repo = JSON.parse(run(["status", parent.bootstrap]).stdout);
  assert.equal(repo.domain, "repo");
  assert.ok(repo.agents.includes("architect"));
  run(["execute", parent.id]);
  const app = parent.children
    .map((id) => JSON.parse(run(["status", id]).stdout))
    .find((c) => c.domain === "backoffice");
  assert.ok(app.dag.every((n) => n.attempts === 0));
});

test("root star covers root dotfiles but never descendant, traversal or excluded paths", async (t) => {
  const { run } = await fixture(t);
  for (const file of ["package.json", "pnpm-workspace.yaml", ".npmrc"])
    assert.equal(run(["path-check", "repo", "architect", file]).status, 0, file);
  for (const file of [
    "apps/backoffice/page.tsx",
    "apps/api/main.go",
    "../package.json",
    ".harness/logs/a.json",
    "C:/secret",
  ])
    assert.notEqual(run(["path-check", "repo", "architect", file]).status, 0, file);
  assert.notEqual(run(["path-check", "backoffice", "backoffice", "package.json"]).status, 0);
});

test("file ingestion preserves fail-closed budgets and inbox on failure", async (t) => {
  const { dir, run } = await fixture(t);
  const file = path.join(dir, ".harness/manifests/domains.json");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.domains.find((d) => d.domain === "repo").tokenBudget = 100;
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, ".harness/tasks/inbox/spec.txt"), "domain: repo\n" + "detail\n".repeat(10000));
  assert.match(run(["dispatch"]).stderr, /budget/);
  assert.deepEqual(await fs.readdir(path.join(dir, ".harness/tasks/active")), []);
  assert.equal((await fs.readdir(path.join(dir, ".harness/tasks/inbox"))).length, 1);
  assert.notEqual(run(["run", "repo", "--file", "missing.txt"]).status, 0);
});

test("auto routing persists distinct child domains and dispatch consumes its inbox file", async (t) => {
  const { dir, run } = await fixture(t);
  const created = run(["run", "auto", "api backoffice coordinated fixture"]);
  assert.equal(created.status, 0, created.stderr);
  const parent = JSON.parse(created.stdout);
  assert.equal(parent.domain, "multi");
  assert.equal(parent.children.length, 2);
  const domains = parent.children.map((id) => JSON.parse(run(["status", id]).stdout).domain).sort();
  assert.deepEqual(domains, ["api", "backoffice"]);
  const inbox = path.join(dir, ".harness", "tasks", "inbox", "bounded.txt");
  await fs.writeFile(inbox, "domain: repo\nFixture dispatch only");
  const dispatched = run(["dispatch"]);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.equal(JSON.parse(dispatched.stdout).source, "inbox:bounded.txt");
  await assert.rejects(fs.stat(inbox), { code: "ENOENT" });
});

test("disabled domains are declared but not routable", async (t) => {
  const { run } = await fixture(t);
  const refused = run(["run", "n8n", "build a workflow"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /deshabilitado/);
  const auto = JSON.parse(run(["run", "auto", "implementar workflow n8n nuevo"]).stdout);
  assert.notEqual(auto.domain, "n8n");
});

test("api and infra always include security auditor, including Spanish sensitive wording", async (t) => {
  const { run } = await fixture(t);
  for (const [domain, text] of [
    ["api", "ajustar permisos y aislamiento de organizaciones"],
    ["infra", "actualizar docker de despliegue"],
  ]) {
    const task = JSON.parse(run(["run", domain, text]).stdout);
    assert.ok(task.agents.includes("security-auditor"), domain);
  }
});

test("placeholder applications fail closed instead of silently routing to repo", async (t) => {
  const { run } = await fixture(t);
  for (const app of ["marketplace", "planner-portal"]) {
    const explicit = run(["run", app, "implementar pantalla"]);
    assert.notEqual(explicit.status, 0, app);
    const automatic = run(["run", "auto", "implementar " + app]);
    assert.notEqual(automatic.status, 0, app + " auto");
  }
});

test("workers is enabled with its own real gates", async (t) => {
  const { run } = await fixture(t);
  const task = JSON.parse(run(["run", "workers", "implementar worker"]).stdout);
  assert.equal(task.domain, "workers");
  assert.deepEqual(task.contextSlice.paths, [
    "apps/api/cmd/worker/**",
    "apps/api/internal/platform/jobs/**",
    "apps/api/internal/platform/config/worker*.go",
  ]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".harness/manifests/domains.json"), "utf8"));
  const entry = manifest.domains.find((d) => d.domain === "workers");
  assert.notEqual(entry.enabled, false);
  assert.equal(entry.disabledReason, undefined);
  const gates = entry.verification.map((c) => c.join(" "));
  for (const gate of [
    "go -C apps/api test ./internal/platform/jobs/... ./internal/platform/config/...",
    "go -C apps/api vet ./cmd/worker/... ./internal/platform/jobs/... ./internal/platform/config/...",
    "go -C apps/api build ./cmd/...",
  ]) {
    assert.ok(gates.includes(gate), gate);
  }
});

test("provider-portal is enabled with its own real gates", async (t) => {
  const { run } = await fixture(t);
  const task = JSON.parse(run(["run", "provider-portal", "implementar pantalla"]).stdout);
  assert.equal(task.domain, "provider-portal");
  assert.deepEqual(task.contextSlice.paths, ["apps/provider-portal/**"]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".harness/manifests/domains.json"), "utf8"));
  const entry = manifest.domains.find((d) => d.domain === "provider-portal");
  assert.notEqual(entry.enabled, false);
  assert.equal(entry.disabledReason, undefined);
  const gates = entry.verification.map((c) => c.join(" "));
  for (const gate of ["typecheck", "lint", "test:critical", "build"]) {
    assert.ok(gates.includes(`pnpm --dir apps/provider-portal ${gate}`), gate);
  }
});

test("sales-portal is enabled with its own real gates", async (t) => {
  const { run } = await fixture(t);
  const task = JSON.parse(run(["run", "sales-portal", "implementar pantalla"]).stdout);
  assert.equal(task.domain, "sales-portal");
  assert.deepEqual(task.contextSlice.paths, ["apps/sales-portal/**"]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".harness/manifests/domains.json"), "utf8"));
  const entry = manifest.domains.find((d) => d.domain === "sales-portal");
  assert.notEqual(entry.enabled, false);
  assert.equal(entry.disabledReason, undefined);
  const gates = entry.verification.map((c) => c.join(" "));
  for (const gate of ["typecheck", "lint", "test:critical", "build"]) {
    assert.ok(gates.includes(`pnpm --dir apps/sales-portal ${gate}`), gate);
  }
  assert.ok(gates.includes("pnpm format:check"));
});

test("backoffice agent may write provider-portal and sales-portal but no other application", async (t) => {
  const { run } = await fixture(t);
  assert.equal(run(["path-check", "provider-portal", "backoffice", "apps/provider-portal/src/x.ts"]).status, 0);
  assert.equal(run(["path-check", "sales-portal", "backoffice", "apps/sales-portal/src/x.ts"]).status, 0);
  assert.equal(run(["path-check", "backoffice", "backoffice", "apps/backoffice/src/x.ts"]).status, 0);
  for (const file of ["apps/marketplace/x.ts", "apps/api/x.go"]) {
    for (const domain of ["provider-portal", "sales-portal", "backoffice"]) {
      assert.notEqual(run(["path-check", domain, "backoffice", file]).status, 0, `${domain} ${file}`);
    }
  }
  const agents = JSON.parse(await fs.readFile(path.join(root, ".harness/manifests/agents.json"), "utf8"));
  const contract = agents.agents.find((a) => a.name === "backoffice");
  assert.deepEqual(contract.allowedPaths, ["apps/backoffice/**", "apps/provider-portal/**", "apps/sales-portal/**"]);
  assert.deepEqual(contract.forbiddenPaths, []);
  const domains = JSON.parse(await fs.readFile(path.join(root, ".harness/manifests/domains.json"), "utf8"));
  for (const [name, file] of [
    ["provider-portal", "apps/provider-portal/src/x.ts"],
    ["sales-portal", "apps/sales-portal/src/x.ts"],
  ]) {
    const entry = domains.domains.find((d) => d.domain === name);
    assert.ok(
      entry.exclude.every((e) => !file.startsWith(e.replace("**", ""))),
      name,
    );
  }
});

test("every executable monorepo app is wired into start.sh", async () => {
  const appsDir = path.join(root, "apps");
  const entries = await fs.readdir(appsDir, { withFileTypes: true });
  const start = await fs.readFile(path.join(root, "start.sh"), "utf8");
  const executableApps = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packagePath = path.join(appsDir, entry.name, "package.json");
    let packageJson;
    try {
      packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (packageJson.scripts?.dev) executableApps.push(entry.name);
  }

  assert.ok(executableApps.length > 0, "expected at least one executable app under apps/*");
  for (const app of executableApps) {
    const windowsPath = `apps\\\\${app}`;
    const posixPath = `apps/${app}`;
    assert.ok(
      start.includes(windowsPath) || start.includes(posixPath),
      `${app}: package.json defines scripts.dev but start.sh does not wire its local startup`,
    );
  }
});

test("infra scope includes the root enterprise docker verifier", async (t) => {
  const { run } = await fixture(t);
  assert.equal(run(["path-check", "infra", "infra", "docker-verify-enterprise.sh"]).status, 0);
});
