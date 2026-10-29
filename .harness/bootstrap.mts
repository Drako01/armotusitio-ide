#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { harnessChildEnv, resolvePython } from "./lib/python-runtime.mts";

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(harnessDir, ".env");

// `test` and HARNESS_IGNORE_ENV_FILE=1 never inherit the operator's .env: its timeouts and host would contaminate the suite.
const ignoreEnvFile = process.env.HARNESS_IGNORE_ENV_FILE === "1" || process.argv[2] === "test";

try {
  if (!ignoreEnvFile) loadEnvFile(envFile);
} catch (error) {
  if (error?.code !== "ENOENT") {
    console.error("[harness] No se pudo cargar .harness/.env:", error.message);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  try {
    const runtime = await resolvePython();
    const child = spawn(
      runtime.cmd,
      [
        ...(runtime.args || []),
        "-I",
        "-S",
        "-B",
        "-X",
        "utf8",
        path.join(harnessDir, "cli.py"),
        ...process.argv.slice(2),
      ],
      {
        stdio: "inherit",
        shell: false,
        windowsHide: true,
        env: harnessChildEnv(runtime),
      },
    );
    child.on("error", () => {
      console.error("[harness] Python runtime could not start");
      process.exitCode = 1;
    });
    process.exitCode = await new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  } catch (error) {
    console.error("[harness]", error.message);
    process.exitCode = 1;
  }
}
