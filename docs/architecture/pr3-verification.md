# PR 3 Verification

## Delivered Scope

PR 3 completes the selective image-input and editing boundary described in `PLAN.MD`:

- drag/drop, file picker, clipboard, directory rejection, duplicate detection, count limits, and aggregate byte limits;
- orientation-aware browser decoding, bounded downscaling, metadata-stripping re-encode, first-frame normalization, and Provider MIME/dimension policy checks;
- concurrency-two durable multipart uploads with Abort, retry, late-result suppression, object-URL cleanup, and explicit missing/incompatible input states;
- role-aware Composer inputs for references, source, Mask, and video first frame, with operation and Capability normalization;
- strict bounded Base64 Data URL decoding and Blob conversion without persisting Base64 in browser state;
- canonical Mask alpha semantics, bounded stroke/history/render work, brush, eraser, undo/redo, clear, and pointer cancellation;
- a route-split full-screen editor with contain geometry, DPR limits, desktop/mobile controls, same-origin source loading, PNG Mask upload, and parent-asset relationships;
- Mock `image.edit` validation, durable Job inputs, Mask persistence, output parent relationships, and restart verification;
- production-mode Playwright coverage for two real reference uploads, image generation, Mask editing, `image.edit`, and desktop/mobile geometry.

The Mock Provider remains the only executable Provider. Real image adapters begin in PR 4.

## Selective Reuse Boundary

Only two pure non-visual subsets from `CookSleep/gpt_image_playground` were selectively adapted:

| Donor source at `997d79b35e60406d6ab6da26d0a9179a724820c7` | Local target | Adapted behavior |
| --- | --- | --- |
| `src/lib/mask.ts`, blob `3feb76d2b23e1f2c827735e091739217a11a3891` | `packages/shared/src/mask-target.ts` | Target ordering and alpha coverage classification |
| `src/lib/viewportTransform.ts`, blob `04bef54716c4e4afd86e0ee8e7833cfa2fd103a9` | `packages/shared/src/viewport-transform.ts` | Bounded zoom/pinch and client-to-canvas geometry |

Both local files retain source headers and MIT attribution. The complete upstream MIT notice is in `THIRD_PARTY_NOTICES.md`. Reuse was preferable to re-deriving these two compact, independently testable kernels because the pinned implementations supplied audited edge-case behavior without importing product architecture. All React components, CSS, Composer/Gallery/Viewer integration, state ownership, upload/preprocess logic, Mask document/history, Canvas rendering, PNG export, and E2E flows are clean-room project code.

No donor page, App Shell, Composer, Gallery, Viewer, design token, responsive layout, store, icon, screenshot, font, or visual asset was copied.

## Local Acceptance

The development-host checks used the project-only port and isolated temporary data. No existing container or service was stopped, restarted, renamed, or inspected.

| Check | Result |
| --- | --- |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass across all workspaces |
| `pnpm test` | Pass, 56 files / 280 tests |
| `pnpm build` | Pass; Editor split to a 33.46 kB route chunk; one non-blocking 551.81 kB entry warning remains |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/snap/bin/chromium pnpm test:e2e` | Pass, 26 executed / 6 project-scoped skips across four configured viewports |
| PR 3 production browser flow | Pass: two multipart references, `image.generate`, Mask upload, `image.edit`, completed output parent |
| Port `3030` before and after browser tests | Free |

Each browser run moved the pre-existing `/tmp/imagine-media-studio-e2e-data` directory to an exact backup path, used a fresh directory, removed only the generated directory, and restored the original afterward. PR 1 visual baselines were restored after mechanical captures.

## Remote Acceptance

GitHub-hosted Actions independently verified clean checkout behavior:

| Stage | Commit / run | Result |
| --- | --- | --- |
| Selective reuse gate | `f16fd73` / `32813481508` | Pass |
| Shared Mask and viewport kernels | `a3da84e` / `32814720387` | Pass |
| Server edit-input validation | `41b79cd` / `32814876712` | Pass |
| PR 3 image-edit persistence smoke | `213ad9c` / `32815422272` | Pass |
| Bounded smoke workflow | `7451803` / `32815761265` | Pass |
| Base64/Blob conversion | `db2c005` / `32817742608` | Pass |
| Browser editor core | `41ab8b3` / `32818068321` | Pass |
| Durable image-input pipeline | `cb67e2d` / `32818997150` | Pass |
| Typed Composer integration | `817701d` / `32819149053` | Pass |
| Full Mask editing workflow | `37baaa3` / `32830311625` | Pass |
| Desktop/mobile visual evidence | `39d4bf8` / `32831294521` | Pass |

Final run `32831294521` passed quality/build, PR 1 + PR 3 Playwright/PWA, and the single-container PR 3 API/persistence smoke. The smoke used one Compose service, a unique project name, a dynamically allocated host port, a temporary `0700` data directory, bounded timeouts, restart verification, and unconditional cleanup.

## Visual Evidence

Final clean-runner artifact `9556874379` (`pr3-ui-screenshots`) contains:

| File | Viewport | SHA-256 |
| --- | --- | --- |
| `editor-desktop-1440x900.png` | 1440 x 900 | `e7ab796e10b76a108d167cb4e68ee79b1497d1dc0e25cd720c291527a8a57366` |
| `editor-mobile-390x844.png` | 390 x 844 | `230c58ad12b5a12963bd3e492d0693d435034e9abdb01a35f20a40c5315a7511` |

Both screenshots were manually checked for nonblank media, contain geometry, command visibility, touch target stability, safe-area spacing, horizontal overflow, text clipping, and incoherent overlap. The remote runner images are the repository baselines.

## Safety And Data Boundaries

- API keys remain server-only and are absent from browser state, logs, PWA cache, screenshots, and exported configuration.
- Asset IDs, not Base64 or decoded bitmap state, cross the Composer boundary.
- Source content URLs must exactly match the same-origin internal asset route.
- Browser editing rejects non-image, missing-dimension, oversized, MIME-mismatched, or non-persisted assets.
- Mask files are PNG Blob uploads with canonical binary alpha, exact source dimensions, `role=mask`, and `parentAssetId=source`.
- Default Gallery queries hide Mask assets; a dedicated input inventory explicitly loads Mask records for Composer validation.
- No real Provider networking was introduced in PR 3.

## Deferred Items

- OpenAI, Gemini, xAI, and compatible real image Providers begin in PR 4.
- The authenticated Grok Imagine private reference package remains unavailable, so strict L3/L4 pixel-parity remains unclaimed.
- The production entry chunk remains above Vite's 500 kB advisory threshold; the Editor is already route-split, and broader performance work remains for PR 7.
