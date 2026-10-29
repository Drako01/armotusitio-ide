import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeMetadata = () =>
  JSON.parse(fs.readFileSync(path.join(harness, "manifests/python-runtime.json"), "utf8").replace(/^\uFEFF/, ""));
export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
export function verifyChecksum(bytes, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(bytes) !== expected)
    throw Error("Python runtime checksum mismatch; no extraction or execution permitted");
}
export function probePython(candidate, metadata = runtimeMetadata(), run = spawnSync) {
  if (process.platform === "win32" && run === spawnSync) {
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";
    const names = path.isAbsolute(candidate.cmd)
      ? [candidate.cmd]
      : (process.env[pathKey] || "")
          .split(path.delimiter)
          .flatMap((dir) => [".exe", ""].map((ext) => path.join(dir, candidate.cmd + ext)));
    const executable = names.find(
      (file) =>
        fs.existsSync(file) && fs.statSync(file).isFile() && !file.toLowerCase().includes("\\microsoft\\windowsapps\\"),
    );
    if (!executable) return null;
    candidate = { ...candidate, cmd: executable };
  }
  const result = run(
    candidate.cmd,
    [
      ...(candidate.args || []),
      "-I",
      "-S",
      "-B",
      "-c",
      "import sys,json; print(json.dumps(list(sys.version_info[:3])))",
    ],
    { encoding: "utf8", timeout: 5000, windowsHide: true },
  );
  if (result.status !== 0) return null;
  try {
    const version = JSON.parse(result.stdout.trim());
    if (version.length !== 3 || version.some((v) => !Number.isInteger(v))) return null;
    const minor = version[0] * 100 + version[1];
    if (
      minor < metadata.minimum[0] * 100 + metadata.minimum[1] ||
      minor > metadata.maximum[0] * 100 + metadata.maximum[1]
    )
      return null;
    return { ...candidate, version, managed: false };
  } catch {
    return null;
  }
}
// Git Bash puts GNU tar first on PATH; it reads "C:\..." as a remote host, so Windows uses its native bsdtar.
export function nativeTar(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (platform !== "win32") return "tar";
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR;
  const executable = root && path.win32.join(root, "System32", "tar.exe");
  return executable && exists(executable) ? executable : "tar";
}
// Every cli.py launcher (bootstrap, Claude hook, RPC bridge) builds its env here so Codex and Claude resolve alike.
// Child Harness processes (tests, fixtures, temporary copies) reuse the resolved interpreter instead of reprovisioning.
// HARNESS_PYTHON_SOURCE names only the origin (managed, HARNESS_PYTHON, PATH) for doctor/check, never a value.
export function harnessChildEnv(runtime, env = process.env) {
  const child = { ...env, HARNESS_BOOTSTRAPPED: "1", PYTHONDONTWRITEBYTECODE: "1" };
  if (runtime.source) child.HARNESS_PYTHON_SOURCE = runtime.source;
  if (!env.HARNESS_PYTHON && !runtime.args?.length) child.HARNESS_PYTHON = runtime.cmd;
  return child;
}
export function archiveEntries(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const entries = [],
    links = new Set();
  let pendingName = null,
    attributes = {};
  const field = (buffer) => buffer.toString("utf8").replace(/\0.*$/s, "");
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = field(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw Error("Unsupported Python tar size");
    const size = parseInt(sizeText, 8),
      type = field(header.subarray(156, 157)) || "0";
    if (offset + 512 + size > tar.length) throw Error("Truncated Python tar");
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const prefix = field(header.subarray(345, 500));
    let name = pendingName || attributes.path || (prefix ? prefix + "/" : "") + field(header.subarray(0, 100));
    let link = attributes.linkpath || field(header.subarray(157, 257));
    if (type === "L") {
      pendingName = field(body);
    } else if (type === "x") {
      attributes = {};
      for (const line of body.toString("utf8").split("\n")) {
        const match = line.match(/^\d+ (path|linkpath)=(.*)$/);
        if (match) attributes[match[1]] = match[2];
      }
    } else {
      pendingName = null;
      attributes = {};
      name = name.replace(/\/$/, "");
      if (
        (!name.startsWith("python/") && name !== "python") ||
        name.startsWith("/") ||
        name.includes("\\") ||
        name.includes(":") ||
        name.split("/").some((p) => p === ".." || p === "." || !p)
      )
        throw Error("Unsafe Python archive path");
      if (!["0", "1", "2", "5"].includes(type)) throw Error("Unsupported Python archive entry type");
      if (type === "1" || type === "2") {
        if (link.startsWith("/") || link.includes("\\") || link.includes(":"))
          throw Error("Unsafe Python archive link");
        const resolved = path.posix.normalize(type === "2" ? path.posix.join(path.posix.dirname(name), link) : link);
        if (!resolved.startsWith("python/")) throw Error("Python archive link escapes runtime");
        links.add(name);
      }
      if (entries.some((e) => e.name === name)) throw Error("Duplicate Python archive entry");
      entries.push({ name, type, link, hash: sha256(body) });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const entry of entries) {
    const parts = entry.name.split("/");
    parts.pop();
    while (parts.length) {
      if (links.has(parts.join("/"))) throw Error("Python archive entry traverses link");
      parts.pop();
    }
  }
  return entries;
}
function treeIntegrity(directory) {
  const entries = {};
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, item.name),
        relative = path.relative(directory, absolute).replaceAll("\\", "/");
      if (["integrity.json", "verified-source.tar.gz"].includes(relative)) continue;
      if (item.isSymbolicLink()) {
        const resolved = fs.realpathSync(absolute);
        if (!resolved.startsWith(directory + path.sep)) throw Error("Managed Python symlink escapes runtime");
        entries[relative] = "link:" + fs.readlinkSync(absolute);
      } else if (item.isDirectory()) walk(absolute);
      else entries[relative] = sha256(fs.readFileSync(absolute));
    }
  }
  walk(directory);
  return entries;
}
function managedRuntime(directory, artifact, metadata) {
  if (!fs.existsSync(directory)) return null;
  if (fs.lstatSync(directory).isSymbolicLink()) throw Error("Managed Python root symlink rejected");
  const record = JSON.parse(fs.readFileSync(path.join(directory, "integrity.json"), "utf8"));
  const source = fs.readFileSync(path.join(directory, "verified-source.tar.gz"));
  verifyChecksum(source, artifact.sha256);
  const expected = {};
  for (const entry of archiveEntries(source)) {
    if (entry.type === "0") expected[entry.name] = entry.hash;
    else if (entry.type === "2") expected[entry.name] = "link:" + entry.link;
    else if (entry.type === "1") expected[entry.name] = archiveEntries(source).find((e) => e.name === entry.link)?.hash;
  }
  const canonical = (value) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (
    record.sha256 !== artifact.sha256 ||
    record.version !== metadata.version ||
    canonical(expected) !== canonical(treeIntegrity(directory))
  )
    throw Error("Managed Python integrity failure; remove only .harness/runtime/python and retry provisioning");
  const result = probePython({ cmd: path.join(directory, artifact.executable) }, metadata);
  if (!result || result.version.join(".") !== metadata.version) throw Error("Managed Python version mismatch");
  return { ...result, managed: true, source: "managed", integrity: artifact.sha256 };
}
async function downloadArtifact(url) {
  const allowed = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !allowed.has(parsed.hostname) || parsed.username || parsed.password)
      throw Error("Untrusted Python runtime URL");
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get("location"), url).href;
      continue;
    }
    if (!response.ok) throw Error("Python runtime download failed HTTP " + response.status);
    const chunks = [];
    let size = 0;
    for await (const block of response.body) {
      size += block.length;
      if (size > 100 * 1024 * 1024) throw Error("Python runtime download exceeds 100 MiB");
      chunks.push(block);
    }
    return Buffer.concat(chunks);
  }
  throw Error("Python download redirect limit exceeded");
}
export async function provisionPython({
  directory = path.join(harness, "runtime/python"),
  metadata = runtimeMetadata(),
  platform = process.platform,
  arch = process.arch,
  download = downloadArtifact,
  extract = null,
} = {}) {
  const artifact = metadata.artifacts[platform + "-" + arch];
  if (!artifact)
    throw Error(
      `Managed Python unsupported on ${platform}/${arch}; use a supported Windows, Linux glibc/WSL or macOS machine`,
    );
  const existing = managedRuntime(directory, artifact, metadata);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  let parent = path.resolve(path.dirname(directory));
  while (parent !== path.dirname(parent)) {
    if (fs.lstatSync(parent).isSymbolicLink()) throw Error("Python runtime ancestor symlink rejected");
    parent = path.dirname(parent);
  }
  const lock = directory + ".lock";
  let handle;
  try {
    handle = fs.openSync(lock, "wx");
  } catch {
    throw Error(
      "Python provisioning already active; inspect/remove stale .harness/runtime/python.lock only when no provisioning process runs",
    );
  }
  const temporary = directory + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  try {
    fs.mkdirSync(temporary);
    const bytes = await download(artifact.url);
    verifyChecksum(bytes, artifact.sha256);
    if (!extract) archiveEntries(bytes); // Validate types and every link BEFORE tar writes anything.
    const archive = path.join(temporary, "runtime.tar.gz");
    fs.writeFileSync(archive, bytes);
    if (extract) await extract(archive, temporary);
    else {
      const tar = nativeTar();
      const listing = spawnSync(tar, ["-tzf", archive], {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (
        listing.status !== 0 ||
        listing.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .some(
            (file) =>
              file.startsWith("/") ||
              file.includes("\\") ||
              file.includes(":") ||
              file.split("/").includes("..") ||
              !file.startsWith("python/"),
          )
      )
        throw Error("Unsafe/unsupported Python archive; ensure native tar is installed on the compatible OS");
      const result = spawnSync(tar, ["-xzf", archive, "-C", temporary], {
        encoding: "utf8",
        timeout: 120000,
        windowsHide: true,
      });
      if (result.status !== 0)
        throw Error("Python extraction failed; native tar is required (Windows includes tar.exe)");
    }
    if (extract) fs.unlinkSync(archive);
    else fs.renameSync(archive, path.join(temporary, "verified-source.tar.gz"));
    const files = treeIntegrity(temporary);
    fs.writeFileSync(
      path.join(temporary, "integrity.json"),
      JSON.stringify({ version: metadata.version, sha256: artifact.sha256, files }),
    );
    // Integrity and version are verified before publishing the executable.
    if (!extract) managedRuntime(temporary, artifact, metadata);
    fs.renameSync(temporary, directory);
    return extract
      ? { cmd: path.join(directory, artifact.executable), managed: true, source: "managed", integrity: artifact.sha256 }
      : managedRuntime(directory, artifact, metadata);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}
export async function resolvePython(options = {}) {
  const metadata = options.metadata || runtimeMetadata();
  const directory = options.directory || path.join(harness, "runtime/python");
  const artifact = metadata.artifacts[(options.platform || process.platform) + "-" + (options.arch || process.arch)];
  if (artifact && fs.existsSync(directory)) return managedRuntime(directory, artifact, metadata);
  const candidates = options.candidates || [
    ...(process.env.HARNESS_PYTHON ? [{ cmd: process.env.HARNESS_PYTHON, source: "HARNESS_PYTHON" }] : []),
    { cmd: "python3", source: "PATH" },
    { cmd: "python", source: "PATH" },
    ...(process.platform === "win32" ? [{ cmd: "py", args: ["-3"], source: "PATH" }] : []),
  ];
  for (const candidate of candidates) {
    const found = probePython(candidate, metadata, options.run);
    if (found) return found;
  }
  return provisionPython({ ...options, metadata, directory });
}
