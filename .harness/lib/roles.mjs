import { rpc } from "./bridge.mjs";
export const { readOnlyAgents, downstreamAgents, nonImplementerAgents, fixedAgents, deterministicAgents } =
  rpc("constants");
export const protectedStatePattern = /^\.harness\/(tasks|state|handoffs|logs)\//;
export const lockFilePattern = /^\.harness\/state\/[^/]+\.lock$/;
export const feedbackAgents = ["reviewer", "security-auditor", "verifier"];
