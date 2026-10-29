import { rpc } from "./bridge.mjs";
const payload = (map) => ({ files: [...map], ignored: [...(map.ignored || [])] });
export const snapshot = async () => {
  const v = rpc("snapshot");
  const map = new Map(v.files);
  map.ignored = new Set(v.ignored);
  return map;
};
export const serializeSnapshot = (map) => JSON.stringify(payload(map));
export const parseSnapshot = (text) => {
  const v = JSON.parse(text);
  const map = new Map(v.files);
  map.ignored = new Set(v.ignored);
  return map;
};
export const changedFiles = async (before, after, ...args) =>
  rpc("changedFiles", [payload(before), payload(after), ...args]);
