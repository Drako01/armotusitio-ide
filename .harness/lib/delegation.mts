// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mts";
export const runGate = async (...args) => rpc("runGate", args);
export const delegationContext = async (...args) => rpc("delegationContext", args);
export const compactHandoff = (...args) => rpc("compactHandoff", args);
export const delegationPrompt = (...args) => rpc("delegationPrompt", args);
export const executeNode = async (...args) => rpc("executeNode", args);
