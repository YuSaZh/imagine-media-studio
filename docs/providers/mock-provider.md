# PR 0 Mock Provider

## Purpose

The Mock Provider is a deterministic, zero-network test adapter for proving the PR 0 Provider contract, JobRunner lifecycle, SQLite persistence, and local output storage. It is not a model, a simulation of model quality, or a real generation API.

OpenAI-compatible, Gemini, xAI, and custom Providers are outside PR 0. No real Provider credential, endpoint, SDK, HTTP schema, polling behavior, or production capability may be inferred from this Mock.

## Scope

| Property | PR 0 contract |
| --- | --- |
| Provider type | `mock` |
| Model | `mock-image-v1` |
| Operation | `image.generate` only |
| Aspect ratio | `1:1` only |
| Batch | Unsupported |
| Submission mode | Synchronous completion |
| Output | Fixed valid PNG fixture |
| Network access | Forbidden |
| Secrets | None |
| Remote job ID | None |
| Poll/cancel transport | Not applicable |

Other operation names can exist in the shared contract, but accepting them from this PR 0 adapter would incorrectly imply real support.

## Determinism Contract

For the same valid PR 0 request and Mock Provider version:

- capability discovery returns the same ordered capability document;
- validation returns the same outcome;
- submission returns the same completion state, MIME type, asset count, and bytes;
- no wall-clock value, random value, external URL, host state, or network response changes the Provider result;
- errors normalize to a stable error code and retryability classification.

Job IDs, database timestamps, and output file paths may be assigned by the surrounding application. They are orchestration metadata and are not part of the Mock Provider's deterministic payload.

The current PR 0 fixture is a fixed valid `image/png`. It exists only to make asset persistence, hashing, and restart checks observable; it is not UI demonstration media or a visual baseline.

## Zero-Network Rule

The Mock Provider must never call `fetch`, `undici`, DNS, sockets, localhost, container services, or external APIs. It must not depend on network availability to discover capabilities, validate, submit, or normalize errors.

Tests should fail if a network primitive is invoked while exercising the Mock Provider. A test that merely runs offline is insufficient because accidental localhost calls may still succeed.

## Request Validation

A valid PR 0 request must satisfy the shared `GenerationRequest` schema and the Mock-specific constraints:

```text
providerId = mock
modelId = mock-image-v1
operation = image.generate
prompt = non-empty
inputs = []
aspectRatio = absent or 1:1
count = absent or 1
```

The adapter must reject unsupported Provider IDs, model IDs, operations, reference inputs, ratios, and batch counts with a normalized non-retryable error. Validation must occur before an output asset is persisted.

## JobRunner Boundary

The adapter owns only Provider behavior:

1. Advertise deterministic capabilities.
2. Validate the normalized request.
3. Return one synchronous fixture asset.
4. Normalize Provider-facing errors.

The in-process JobRunner owns:

- claiming a durable queued job;
- job status and stage transitions;
- invoking the adapter;
- decoding and writing the output below `/data`;
- hashing and recording the asset in SQLite;
- marking completion or normalized failure;
- resuming queued jobs after process restart.

The Mock Provider must not open SQLite, write files, start a timer loop, create a worker process, or expose its own HTTP route.

## Expected PR 0 Lifecycle

```text
queued
  -> submitting
  -> processing (saving deterministic fixture)
  -> completed
```

An invalid or unexpected result transitions through the JobRunner to `failed` with a normalized error. PR 0 does not use remote polling, remote progress, or a fake asynchronous delay.

## Persistence And Migration Checks

The GitHub-hosted Actions smoke test must prove:

1. Migrations are applied and recorded in `schema_migrations`.
2. A Mock job can be inserted into `/data/app.db` through the application interface.
3. JobRunner completes the job and creates the deterministic PNG below `/data`.
4. The database asset row matches the output MIME type, byte size, relative path, and SHA-256.
5. Restarting the only business container preserves the job and asset.
6. A queued Mock job present at startup is recovered and completed.

## Test Matrix

| Case | Input | Expected result |
| --- | --- | --- |
| Capability stability | Repeat capability discovery | Deep-equal ordered result |
| Deterministic output | Repeat valid submission | Byte-identical PNG payload |
| Valid request | Supported Provider/model/operation | One synchronous completed asset |
| Wrong Provider | `providerId != mock` | Stable non-retryable normalized error |
| Wrong model | `modelId != mock-image-v1` | Stable non-retryable normalized error |
| Unsupported operation | Any operation except `image.generate` | Stable non-retryable normalized error |
| Unsupported input/ratio/count | Value outside declared capability | Stable non-retryable normalized error |
| Network isolation | Install failing network spies | Zero network invocation |
| Restart recovery | Durable queued row before startup | Completed after JobRunner starts |
| Idempotent migration | Start twice with same `/data` | No destructive schema or data change |

## Validation Execution Boundary

No local service, production build, Playwright E2E, or Docker/Compose command is run for this work because the host already runs unrelated services. Local lint, typecheck, and isolated unit tests may be run without binding ports. GitHub-hosted Actions repeat those checks and exclusively execute production builds, E2E, image builds, and container smoke tests.

## Exit Criteria

- [ ] Mock Provider capability and output are deterministic.
- [ ] Mock Provider performs zero network access and requires no Secret.
- [ ] Only `mock-image-v1` / `image.generate` is accepted.
- [ ] JobRunner, not the Provider, owns persistence and recovery.
- [ ] Completed output survives replacement/restart of the one business container.
- [ ] `schema_migrations` records the applied schema version.
- [ ] No real Provider is implemented or represented as supported in PR 0.
