// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mts";
export const verifyScopeRestoration = async (...args) => rpc("verifyScopeRestoration", args);
export const clearRestoredScope = async (...args) => rpc("clearRestoredScope", args);
export const verifyInterrupted = async (...args) => rpc("verifyInterrupted", args);
import path from "node:path";
export const relativeToRoot = (file) => path.relative(process.cwd(), file).replaceAll("\\", "/");
export const baselineFile = (task, node) =>
  path.join(process.cwd(), ".harness/runtime", `${task.id}-${node.agent}-${node.attempts}-baseline.json`);
