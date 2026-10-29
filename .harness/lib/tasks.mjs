// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mjs";
export const makeTask = async (...args) => rpc("makeTask", args);
export const loadTask = async (...args) => rpc("loadTask", args);
export const expandSource = async (...args) => rpc("expandSource", args);
export const listTasks = async (...args) => rpc("listTasks", args);
export const abortTask = async (...args) => rpc("abortTask", args);
export const retryTask = async (...args) => rpc("retryTask", args);
export const dispatch = async (...args) => rpc("dispatch", args);
export const taskFileText = async (...args) => rpc("taskFileText", args);
