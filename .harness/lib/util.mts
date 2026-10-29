import path from "node:path";
import { promises as fs } from "node:fs";
import { rpc } from "./bridge.mts";
export const root = process.cwd(),
  H = path.join(root, ".harness");
export const MAX_BUFFER_BYTES = 33554432,
  OUTPUT_TAIL_BYTES = 4096,
  MAX_TIMEOUT_MS = 86400000;
export const exists = async (p) =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);
export const jread = (...args) => rpc("jread", args);
export const writeJson = (...args) => rpc("writeJson", args);
export const id = (...args) => rpc("id", args);
export const tokenize = (...args) => rpc("tokenize", args);
export const terms = (...args) => rpc("terms", args);
export const digest = (...args) => rpc("digest", args);
export const validateSchema = (...args) => rpc("validateSchema", args);
export const gateTimeoutMs = (...args) => rpc("gateTimeoutMs", args);
export const maxRetries = (...args) => rpc("maxRetries", args);
export const spawnRun = (...args) => rpc("spawnRun", args);
