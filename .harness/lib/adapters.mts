// Compatibility shims; logic is implemented in Python.
import { rpc } from "./bridge.mts";
export const claudeArgs = (...args) => rpc("claudeArgs", args);
export const extractClaudeResult = (...args) => rpc("extractClaudeResult", args);
export const hostAdapter = (...args) => rpc("hostAdapter", args);
export const parseResult = (...args) => rpc("parseResult", args);
export const agentTimeoutMs = (...args) => rpc("agentTimeoutMs", args);
const constants = rpc("constants");
export const { claudeReadOnlyTools, claudeWriteTools, claudeDeniedForReadOnly } = constants;
