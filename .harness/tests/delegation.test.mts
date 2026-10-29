import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { root } from "./helpers.mts";
import { manifests, getDomain, context } from "../lib/context.mts";
import { delegationContext, delegationPrompt, compactHandoff } from "../lib/delegation.mts";
import { tokenize } from "../lib/util.mts";

const contractFor = async (name) => (await manifests()).agents.find((agent) => agent.name === name);
const handoffFile = (taskId, agent, attempt) =>
  path.join(root, ".harness", "handoffs", taskId + "-" + agent + "-" + attempt + ".json");

function fullHandoff(taskId, agent, attempt, status, size) {
  return {
    schemaVersion: 1,
    taskId,
    domain: "api",
    agent,
    status,
    attempt,
    changes: Array.from({ length: size }, (_, i) => "change " + i + " " + "c".repeat(120)),
    files: Array.from({ length: 8 }, (_, i) => "apps/api/internal/modules/sales/services/file_" + i + ".go"),
    decisions: Array.from({ length: size }, (_, i) => "decision " + i + " " + "d".repeat(160)),
    risks: status === "failed" ? ["FINDING-" + attempt + " tenant filter missing in repository"] : [],
    verification: Array.from({ length: size }, (_, i) => "go test ./... evidence " + i + " " + "v".repeat(200)),
    nextAction: null,
    at: "2026-09-29T22:53:01.000Z",
  };
}

test("delegated skills travel by reference without content", async () => {
  const task = { id: "t-skills", domain: "api", task: "implement endpoint" };
  const ctx = await delegationContext(task, await contractFor("backend"), "backend");
  assert.ok(ctx.skills.length > 0);
  for (const skill of ctx.skills) {
    assert.deepEqual(Object.keys(skill).sort(), ["description", "name", "path"]);
    assert.match(skill.path, /SKILL\.md$/);
    await fs.access(path.join(root, skill.path));
  }
});

test("implementers get role plus domain skills; reviewers, auditors and verifier only their role skills", async () => {
  const task = { id: "t-roles", domain: "api", task: "role skills" };
  const domainSkills = (await getDomain("api")).skills;
  const names = async (agent) =>
    (await delegationContext(task, await contractFor(agent), agent)).skills.map((skill) => skill.name).sort();
  for (const agent of ["reviewer", "security-auditor", "verifier"])
    assert.deepEqual(await names(agent), [...(await contractFor(agent)).skills].sort(), agent);
  const backend = await names("backend");
  for (const skill of [...(await contractFor("backend")).skills, ...domainSkills]) assert.ok(backend.includes(skill));
  assert.equal(new Set(backend).size, backend.length, "skills are not duplicated");
  const architect = (await delegationContext({ ...task, domain: "repo" }, await contractFor("architect"), "architect"))
    .skills;
  assert.deepEqual(
    architect.map((skill) => skill.name),
    (await getDomain("repo")).skills,
  );
});

test("dependency handoffs are compacted to a summary with the full handoff path", () => {
  const record = fullHandoff("t-compact", "backend", 3, "failed", 4);
  const compact = compactHandoff(record, handoffFile("t-compact", "backend", 3));
  assert.deepEqual(compact, {
    agent: "backend",
    attempt: 3,
    status: "failed",
    files: record.files,
    risks: record.risks,
    nextAction: null,
    path: ".harness/handoffs/t-compact-backend-3.json",
  });
  for (const key of ["changes", "decisions", "verification"]) assert.ok(!(key in compact), key);
});

test("the task text is sent once and never duplicated inside context", async () => {
  const marker = "UNIQUE-TASK-MARKER-" + "q".repeat(40);
  const task = { id: "t-once", domain: "repo", task: marker };
  const contract = await contractFor("architect");
  const ctx = await delegationContext(task, contract, "architect");
  const input = JSON.parse(delegationPrompt(task, { agent: "architect" }, contract, ctx, []));
  assert.equal(input.task, marker);
  assert.ok(!("task" in input.context));
  assert.equal(JSON.stringify(input).split(marker).length - 1, 1);
  assert.match(input.rule, /read each SKILL\.md from its path/);
});

