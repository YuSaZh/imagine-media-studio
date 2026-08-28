# PR 6 Verification

Status: **Local and GitHub Actions acceptance passed.**

PR 6 implementation is complete for the custom Provider boundary described in
[`PLAN.MD`](../../PLAN.MD). This record covers declarative HTTP adapters,
administrator-installed Trusted JavaScript adapters, their examples, and the
security limits around both paths.

The checks below cover the PR 6 boundary without using a real Provider
credential or endpoint. Runtime checks used task-owned isolated resources and a
non-conflicting port; no existing host service or container was altered.

## Feature matrix

| ID | Acceptance surface | Evidence | Current status |
| --- | --- | --- | --- |
| F-01 | Synchronous image declaration parses as JSON and extracts a Base64 result | [`sync-image.json`](../../examples/custom-providers/sync-image.json), `examples.test.ts` | Local fixture covered |
| F-02 | Asynchronous video declaration parses as YAML and separates submit from poll | [`async-video.yaml`](../../examples/custom-providers/async-video.yaml), `examples.test.ts` | Local fixture covered |
| F-03 | JSON request body templates model and prompt values | `sync-image.json`, declarative compiler tests | Local fixture covered |
| F-04 | Form request body templates and expected submit status | `async-video.yaml`, declarative compiler tests | Local fixture covered |
| F-05 | Multipart request body selects bounded source and mask files by role | [`multipart-image-edit.json`](../../examples/custom-providers/multipart-image-edit.json), declarative compiler tests | Local fixture covered |
| F-06 | Relative path templates, RFC 6901 extraction paths, status mappings, progress, result URL/Base64, and expiry paths are explicit | All three declarations, parser/extractor tests | Local fixture covered |
| F-07 | Model capabilities and restricted request parameters drive validation and previews | Model `capabilities` and `requestSchema` in the examples, capability tests | Local fixture covered |
| F-08 | Import/export, validation, redacted preview, Dry Run, simulated response, path test, and capability preview remain server-owned | `custom-adapter-service.test.ts`, `routes/adapters.test.ts` | Local unit coverage present |
| F-09 | Trusted JavaScript manifest/source pair has a matching digest and required lifecycle exports | [`trusted-js/manifest.json`](../../examples/custom-providers/trusted-js/manifest.json), [`trusted-js/adapter.mjs`](../../examples/custom-providers/trusted-js/adapter.mjs), `examples.test.ts` | Local fixture covered |
| F-10 | Trusted JavaScript network calls use the host-injected SafeHttpPort and exact manifest host allowlist | [`apps/server/src/adapters/README.md`](../../apps/server/src/adapters/README.md), `worker-host.test.ts` | Local unit coverage present |
| F-11 | Trusted revisions are administrator-gated, digest-bound, immutable, and reference-safe | `trusted-adapter-service.test.ts`, adapter store tests, adapter route tests | Local unit coverage present |

## Security matrix

| ID | Boundary | Evidence or rule | Current status |
| --- | --- | --- | --- |
| S-01 | Credential storage and exposure | Provider secrets remain encrypted/server-side; examples contain only `apiKey` names and no values; exports and browser DTOs are secret-free | Covered by Provider, route, and example tests |
| S-02 | Declarative document safety | JSON/YAML parsing is bounded and rejects duplicate keys, aliases, tags, merges, prototype keys, unsafe templates, and unsupported schema keys | Covered by parser/compiler tests |
| S-03 | Request injection and SSRF | Paths are relative and traversal-free; credential query fields are rejected; HTTP is routed through the existing bounded HTTPS-safe transport and host checks | Covered by compiler and transport tests |
| S-04 | Result safety | URL results reject credentials/fragments and are bounded before materialization; Base64, MIME, metadata, and result manifests are bounded | Covered by extractor, submitted-asset, media, and JobRunner tests |
| S-05 | Trusted source policy | Installation validates UTF-8, source size, manifest digest, required exports, and best-effort forbidden tokens; this is not presented as a sandbox | `manifest.ts`, adapter store/service tests, and the example source check |
| S-06 | Trusted network and secrets | Worker code receives only necessary Provider data; network is an RPC through SafeHttpPort; manifest hosts and required secret names are explicit | `worker-host.test.ts`, adapter runtime README, Trusted JS example |
| S-07 | Trusted execution limits | `worker_threads`, timeout, message/output/log limits, and bounded input files are enforced; dynamic imports/package installation and direct network globals are not allowed by source policy | `worker-host.test.ts`, `fixture.test.ts`, Trusted JS example |
| S-08 | Management authorization and lifecycle | Trusted install/list/bind/remove operations require administrator authorization and preserve immutable references/tombstones | `trusted-adapter-service.test.ts`, `routes/adapters.test.ts` |
| S-09 | Runtime topology | Custom adapters stay in the one Node process, one SQLite database, one port, and one `/data` volume boundary | [`PLAN.MD`](../../PLAN.MD), PR6 runtime tests |

## Local acceptance

Checks that start a service use only task-owned isolated resources and do not
contact a real Provider.

| Check | Command | Result |
| --- | --- | --- |
| Full workspace unit suite | `pnpm test` | Pass locally: 95 test files / 828 tests |
| Workspace lint | `pnpm lint` | Pass locally |
| Workspace typecheck | `pnpm typecheck` | Pass locally |
| Workspace production build | `pnpm build` | Pass locally |
| E2E TypeScript compilation | E2E `tsc` check | Pass locally |
| Playwright E2E | `./node_modules/.bin/playwright test` | Pass locally: 61 passed / 19 skipped |
| Isolated Docker/Compose smoke | `docker compose build` then `bash .github/scripts/docker-smoke.sh` | Pass locally with project `imagine-media-pr6-finalwip-1787889767-2` on port `44271`; task-owned resources were cleaned up |
| Diff whitespace and documentation link review | `git diff --check` plus local-link review for changed Markdown | Pass locally |

No check uses a real Provider credential or endpoint.

## GitHub Actions acceptance

GitHub Actions run [33140963119](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33140963119) accepted commit `79a30f2ac0881b7f668b9a176d6b02a8884eb73f` and completed all three jobs successfully.

| Workflow surface | Commit | Run | Job/evidence | Status |
| --- | --- | --- | --- | --- |
| Quality, lint, typecheck, unit tests, production build | `79a30f2` | [33140963119](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33140963119) | [Job 98751517902](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33140963119/job/98751517902) | Pass; 1m16s |
| Browser/E2E and screenshot artifact | `79a30f2` | [33140963119](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33140963119) | [Job 98751517753](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33140963119/job/98751517753) | Pass; 3m02s |
| Single-container API/persistence smoke | `79a30f2` | [33140963119](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33140963119) | [Job 98751517875](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33140963119/job/98751517875) | Pass; 1m30s |

The remote checks retained the one-service topology and did not add a real
credential, endpoint, or secret to workflow logs, artifacts, fixtures, or
exported configuration. They validate the PR 6 custom Provider boundary with
fixtures and isolated runtime checks, not credentialed production Provider
acceptance.

## Remaining scope

- Live credentialed Provider acceptance remains external evidence and is not
  substituted by these examples or remote CI.
- PR 7 owns future cross-device polish and cold-offline Gallery metadata
  reconstruction; those items are not part of the PR 6 pass claim.
- PR 8 owns future media cleanup reconciliation and any additional defense-in-
  depth security review that is not required by the PR 6 boundary.
