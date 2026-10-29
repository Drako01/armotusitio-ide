// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mts";
export const persistTask = async (...args) => rpc("persistTask", args);
export const moveTask = async (task, status) => {
  Object.assign(task, rpc("moveTask", [task, status]));
};
export const log = async (...args) => rpc("log", args);
export const handoff = async (...args) => rpc("handoff", args);
export const validateTask = async (...args) => rpc("validateTask", args);
export const TASK_STATUSES = ["active", "completed", "failed"];
export const isTaskId = (v) => typeof v === "string" && /^[a-zA-Z0-9_-]+$/.test(v);
export function assertTaskId(v, message = "Task id invalid") {
  if (!isTaskId(v)) throw Error(message);
}
export const isFailedOrBlocked = (n) => ["failed", "blocked"].includes(n.status);
export const nodeById = (t, id) => t.dag.find((n) => n.id === id);
export function reopenNodes(t) {
  for (const n of t.dag || []) if (["failed", "blocked", "running"].includes(n.status)) n.status = "pending";
}
