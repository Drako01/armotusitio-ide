import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

test("bootstrap loads local env before importing Harness core", async () => {
  const source = await readFile(new URL("../bootstrap.mts", import.meta.url), "utf8");
  assert.ok(source.indexOf("loadEnvFile(envFile)") < source.indexOf("await resolvePython()"));
});

test("shell environment takes precedence over env file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "redevent-harness-env-"));
  const envFile = path.join(dir, ".env");
  await writeFile(envFile, "HARNESS_HOST=claude\n", "utf8");

  try {
    const script =
      'import { loadEnvFile } from "node:process"; loadEnvFile(process.argv[1]); process.stdout.write(process.env.HARNESS_HOST);';
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, envFile], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_HOST: "codex" },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "codex");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
