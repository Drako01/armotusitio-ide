// Transitional public API: Python owns all logical behavior.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { harnessChildEnv, resolvePython } from "./python-runtime.mjs";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await resolvePython();
export function rpc(method, args = []) {
  const result = spawnSync(
    runtime.cmd,
    [...(runtime.args || []), "-I", "-S", "-B", "-X", "utf8", path.join(directory, "cli.py"), "rpc"],
    {
      cwd: process.cwd(),
      input: JSON.stringify({ method, args }),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 86400000,
      env: harnessChildEnv(runtime),
    },
  );
  if (result.status !== 0) throw Error(result.stderr?.trim() || "Harness Python bridge failed");
  return JSON.parse(result.stdout);
}
