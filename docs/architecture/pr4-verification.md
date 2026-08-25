# PR 4 Verification

Status: **passed**

PR 4 completes the real image Provider boundary described in [PLAN.MD](../../PLAN.MD). The implementation is verified against fixed protocol fixtures and injected HTTP transports. No production Provider credential or live external Provider endpoint was used, so credentialed external acceptance remains open in [Hold.md](../../Hold.md).

## Delivered Scope

PR 4 adds the following versioned image profiles while preserving the Mock Provider:

| Profile | Protocol boundary | Result and input scope |
|---|---|---|
| `openai-images-v1` | OpenAI Images generations and multipart edits | Base64/URL results, masks, multi-reference edits, batch output, and Images SSE partial/final results |
| `openai-responses-image-v1` | OpenAI Responses image-generation tool | Text/image input, edit inputs, Base64 results, and Responses SSE partial/final results |
| `gemini-generate-content-image-v1` | Gemini Native `generateContent` | `inlineData` inputs, `inlineData`/`fileData` results, generation and edit, model-specific reference limits |
| `gemini-interactions-image-v1` | Gemini Interactions image endpoint | Generation, source and multi-reference edits, previous-interaction edits, Base64/file URL results |
| `xai-imagine-image-v1` | xAI/OpenAI-compatible Imagine image endpoint | Generation, multi-reference edits, Base64/URL results, model-specific batch limits |

Provider registration keeps the Mock Provider available for deterministic local flows. The browser may receive schema-sanitized non-secret Base URL/configuration and `hasApiKey`/`hasCustomHeaders` flags needed to edit a Provider. Plaintext API keys, custom-header values, and encrypted ciphertext remain server-side and are decrypted only inside adapter contexts.

## Transport And Security Boundary

All real Provider HTTP calls use the application-owned injected `ProviderHttpClient`. Adapters do not call `fetch`, create a default network client, or resolve asset IDs as media bytes.

- Requests are limited to the adapter transport's `GET` and `POST` port.
- Base URLs are validated without credentials, query, or fragment where the profile constructs an endpoint.
- `NetworkPolicy` resolves DNS before the request, rejects metadata and unsafe address ranges by default, pins the selected address, and disallows redirects.
- Provider HTTP has bounded request/response bodies, header/connect/body timeouts, reason-free abort errors, and response disposal on success and failure.
- Insecure Provider HTTP is controlled by the independent `ALLOW_INSECURE_PROVIDER_HTTP` switch; media-download HTTP has separate semantics. Private-network access remains a separate policy switch.
- API keys and custom headers are encrypted at rest, redacted from Provider errors, rejected from browser-facing DTOs and logs, and protected against CRLF and protocol-header override.
- Provider output URLs reject userinfo and are passed through the existing SSRF-safe local materialization path. Base64, result IDs, metadata, URLs, and output counts are bounded before materialization.

## Capability And Catalog Boundary

Static profile defaults remain available for pure unit use without an HTTP client. When a live registration supplies the injected safe HTTP client, the ProviderService calls the adapter's live catalog hook and records `capabilitySource: provider`. Dynamic catalogs are bounded and filter models to the current image operation. Known model IDs use the profile's precise limits; unknown legal image models use conservative capabilities. Manual model rows remain authoritative across refreshes.

Connection tests are separate from model refresh. They perform a lightweight authenticated `GET /models` endpoint check, do not start a media operation, and do not treat static capabilities as proof of connectivity. Synchronous image profiles expose poll-not-applicable fixtures/contracts; asynchronous video polling remains a PR 5 concern.

## Runtime Boundary

PR 4 keeps the existing single-service topology:

```text
Browser / installed PWA
          |
          v
One Fastify Node.js process
  |-- internal API and static Web assets
  |-- SQLite/Drizzle
  |-- in-process JobRunner
  `-- ProviderRegistry -> injected safe ProviderHttpClient -> external Provider
          |
          `-- /data/app.db and managed media
```

There is one Docker Compose business service, one application process, one SQLite database, one port, and one `/data` volume. Provider results are normalized and materialized into local managed media before they are exposed through Asset DTOs. PR 4 does not add a worker, Redis, PostgreSQL, object store, Nginx, or a second application service.

## Local Acceptance

The final development-host checks used only non-runtime validation. No application server, Playwright server, Docker build, or Compose runtime was started.

| Check | Result | Evidence |
|---|---|---|
| `pnpm lint` | Pass | Full repository ESLint run completed without errors. |
| `pnpm typecheck` | Pass | All workspace typecheck projects completed successfully. |
| `pnpm test` | Pass | 65 test files / 408 tests passed. Provider protocol, transport, registry, service, runner, media, and route tests use fixtures or injected transports. |
| `pnpm build` | Pass | Production build completed; the 564.46 kB entry-chunk advisory remains non-blocking. |
| `docker compose config --services` | Pass | Static Compose expansion resolves exactly one service: `imagine-media`. |
| `git diff --check` | Pass | No whitespace errors in the final diff. |

## Remote Acceptance

GitHub Actions run [32877168438](https://github.com/YuSaZh/imagine-media-studio/actions/runs/32877168438) completed all final PR4 jobs successfully:

| Job | Result | Evidence |
|---|---|---|
| Quality | Pass | [Job 97897808924](https://github.com/YuSaZh/imagine-media-studio/actions/runs/32877168438/job/97897808924) |
| Single-container smoke | Pass | [Job 97897808696](https://github.com/YuSaZh/imagine-media-studio/actions/runs/32877168438/job/97897808696) |
| Playwright | Pass | [Job 97897808923](https://github.com/YuSaZh/imagine-media-studio/actions/runs/32877168438/job/97897808923) |

The remote checks validate the production build, browser flows, one-service Compose topology, bounded runtime behavior, and persistence boundaries. They do not constitute credentialed acceptance against OpenAI, Google, or xAI production endpoints.

## Deferred Items

- Live external Provider acceptance with user-approved credentials and endpoints remains pending; protocol fixtures and injected safe transports are the current evidence boundary.
- Dynamic model catalog refresh currently consumes one bounded response page. Profile-specific pagination remains open for Providers whose official catalog exceeds the first page.
- The production entry chunk remains above Vite's advisory threshold; broader route/vendor splitting remains a later performance task.
- xAI asynchronous video submission/polling, Gemini video profiles, and OpenAI-compatible video profiles remain PR 5 scope.
- Declarative custom Provider import, dry run, redacted request preview, and advanced diagnostics remain PR 6 scope.
- Terminal provider-result cleanup reconciliation remains assigned to the later media consistency/repair work.
