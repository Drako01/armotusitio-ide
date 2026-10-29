#!/usr/bin/env node
// Provider smoke uses the same Python lifecycle and sanitized evidence.
process.argv.splice(2, 0, "smoke-host");
await import("./bootstrap.mts");
