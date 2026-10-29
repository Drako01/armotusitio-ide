#!/usr/bin/env node
// Native hook transport; Python owns fail-closed guard logic.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { harnessChildEnv, resolvePython } from "../lib/python-runtime.mts";
const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 65536) process.exit(2);
  chunks.push(chunk);
}
try {
  const runtime = await resolvePython();
  const run = spawnSync(
    runtime.cmd,
    [...(runtime.args || []), "-I", "-S", "-B", "-X", "utf8", path.join(harness, "cli.py"), "guard"],
    {
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      input: Buffer.concat(chunks),
      encoding: "utf8",
      env: harnessChildEnv(runtime, { ...process.env, HARNESS_HOOK_INPUT: "1" }),
      timeout: 10000,
      windowsHide: true,
    },
  );
  if (run.stderr) process.stderr.write(run.stderr.slice(-1000));
  process.exit(run.status === 0 ? 0 : 2);
} catch {
  process.exit(2);
}
