# Third-party reuse audit

## CPA and sub2api image response compatibility

Protocol-only review: CLIProxyAPI `5208aec703b5ce7e3445f6e9d91cc13b3e78003a` (MIT), `internal/runtime/executor/codex_openai_images.go`; sub2api `deff3123ded1d14e51df1fd1286e3d43ed9ec9bd` (LGPL-3.0, matching the HPServer sub2api1 image revision), `backend/internal/service/openai_images_responses.go`. Both can put base64 data URLs in `data[].url` and image SSE events. Local CPA response logs were inspected through a field-shape-only filter that excludes credentials and image contents. No upstream code or UI was copied; fixtures and normalization changes are independently implemented. xAI polling was checked against the official REST video result example, which omits a repeated request ID.

## DEEIX administration mechanism reference

Reviewed DEEIX-AI/DEEIX-Chat at commit `1a95cb0a0bbf9d6ebd8353b285eb9cd60ce4ada0` (Apache-2.0). Reference-only files: `frontend/features/admin/components/sections/models/models-capabilities-config.tsx`, `models-sheet.tsx`, `frontend/features/admin/components/sections/upstreams/upstreams-sheet.tsx`, `frontend/features/admin/model/upstreams-models.ts`, and `backend/internal/application/conversation/model_option_policy.go`.

The useful mechanisms are shared upstream connections, model protocol bindings, and configurable parameter controls/defaults/locked values. This project implements those concepts independently within its existing React/Fastify/SQLite contracts. No upstream component source, CSS, runtime, identity/billing system or assets are copied. The existing single-process deployment and encrypted server-only credentials remain authoritative.

## 2026-09-05 production workspace replacement

The new workspace uses Grok Imagine as a visual and interaction reference only, following direct public DOM/style inspection. No upstream page implementation was copied. Existing local nonvisual kernels retain their original audit and notices. Four previously reviewed Unsplash photographs were moved from the deleted prototype to `e2e/media/`; their exact source URLs are recorded in [workspace.md](../design-spec/workspace.md). They are test inputs only. Old generated study media, prototype video, legacy screenshots and page code were removed. No new third-party package was introduced.

Audit date: 2026-08-25 (Asia/Tokyo)

Status: **PR 3 selective reuse completed for two pure algorithm subsets**. Only the exact source blobs and targets listed below were adapted; file-level attribution, the complete MIT notice, and local contract tests are present. No upstream UI, assets, tests, or generated artifacts were copied.

## Policy and scope

`PLAN.MD` makes Grok Imagine the sole UI/UX reference. The repositories in this audit must not supply this project's App Shell, page layout, navigation, Composer, gallery, Viewer, CSS, design tokens, responsive structure, page-level state, or global store.

- `CookSleep/gpt_image_playground` may be considered later as a donor for narrowly scoped, non-visual image logic.
- `lidge-jun/ima2-gen` and `alasano/sora-2-playground` are architecture and behavior references only. Their source is not a migration candidate under the current plan.
- PR 0 performed inspection only; PR 3 implemented only the two approved pure subsets, while later Provider/video reuse remains gated.
- A future migration must pin the reviewed SHA, retain required MIT notices, adapt the logic to local contracts, and add local tests before merge.

## Verified upstream revisions and licenses

