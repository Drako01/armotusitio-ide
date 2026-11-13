# Official extensions bundled with the IDE

Fresh desktop installations include seven pinned Open VSX extensions as real Code OSS builtins, with no first-run download. `build/armotusitio/official-extensions.json` is the canonical version, source URL and SHA-256 manifest. `armotusitio.vestigivo` is the published ID of **Vestigivo RCA**; the requested `vestigivo-rca` ID does not exist in the registry.

## Packaging and updates

`armotusitioOfficialExtensions.ts` validates pins and composes the existing builtin list additively. Native download and packaging streams use exact Open VSX URLs and enforce SHA-256. Existing upstream artifact routes remain unchanged. All seven audited VSIXs are universal JavaScript packages without detected native binaries, so the same pins serve supported Windows, Linux and macOS desktop targets. Browser-only runtimes cannot execute these Node extensions.

The effective product permits Open VSX updates and lists these seven IDs in `autoUpdateBuiltinExtensionsByDefault`. Their **Automatic Update** checkbox is visible and checked with the default global setting. Explicit per-extension opt-out, global settings, pinned versions and extension disablement retain authority, including after an update creates a user-directory copy. Other builtins retain their existing forced-update policy. Native scanning keeps one effective extension and preserves a newer user-installed version; no preference files are seeded or overwritten.

## Audited releases

| Extension | Version | Dependency notes |
|---|---|---|
| `armotusitio.orquestivo` | 0.1.1 | GitHub and language-model integrations optional and off by default |
| `armotusitio.probato-pr` | 1.0.1 | Optional GitHub/AI providers; default AI provider is none; Node >=22.12.0 |
| `armotusitio.indizivo` | 0.3.0 | Local probes and approved loopback diagnostics |
| `armotusitio.saturivo` | 0.2.2 | k6/Go needed for their respective operations; tools are not installed automatically |
| `armotusitio.noditrivo` | 0.1.1 | Local Git analysis |
| `armotusitio.vestigivo` | 0.1.2 | Optional Sentry/Grafana; configured allowlist, secrets storage and confirmation |
| `armotusitio.vinculivo` | 0.2.1 | Local-first project context and decision governance; no runtime dependencies in the package |

All seven registry records had a verified namespace, trusted publishing by Drako01, `preRelease=false`, MIT license, no extension dependencies and no proposed APIs. **Orquestivo declares `preview=true` in both published versions and Vinculivo 0.2.1 declares `preview=true` as well; non-preview alternatives are unavailable.** This limitation is not presented as a stable-product certification. VS Code engine ranges accept IDE 1.145.2. The actual local Electron43.8.3 embeds Node24.22.0 and meets Probato's additional requirement.

SHA-256 matches registry checksum endpoints and downloaded bytes; cryptographic publisher signatures were not verified. A bounded archive scan found no sensitive filenames or high-confidence credential patterns; it is not an exhaustive security audit. Optional remote integrations were not exercised with real credentials.

## Reproducible evidence and limits

Run `node build/armotusitio/check-official-extensions.ts <directory-with-seven-pinned-vsix-files>` to verify and extract archives using the existing native `fromVsix` stream. It checks full hashes, manifest identity/version, compatible engine, entrypoint, license and publisher metadata. Output is `.build/official-extensions-verification`.

Build tests passed9/9; official Electron update/action/scanner tests passed25/25. A fresh isolated source-product profile, with empty user extensions and an unavailable proxy, recognized and activated the first six local builtin archives exactly once. A synthetic broken extension failed activation while the six remained active. Vinculivo 0.2.1 was added on 2026-11-13: its pin passed the same archive check (SHA-256, manifest identity, engine, entrypoint, license, publisher) but its installed-profile activation has not been repeated yet. This validates local archive startup, not a released installer or fully disconnected operating system.

Startup AgentHost client-channel errors also occurred in an empty-builtin baseline. One AgentHost shutdown timeout occurred only in the extension run; attribution remains NOT VERIFIED. Full installer acceptance, real gallery upgrade with configuration retention, signed-artifact verification and execution on other operating systems remain separate validation conditions. No release or merge is implied.
