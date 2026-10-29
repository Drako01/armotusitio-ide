// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mts";
export const matchesPath = (...args) => rpc("matchesPath", args);
export const allowedPath = async (...args) => rpc("allowedPath", args);
export const readSource = async (...args) => rpc("readSource", args);
export const pathRule = rpc("constants").pathRule;
