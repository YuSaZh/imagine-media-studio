# PR 2 Verification

## Delivered Scope

This historical PR 2 record covers the persistent application boundary of the
original delivery plan. Current guidance is indexed in [docs/README.md](../README.md).
The milestone covered:

- strict settings, Provider, model, Job, Asset, Collection, and event contracts;
- SQLite migration `0001_pr2_core.sql` with cursor pagination, revision CAS, retry lineage, stable output slots, and a durable change-event outbox;
- AES-256-GCM Provider Secret encryption and safe Provider DTOs;
- optional application-password session gate with HttpOnly and SameSite cookies;
- bounded in-process JobRunner queues, cancellation, polling, retry limits, and crash recovery;
- atomic media upload, image thumbnails, video posters, Range/HEAD delivery, and consistency auditing;
- SSRF-safe remote downloads with DNS validation, IP pinning, redirect validation, and size/type limits;
- stable Provider output materialization keyed by Job and output slot, followed by atomic Asset/output finalization;
- one browser SSE connection backed by durable replay and ordered live outbox publication;
- production Gallery, Composer, Collections, Settings, Provider configuration, and authentication flows using the internal API.

The Mock Provider is still the only executable adapter. OpenAI-compatible, Gemini, xAI, and custom adapters remain gated to PR 4 and later.

## Local Acceptance

The development-host checks completed without invoking Docker or Compose:

| Check | Result |
| --- | --- |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass across all workspaces |
| `pnpm test` | Pass, 35 files / 153 tests |
| `pnpm build` | Pass; one non-blocking 529.57 kB entry-chunk warning |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium pnpm test:e2e` | Pass, 24 tests / 4 viewports |
| Fastify upload/Range/Collection/Provider/Auth injection | Pass |
| Port `3030` before and after Playwright | Free |

Playwright used a fresh test data directory. The test server exited normally, the port was released, and the pre-existing `/tmp/imagine-media-studio-e2e-data` directory was restored afterward. PR 1 screenshot baselines were restored after the mechanical local capture so PR 2 does not introduce unrelated binary drift.

## Remote Acceptance

GitHub-hosted Actions owns independent build, browser, and container validation:

| Commit / run | Result | Evidence |
| --- | --- | --- |
| PR 2 dependency stage `45b646d` / run `32807845343` | Pass | Exact dependencies, build, Playwright, container smoke |
| Server foundation `d552e9e` / run `32810802031` | Superseded | Quality/build and Playwright passed; old smoke expected migration `0000` and was corrected immediately |
| PR 2 smoke correction `2b284bb` / run `32811063476` | Pass | Full PR 2 API, media, SQLite, restart, and SSE replay smoke |
| Runtime hardening `f933f75` / run `32812756608` | Pass | Idempotent Provider media, outbox live SSE, auth, bounded smoke |
| Persistent Web flows `4ed1d5c` / run `32812881488` | Pass | Final PR 2 quality, Playwright, and container rerun |

The smoke workflow runs one Compose service under a unique project name, uses a dynamically allocated host port and a temporary `0700` data directory, has bounded request/Compose/job timeouts, and always removes its resources.

## Safety And Secret Checks

- No real Provider request is enabled in PR 2.
- Provider plaintext and ciphertext are absent from browser DTOs, PWA data, and logs.
- Settings reject secret-like keys.
- Cross-origin browser writes are rejected.
- `APP_PASSWORD` is functional rather than a no-op; protected API requests require a signed session or explicit Basic credentials for CLI use.
- Project Docker/Compose was not run on the development host.
- The project did not stop, restart, rename, or inspect existing host services.

## Deferred Items

- Real Provider adapters and their contract fixtures begin in PR 4.
- Image input preprocessing and Mask behavior begin in PR 3.
- The authenticated Grok Imagine reference package remains unavailable, so the earlier PR 1 strict L3/L4 visual classification remains explicitly unclaimed.
- The production Web entry chunk is above Vite's 500 kB advisory threshold; route-level splitting is a non-blocking optimization for a later integration phase.