| Upstream | Default branch | Reviewed HEAD | License at reviewed SHA | Copyright notice |
| --- | --- | --- | --- | --- |
| [`CookSleep/gpt_image_playground`](https://github.com/CookSleep/gpt_image_playground) | `main` | [`997d79b35e60406d6ab6da26d0a9179a724820c7`](https://github.com/CookSleep/gpt_image_playground/commit/997d79b35e60406d6ab6da26d0a9179a724820c7) | MIT | Copyright (c) 2026 CookSleep |
| [`lidge-jun/ima2-gen`](https://github.com/lidge-jun/ima2-gen) | `main` | [`b7369f8a4c042249dcaa282270421d0faa7ed4fe`](https://github.com/lidge-jun/ima2-gen/commit/b7369f8a4c042249dcaa282270421d0faa7ed4fe) | MIT | Copyright (c) 2026 Jun |
| [`alasano/sora-2-playground`](https://github.com/alasano/sora-2-playground) | `master` | [`54d746350c2e0705bbfcec65cf27048aa6cbe556`](https://github.com/alasano/sora-2-playground/commit/54d746350c2e0705bbfcec65cf27048aa6cbe556) | MIT | Copyright (c) 2025 Aljosa Asanovic |

The branch names and HEAD SHAs were verified using Git's advertised `HEAD`; license identity and license text were verified from each repository at the pinned SHA. MIT permits use and modification, but copied or substantially derived portions must carry the upstream copyright and permission notice. A future reuse PR must update `THIRD_PARTY_NOTICES.md`; a file-level notice should also be retained when traceability would otherwise be unclear.

## Donor audit: `gpt_image_playground`

The following rows are candidates, not reuse decisions. `Target` is deliberately `TBD` because PR 0 must not import source.

| Candidate | Upstream files at reviewed SHA | Mode | Target | Expected adaptation | Required tests | Keep copyright notice? |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI Images and Responses request/response handling | `src/lib/openaiCompatibleImageApi.ts`, `src/lib/imageApiShared.ts`, `src/lib/serverSentEvents.ts`, relevant types from `src/types.ts` | Rewrite or selective copy after design review | TBD, likely provider adapter packages | Separate browser concerns from the server adapter; use local provider contracts, secret handling, cancellation, timeouts, and normalized asset output | Request snapshots for generation/edit; JSON and SSE result variants; Base64 and URL results; partial images; timeout, abort, rate-limit, malformed stream, and provider error cases | Yes if copied or substantially derived |
| OpenAI-compatible custom response mapping | Mapping portions of `src/lib/openaiCompatibleImageApi.ts`; `src/lib/customProviderCapabilities.ts`; `src/lib/paramCompatibility.ts` | Idea first; selective rewrite only if justified | TBD | Validate mappings as data, restrict allowed paths and headers, prevent secret leakage, and keep scripts out of the default trust boundary | Schema rejection; missing/wildcard paths; sync and async results; hostile payloads; redacted logs; capability/parameter compatibility | Yes if copied or substantially derived |
| Data URL, Base64, Blob, and image conversion | `src/lib/dataUrl.ts`, `src/lib/canvasImage.ts`, `src/lib/imageApiShared.ts` | Selective rewrite | TBD | Split browser-only APIs from Node APIs; stream or bound large payloads instead of retaining unbounded Base64 strings | MIME sniffing; invalid/truncated Base64; non-Base64 data URLs; Blob round trips; size limits; large-input memory behavior | Yes if copied or substantially derived |
| Mask ordering, validation, and preprocessing kernel | `src/lib/mask.ts`, `src/lib/maskPreprocess.ts`, `src/lib/canvasImage.ts`, `src/lib/viewportTransform.ts` | Selective rewrite; no UI | TBD | Preserve only deterministic geometry and bitmap operations; integrate with the new canvas/viewer designed for this project | Empty/partial/full alpha; target ordering; scaling and multiple-of-16 boundaries; coordinate transforms; PNG conversion; browser canvas integration | Yes if copied or substantially derived |
| Clipboard and multi-reference input normalization | `src/lib/clipboard.ts`, input helpers referenced by the donor | Behavior reference or small pure helper rewrite | TBD | Reimplement event wiring in the new Composer; accept only supported image types, cap count/bytes, and avoid donor overlays/components | Clipboard with text/files/mixed items; drag/drop directories and invalid MIME; duplicate references; count/byte limits; mobile fallback | Yes if copied or substantially derived |
| Mock image API behavior | `scripts/mock-image-api.mjs`, `docs/mock-image-api.md` | Behavior reference; local mock should use project contracts | TBD, likely testkit/mock provider | Do not inherit the donor deployment topology; make fixtures deterministic and offline | Success, latency, cancellation, partial progress, failure/refusal, malformed response, restart recovery | Yes only if code/fixtures are copied or derived |
| Existing pure-function tests as scenario inventory | `src/lib/api.test.ts`, `src/lib/dataUrl.test.ts`, `src/lib/mask.test.ts`, `src/lib/maskPreprocess.test.ts`, `src/lib/paramCompatibility.test.ts`, `src/lib/serverSentEvents.test.ts`, `src/lib/transparentImage.test.ts`, `src/lib/viewportTransform.test.ts` | Test-case reference; do not copy wholesale | TBD | Express scenarios against local contracts and fixtures; preserve attribution if test bodies or fixtures are reused | Run in CI on Node 24; add browser tests where DOM/Canvas is required | Yes if test code or fixtures are copied or substantially derived |

### Donor risks

- The donor is primarily a browser application. Directly moving network code to the server could retain CORS workarounds, browser globals, Data URLs, and client-side secret assumptions that do not fit this project's Fastify boundary.
- `openaiCompatibleImageApi.ts` combines transport, provider mappings, polling, payload conversion, and user-facing error text. It should not be imported as a monolith.
- URL-to-image retrieval becomes an SSRF surface when moved server-side. Localhost, private/link-local networks, redirects, DNS rebinding, response size, MIME, and timeout controls are required.
- Base64 and Canvas paths can multiply memory usage. Inputs must be bounded before decoding, with cancellation and concurrency tests.
- Custom provider mapping is a trust boundary. Arbitrary executable scripts are out of scope unless explicitly enabled for trusted administrators and isolated by a separate security design.
- Donor types and parameter rules reflect donor product decisions. Local `ProviderAdapter`, `GenerationRequest`, and `ModelCapabilities` remain authoritative.
- The donor's UI components, including `App.tsx`, `MaskEditorModal.tsx`, input panels/overlays, gallery, Viewer, CSS, and `store.ts`, are explicitly excluded even when they contain embedded logic.

### PR 3 approved selective-reuse gate

The PR 3 audit re-verified the donor `main` and advertised `HEAD` at `997d79b35e60406d6ab6da26d0a9179a724820c7`. The MIT license blob is `7a5b8535d3ca397ab92d8d82d9681fea36779156` and names `Copyright (c) 2026 CookSleep`.

Only these two pure, non-visual subsets are approved before implementation:

| Exact source | Source blob | Reuse mode | Exact target | Approved subset and required adaptation | Required local evidence |
| --- | --- | --- | --- | --- | --- |
| `src/lib/mask.ts` | `3feb76d2b23e1f2c827735e091739217a11a3891` | Selective copy and adaptation | `packages/shared/src/mask-target.ts` | Target existence/order and alpha-coverage classification only. Replace donor `InputImage` with local ID-bearing generics, replace user-facing Chinese errors with structured local errors, accept `ArrayLike<number>` rather than DOM `ImageData`, and define the local canonical coverage convention explicitly. | Node unit tests for missing target, stable target-first ordering, empty/partial/full coverage, non-binary alpha, malformed RGBA length, and usable-coverage rejection. |
| `src/lib/viewportTransform.ts` | `04bef54716c4e4afd86e0ee8e7833cfa2fd103a9` | Selective copy and adaptation | `packages/shared/src/viewport-transform.ts` | Clamp, focal-point zoom, pinch transform, and client-to-canvas mapping only. Add finite/positive input validation and local error behavior. Do not copy `getComfortableInitialTransform` or its donor-specific compact-layout `42%` decision. | Node unit and seeded property tests for clamp bounds, focal-point stability, pinch edge cases, finite results, zero-size rejection, and coordinate round trips. |

The target files must retain a short source header naming the donor repository, pinned revision, source file, source blob, and MIT license. The complete upstream MIT notice is recorded in `THIRD_PARTY_NOTICES.md` before code lands.

All other PR 3 work is clean-room project code:

- drag/drop, paste, directory rejection, count/byte limits, duplicate detection, and durable multipart upload;
- bounded strict Data URL/Base64 envelopes and Blob conversion;
- image orientation, resize, codec selection, alpha handling, and metadata stripping;
- Mask preprocessing, stroke interpolation, erase, command history, undo/redo, clear, serialization, Canvas rendering, and PNG export;
- every React component, Dialog/Sheet, Composer integration, Viewer integration, CSS rule, icon choice, responsive behavior, state owner, and E2E flow.

`maskPreprocess.ts`, `canvasImage.ts`, `dataUrl.ts`, and `clipboard.ts` are reference-only scenario inputs, not copy sources. Provider request logic in `imageApiShared.ts` remains deferred to PR 4. `transparentImage.ts` is outside PR 3.

## PR 6 custom Provider provenance

Audit date: 2026-08-27 (Asia/Tokyo)

The PR 6 custom HTTP/Trusted JavaScript implementation, examples, tests, and
documentation are clean-room project work. No third-party source code, UI,
fixture payload, asset, or actual Provider implementation was copied or
adapted. The existing `fixtures/providers/custom-http` and
`apps/server/src/providers/custom-js/fixtures` files are local contract
fixtures; they are not imported from a Provider or donor project.

The files under [`examples/custom-providers`](../../examples/custom-providers)
contain only relative paths, reserved placeholder hosts, and secret names
without values. They do not identify a real endpoint or contain a production
credential. The donor repositories listed above remain reference-only for PR
6, and no new attribution or MIT notice is required for this work.

## Reference audit: `ima2-gen`

No source migration is authorized. The following files identify architecture worth comparing with local designs:

| Allowed reference topic from `PLAN.MD` | Representative upstream files | Local decision/test burden |
| --- | --- | --- |
| Provider registry and capabilities | `lib/providers/registry.ts`, `lib/providers/types.ts`, `lib/capabilities.ts`, `lib/mcp/providerRegistry.ts`, `lib/mcp/modelCapabilities.ts` | Define a smaller local registry; test capability filtering, unsupported options, stable IDs, and provider isolation |
| Unified image/video job concepts | `lib/jobStatus.ts`, `lib/jobs/envelope.ts`, `lib/jobs/idempotency.ts`, `lib/inflight.ts` | Keep local job state authoritative; test state transitions, idempotency, cancellation, restart recovery, and concurrent updates |
| Multiplexed SSE | `lib/eventBus.ts`, `lib/ssePublish.ts` | Specify local event IDs and resume behavior; test reconnect, ordering, duplicate delivery, backpressure, authorization, and terminal events |
| Async video lifecycle | `lib/videoGenerationRequest.ts`, `lib/grokVideoPoll.ts`, `lib/videoArtifactPersistence.ts` | Keep provider-neutral remote IDs; test polling backoff, terminal failure, expired jobs, restart recovery, and durable artifact commit |
| Local media metadata | `lib/imageMetadata.ts`, `lib/imageMetadataStore.ts` | Define local SQLite schema and provenance; test malformed metadata, migration, deduplication, and missing files |

Risks: the upstream repository is much broader than this product and includes OAuth, CLI, MCP, node workflows, agent features, and a large UI. Those areas are excluded by `PLAN.MD`. Its provider-specific abstractions may also encode assumptions about its own storage and process model. Use it to challenge local contracts, not to import its product architecture.

## Reference audit: `sora-2-playground`

No source migration is authorized. The permitted reference surface is narrow:

| Allowed reference topic from `PLAN.MD` | Representative upstream files | Local decision/test burden |
| --- | --- | --- |
| Async video submission and remote task IDs | `src/lib/video-service.ts`, `src/lib/openai-client.ts`, `src/types/video.ts`, `src/app/api/videos/route.ts`, `src/app/api/videos/[id]/route.ts` | Adapt only behavior to the provider contract; test submit validation, remote ID persistence, status mapping, cancellation, and provider errors |
| Queue/history/failure and refresh behavior | `src/lib/db.ts`, `src/lib/errors.ts`, `src/lib/video-service.ts` | Use local SQLite/JobRunner design; test multiple queued jobs, crash/restart, stale remote jobs, failure details, and history ordering |
| Video content delivery | `src/app/api/videos/[id]/content/route.ts` | Use local asset service; test MIME, byte ranges, missing/partial files, authorization, and provider download limits |

Risks: the reference is Sora/OpenAI-specific, while this project must stay provider-neutral. Its Next.js routes and local database model do not match the planned Fastify/Drizzle architecture. The repository does not expose a comparable unit-test suite at the reviewed SHA, so behavior must be independently specified and tested. Its React components and visual design are excluded, including the video player/output UI; the project will implement its own Viewer.

## Reuse gate for later PRs

Before any upstream-derived code lands, the implementing PR must:

1. Re-verify the pinned upstream SHA and license; never silently follow a moving default branch.
2. Add one row containing the exact upstream file, exact target file, and final mode: `copy`, `rewrite`, or `reference only`.
3. Explain the material changes and why reuse is preferable to a local implementation.
4. Add or identify tests that exercise local contracts, security limits, error handling, and recovery.
5. Add the complete required MIT notice to `THIRD_PARTY_NOTICES.md` and retain a file header when appropriate.
6. Confirm with repository search and visual review that no upstream page, component tree, CSS, icons, screenshots, fonts, or other visual assets were introduced.

Current gate result: **PASS for PR 3 selective reuse. The two approved pure kernels were implemented with pinned-source headers and tests; all other PR 3 code is clean-room.**
