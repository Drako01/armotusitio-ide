// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mjs";
export const inferDomains = (...args) => rpc("inferDomains", args);
export const taskSlice = (...args) => rpc("taskSlice", args);
export const selectAgents = (...args) => rpc("selectAgents", args);
export const buildDag = (...args) => rpc("buildDag", args);
