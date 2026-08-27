# PR 6 Verification

Status: **Local acceptance complete; GitHub Actions remote verification pending.**

PR 6 implementation is complete for the custom Provider boundary described in
[`PLAN.MD`](../../PLAN.MD). This record covers declarative HTTP adapters,
administrator-installed Trusted JavaScript adapters, their examples, and the
security limits around both paths.

The local example checks below are executable without starting an application
server, Docker, Compose, or an external Provider. Local acceptance is complete
for the checks recorded below. Remote Actions verification remains pending: the
two specific incidents and their impact on the PR 6 workflow runs are recorded
in [`Hold.md`](../../Hold.md). The commit and run fields are placeholders until
a remote run is accepted.

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

These checks are allowed on the development host because they do not start a
service or contact a Provider.

| Check | Command | Result |
| --- | --- | --- |
| Example parser, manifest digest, exports, and source policy | `pnpm exec vitest run apps/server/src/providers/custom-http/examples.test.ts` | Pass locally on 2026-08-27 |
| Declarative HTTP unit suite | `pnpm exec vitest run apps/server/src/providers/custom-http/custom-http.test.ts` | Pass locally: 28 tests on 2026-08-27 |
| Trusted worker/manifest unit suites | `pnpm exec vitest run apps/server/src/providers/custom-js/custom-js.test.ts apps/server/src/adapters/fixture.test.ts apps/server/src/adapters/worker-host.test.ts` | Pass locally: 27 tests on 2026-08-27 |
| Adapter management service/route suites | `pnpm exec vitest run apps/server/src/services/custom-adapter-service.test.ts apps/server/src/services/trusted-adapter-service.test.ts apps/server/src/routes/adapters.test.ts` | Pass locally: 47 tests on 2026-08-27 |
| Workspace typecheck | `pnpm typecheck` | Pass locally on 2026-08-27 |
| PR6 example lint | `pnpm exec eslint apps/server/src/providers/custom-http/examples.test.ts examples/custom-providers/trusted-js/adapter.mjs` | Pass locally on 2026-08-27 |
| Diff whitespace and documentation link review | `git diff --check` plus local-link review for changed Markdown | Pass locally on 2026-08-27 |

No local check in this document starts the app server, E2E server, Compose, or
Docker. No check uses a real Provider credential or endpoint.

## GitHub Actions acceptance

The following fields are intentionally left for the primary integration run.
They must be filled with actual values only after GitHub Actions generates and
completes the corresponding jobs.

| Workflow surface | Commit | Run | Job/evidence | Status |
| --- | --- | --- | --- | --- |
| Quality, lint, typecheck, unit tests, production build | `COMMIT_SHA_TBD` | `RUN_ID_TBD` | `QUALITY_JOB_ID_TBD` | Pending; no run generated during the outage |
| Browser/E2E and screenshot artifact | `COMMIT_SHA_TBD` | `RUN_ID_TBD` | `E2E_JOB_ID_TBD` | Pending; no run generated during the outage |
| Single-container API/persistence smoke | `COMMIT_SHA_TBD` | `RUN_ID_TBD` | `SMOKE_JOB_ID_TBD` | Pending; no run generated during the outage |

Remote acceptance must retain the one-service topology and must not add a real
credential, endpoint, or secret to workflow logs, artifacts, fixtures, or
exported configuration. Until the placeholders are replaced, PR 6 has no
remote CI pass claim.

## Open evidence

- Actions run generation is recorded in [`Hold.md`](../../Hold.md).
- Live credentialed Provider acceptance remains external evidence and is not
  substituted by these placeholder examples.
- PR 8 owns future media cleanup reconciliation and any additional defense-in-
  depth security review that is not required by the PR 6 boundary.
