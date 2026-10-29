// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mts";
export const execute = async (...args) => rpc("execute", args);