test("reviewer with several retried handoffs stays within its 6000 budget and still fails closed", async () => {
  // Reproduces task 20260929225301-709655: api domain, ~2250-char task, reviewer after three backend/tester retries.
  const taskId = "20260929225301-709655";
  const task = { id: taskId, domain: "api", task: "Domain: api. " + "r".repeat(2236) };
  const contract = await contractFor("reviewer");
  assert.equal(contract.tokenBudget, 6000);
  const ctx = await delegationContext(task, contract, "reviewer");
  const records = [
    fullHandoff(taskId, "backend", 3, "passed", 8),
    fullHandoff(taskId, "tester", 3, "passed", 6),
    fullHandoff(taskId, "reviewer", 2, "failed", 2),
  ];
  const handoffs = records.map((record) => compactHandoff(record, handoffFile(taskId, record.agent, record.attempt)));
  const prompt = delegationPrompt(task, { agent: "reviewer" }, contract, ctx, handoffs);
  assert.ok(tokenize(prompt) <= 6000, "compact prompt uses " + tokenize(prompt) + " tokens");

  // The previous shape (full skill content, duplicated task, full handoffs) exceeded the same budget.
  const skills = [];
  for (const name of (await getDomain("api")).skills)
    skills.push({ name, content: await fs.readFile(path.join(root, ".codex/skills", name, "SKILL.md"), "utf8") });
  const legacy = JSON.stringify({ task: task.task, contract, context: { ...ctx, skills, task: task.task }, records });
  assert.ok(tokenize(legacy) > 6000, "legacy prompt uses " + tokenize(legacy) + " tokens");

  const oversized = [{ ...handoffs[0], risks: ["x".repeat(30000)] }];
  assert.throws(
    () => delegationPrompt(task, { agent: "reviewer" }, contract, ctx, oversized),
    /Delegated prompt budget excedido/,
  );
});

test("domain context lists skills by reference for the CLI context command", async () => {
  const ctx = await context("api", "context slice");
  assert.ok(ctx.skills.length > 0);
  for (const skill of ctx.skills) assert.ok(!("content" in skill), skill.name);
});

test("temporary agents count as implementers and missing role skills fail closed", async () => {
  const task = { id: "t-temp", domain: "api", task: "temporary agent" };
  const temporary = { name: "temp-migrator", role: "implementer", skills: ["database-migrations"] };
  const names = (await delegationContext(task, temporary, "temp-migrator")).skills.map((skill) => skill.name);
  assert.equal(names[0], "database-migrations", "role skills come first");
  for (const skill of (await getDomain("api")).skills) assert.ok(names.includes(skill), skill);
  await assert.rejects(
    delegationContext(task, { ...temporary, skills: ["missing-fixture-skill"] }, "temp-migrator"),
    /Skill faltante: missing-fixture-skill/,
  );
});

test("compact handoffs default missing summary fields", () => {
  const compact = compactHandoff({ agent: "tester", attempt: 1, status: "blocked" }, handoffFile("t-min", "tester", 1));
  assert.deepEqual(compact, {
    agent: "tester",
    attempt: 1,
    status: "blocked",
    files: [],
    risks: [],
    nextAction: null,
    path: ".harness/handoffs/t-min-tester-1.json",
  });
});

test("serialized reviewer prompt carries no skill bodies nor full handoff sections", async () => {
  const taskId = "t-serialized";
  const task = { id: taskId, domain: "api", task: "review sales change" };
  const contract = await contractFor("reviewer");
  const ctx = await delegationContext(task, contract, "reviewer");
  const record = fullHandoff(taskId, "backend", 2, "passed", 3);
  const prompt = delegationPrompt(task, { agent: "reviewer" }, contract, ctx, [
    compactHandoff(record, handoffFile(taskId, "backend", 2)),
  ]);
  const input = JSON.parse(prompt);
  for (const skill of input.context.skills) {
    const body = await fs.readFile(path.join(root, skill.path), "utf8");
    const heading = body.split("\n").find((line) => line.startsWith("# "));
    assert.ok(heading && !prompt.includes(heading), skill.name + " body leaked into the prompt");
  }
  for (const entry of input.handoffs) {
    for (const key of ["changes", "decisions", "verification"]) assert.ok(!(key in entry), key);
    assert.match(entry.path, /^\.harness\/handoffs\/.+\.json$/);
  }
  for (const text of [...record.changes, ...record.decisions, ...record.verification])
    assert.ok(!prompt.includes(text));
  assert.match(input.rule, /read the full record from handoff\.path/);
  assert.match(input.rule, /`files` must be \[\]/);
  assert.match(input.rule, /Never run formatters or linters with --write over the whole repository/);
  assert.match(input.rule, /git checkout -- <file>/);
});

test("prompt budget is the smaller of context and contract budgets", async () => {
  const task = { id: "t-min-budget", domain: "repo", task: "budget check" };
  const contract = await contractFor("architect");
  const ctx = await delegationContext(task, contract, "architect");
  assert.doesNotThrow(() => delegationPrompt(task, { agent: "architect" }, contract, ctx, []));
  assert.throws(
    () => delegationPrompt(task, { agent: "architect" }, contract, { ...ctx, tokenBudget: 50 }, []),
    /Delegated prompt budget excedido/,
  );
  assert.throws(
    () => delegationPrompt(task, { agent: "architect" }, { ...contract, tokenBudget: 50 }, ctx, []),
    /Delegated prompt budget excedido/,
  );
});
