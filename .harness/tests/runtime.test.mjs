import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  runtimeMetadata,
  resolvePython,
  probePython,
  provisionPython,
  verifyChecksum,
  sha256,
  archiveEntries,
  nativeTar,
  harnessChildEnv,
} from "../lib/python-runtime.mjs";

function tar(entries) {
  const blocks = [];
  for (const { name, type = "0", link = "", body = "x" } of entries) {
    const bytes = Buffer.from(type === "0" ? body : ""),
      header = Buffer.alloc(512);
    header.write(name, 0);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write(type, 156);
    header.write(link, 157);
    header.write("ustar", 257);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("runtime metadata pins Windows, Linux/WSL and macOS artifacts and checksums", () => {
  const metadata = runtimeMetadata();
  assert.equal(metadata.version, "3.13.7");
  for (const platform of ["win32", "linux", "darwin"])
    for (const arch of ["x64", "arm64"]) {
      const artifact = metadata.artifacts[platform + "-" + arch];
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.match(
        artifact.url,
        /^https:\/\/github.com\/astral-sh\/python-build-standalone\/releases\/download\/20250918\//,
      );
      assert.ok(artifact.url.includes("3.13.7"));
    }
});

test("compatible installed Python detected without provisioning; incompatible and malformed candidates rejected", async () => {
  const metadata = runtimeMetadata();
  const run = () => ({ status: 0, stdout: "[3,13,5]" });
  assert.deepEqual(probePython({ cmd: "synthetic" }, metadata, run).version, [3, 13, 5]);
  assert.equal(
    probePython({ cmd: "synthetic" }, metadata, () => ({ status: 0, stdout: "[2,7,0]" })),
    null,
  );
  assert.equal(
    probePython({ cmd: "synthetic" }, metadata, () => ({ status: 0, stdout: "not JSON" })),
    null,
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-installed-"));
  try {
    const result = await resolvePython({
      directory: path.join(directory, "python"),
      candidates: [{ cmd: "synthetic" }],
      run,
    });
    assert.equal(result.managed, false);
    assert.equal(fs.existsSync(path.join(directory, "python")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("no compatible Python provisions locally with checksum before extraction (simulated transport/OS)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-managed-"));
  const bytes = Buffer.from("synthetic pinned archive"),
    calls = [];
  const metadata = {
    version: "3.13.7",
    minimum: [3, 11],
    maximum: [3, 14],
    artifacts: {
      "win32-x64": {
        url: "https://github.com/astral-sh/python-build-standalone/releases/download/fixed/archive",
        sha256: sha256(bytes),
        executable: "python/python.exe",
      },
    },
  };
  try {
    const result = await resolvePython({
      directory: path.join(root, "python"),
      metadata,
      platform: "win32",
      arch: "x64",
      candidates: [],
      download: async () => {
        calls.push("download");
        return bytes;
      },
      extract: async (archive, folder) => {
        calls.push("extract");
        verifyChecksum(fs.readFileSync(archive), sha256(bytes));
        fs.mkdirSync(path.join(folder, "python"));
        fs.writeFileSync(path.join(folder, "python/python.exe"), "synthetic executable");
      },
    });
    assert.equal(result.managed, true);
    assert.deepEqual(calls, ["download", "extract"]);
    assert.equal(fs.existsSync(path.join(root, "python/integrity.json")), true);
    assert.equal(fs.existsSync(path.join(root, "python.lock")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checksum mismatch fails before extractor or executable can run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-checksum-"));
  let extracted = false;
  const metadata = {
    version: "3.13.7",
    artifacts: {
      "linux-x64": { url: "https://github.com/fixed", sha256: "0".repeat(64), executable: "python/bin/python3" },
    },
  };
  try {
    await assert.rejects(
      provisionPython({
        directory: path.join(root, "python"),
        metadata,
        platform: "linux",
        arch: "x64",
        download: async () => Buffer.from("tampered"),
        extract: async () => {
          extracted = true;
        },
      }),
      /checksum mismatch/,
    );
    assert.equal(extracted, false);
    assert.equal(fs.existsSync(path.join(root, "python")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive validation rejects traversal, escaping links and entries beneath links before extraction", () => {
  for (const entries of [
    [{ name: "python/../../outside" }],
    [{ name: "python/link", type: "2", link: "../../outside" }],
    [{ name: "python/link", type: "1", link: "outside" }],
    [{ name: "python/link", type: "2", link: "bin" }, { name: "python/link/file" }],
    [{ name: "python/device", type: "3" }],
    [{ name: "python/a" }, { name: "python/a" }],
  ])
    assert.throws(() => archiveEntries(tar(entries)), /Unsafe|escapes|traverses|Unsupported|Duplicate/);
  const safe = archiveEntries(
    tar([
      { name: "python/bin/python3", type: "2", link: "python3.13" },
      { name: "python/bin/python3.13", body: "binary" },
    ]),
  );
  assert.equal(safe.length, 2);
});

test("unsupported provisioning platform is actionable and never downloads", async () => {
  await assert.rejects(
    provisionPython({
      directory: path.join(os.tmpdir(), "missing-python-" + Date.now()),
      platform: "freebsd",
      arch: "x64",
    }),
    /unsupported/,
  );
});

test("Windows provisioning uses native System32 tar.exe instead of Git Bash GNU tar; other OS keep tar", () => {
  const system32 = path.win32.join("C:\\Windows", "System32", "tar.exe");
  assert.equal(
    nativeTar("win32", { SystemRoot: "C:\\Windows" }, (file) => file === system32),
    system32,
  );
  assert.equal(
    nativeTar("win32", { SystemRoot: "C:\\Windows" }, () => false),
    "tar",
  );
  assert.equal(
    nativeTar("win32", {}, () => true),
    "tar",
  );
  assert.equal(
    nativeTar("linux", { SystemRoot: "C:\\Windows" }, () => true),
    "tar",
  );
});

test("bootstrap propagates the resolved interpreter to Harness children without overriding HARNESS_PYTHON", () => {
  const resolved = { cmd: path.join("runtime", "python", "python.exe") };
  const inherited = harnessChildEnv(resolved, { PATH: "bin" });
  assert.equal(inherited.HARNESS_PYTHON, resolved.cmd);
  assert.equal(inherited.HARNESS_BOOTSTRAPPED, "1");
  assert.equal(inherited.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(inherited.PATH, "bin");
  assert.equal(harnessChildEnv(resolved, { HARNESS_PYTHON: "explicit" }).HARNESS_PYTHON, "explicit");
  assert.equal("HARNESS_PYTHON" in harnessChildEnv({ cmd: "py", args: ["-3"] }, {}), false);
  assert.equal(harnessChildEnv({ ...resolved, source: "managed" }, {}).HARNESS_PYTHON_SOURCE, "managed");
  assert.equal("HARNESS_PYTHON_SOURCE" in harnessChildEnv(resolved, {}), false);
  const source = fs.readFileSync(".harness/bootstrap.mjs", "utf8");
  assert.match(source, /env: harnessChildEnv\(runtime\)/);
});

test("every cli.py launcher (bootstrap, Claude hook, RPC bridge) shares harnessChildEnv and isolation flags", () => {
  const launchers = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!["runtime", "node_modules", "tests", "logs", "state", "handoffs", "tasks"].includes(item.name)) walk(file);
      } else if (item.name.endsWith(".mjs") && /"cli\.py"/.test(fs.readFileSync(file, "utf8"))) {
        launchers.push(path.relative(".harness", file).replaceAll("\\", "/"));
      }
    }
  };
  walk(".harness");
  assert.deepEqual(launchers.sort(), ["bootstrap.mjs", "hooks/guard-orchestrator.mjs", "lib/bridge.mjs"]);
  for (const launcher of launchers) {
    const source = fs.readFileSync(path.join(".harness", launcher), "utf8");
    assert.match(source, /import \{[^}]*\bharnessChildEnv\b[^}]*\} from "[./]+(lib\/)?python-runtime\.mjs"/, launcher);
    assert.match(source, /"-I",\s*"-S",\s*"-B",\s*"-X",\s*"utf8",/, launcher);
    const envs = source.match(/(?<![\w.])env:\s*[^\n]+/g) || [];
    assert.ok(envs.length > 0, launcher + " must pass an env");
    for (const env of envs) assert.match(env, /^env:\s*harnessChildEnv\(runtime[,)]/, launcher + ": " + env);
  }
});

test("resolvePython labels the interpreter origin without exposing its value", async () => {
  const run = () => ({ status: 0, stdout: "[3,13,5]" });
  const directory = path.join(os.tmpdir(), "harness-source-missing-" + Date.now());
  const found = await resolvePython({ directory, candidates: [{ cmd: "synthetic", source: "PATH" }], run });
  assert.equal(found.source, "PATH");
  assert.equal(harnessChildEnv(found, {}).HARNESS_PYTHON_SOURCE, "PATH");
  const source = fs.readFileSync(".harness/lib/python-runtime.mjs", "utf8");
  assert.match(source, /cmd: process\.env\.HARNESS_PYTHON, source: "HARNESS_PYTHON"/);
});

test("doctor through the real launcher reports the resolved origin and never echoes a spoofed source", () => {
  const { HARNESS_PYTHON: _python, ...base } = process.env;
  const spoofed = "SYNTHETIC_SOURCE_SECRET_7731";
  const doctor = spawnSync(process.execPath, [".harness/bootstrap.mjs", "doctor"], {
    env: { ...base, HARNESS_PYTHON_SOURCE: spoofed },
    encoding: "utf8",
  });
  assert.ok(!doctor.stdout.includes(spoofed) && !doctor.stderr.includes(spoofed));
  const python = JSON.parse(doctor.stdout).find((row) => row.component === "Python");
  assert.ok(["managed", "HARNESS_PYTHON", "PATH"].includes(python.source), python.source);
});

test("bootstrap copies without runtime/python hand the resolved interpreter to cli.py and keep explicit HARNESS_PYTHON", async () => {
  const resolved = await resolvePython();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-child-env-"));
  const copy = path.join(directory, ".harness");
  fs.mkdirSync(path.join(copy, "lib"), { recursive: true });
  fs.mkdirSync(path.join(copy, "manifests"));
  for (const file of ["bootstrap.mjs", "lib/python-runtime.mjs", "manifests/python-runtime.json"])
    fs.copyFileSync(path.join(".harness", file), path.join(copy, file));
  fs.writeFileSync(path.join(copy, "cli.py"), "import os\nprint(os.environ.get('HARNESS_PYTHON', ''))\n");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  const run = (env) =>
    spawnSync(process.execPath, [path.join(copy, "bootstrap.mjs")], { cwd: directory, env, encoding: "utf8" });
  try {
    const { HARNESS_PYTHON: _ignored, ...base } = process.env;
    const inherited = run({
      ...base,
      [pathKey]: path.dirname(resolved.cmd) + path.delimiter + (process.env[pathKey] || ""),
    });
    assert.equal(inherited.status, 0, inherited.stderr);
    const propagated = inherited.stdout.trim();
    assert.notEqual(propagated, "");
    assert.ok(probePython({ cmd: propagated }), `propagated interpreter must be usable: ${propagated}`);
    const explicit = run({ ...base, HARNESS_PYTHON: resolved.cmd });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.stdout.trim(), resolved.cmd);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bootstrap isolates Python startup from PYTHONPATH/sitecustomize injection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sitecustomize-"));
  const sentinel = path.join(directory, "sentinel.txt");
  fs.writeFileSync(
    path.join(directory, "sitecustomize.py"),
    `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text('injected')\n`,
  );
  try {
    const run = spawnSync(process.execPath, [".harness/bootstrap.mjs", "context", "repo"], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: directory },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(sentinel), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
