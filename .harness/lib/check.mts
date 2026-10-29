// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mts";
export const check = async (...args) => rpc("check", args);
export const agentsDoc = async (...args) => rpc("agentsDoc", args);
