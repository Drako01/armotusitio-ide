// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mts";
export const manifests = async (...args) => rpc("manifests", args);
export const getDomain = async (...args) => rpc("getDomain", args);
export const skillIndex = async (...args) => rpc("skillIndex", args);
export const context = async (...args) => rpc("context", args);
