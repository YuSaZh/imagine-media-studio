# PR 7 Verification

Status: **Implementation and automated acceptance passed.** Real-platform PWA
installation, device safe-area/keyboard evidence, and strict authenticated Grok
visual comparison remain external evidence in [`Hold.md`](../../Hold.md).

This historical PR 7 record covers the original PWA and mobile-polish milestone.
Current guidance is indexed in [docs/README.md](../README.md).
It extends the installable shell introduced in PR 0;
it does not add another process, database, port, volume, or business service.

## Feature matrix

| ID | Acceptance surface | Evidence | Status |
| --- | --- | --- | --- |
| F-01 | Install prompt, iOS Add to Home Screen guidance, standalone detection, and update apply/dismiss states | `pwa-registration.ts`, `settings-page.tsx`, `pwa-registration.test.ts`, `pr7.spec.ts` | Automated |
| F-02 | Cold offline App Shell opens only for a recognized session and fails closed for unknown markers | `pwa-offline-snapshot.ts`, auth-marker tests, `pr7.spec.ts` | Automated |
| F-03 | Recent Gallery metadata and completed Assets restore offline from a bounded, expiring, session-scoped snapshot | Offline snapshot/query tests and `pr7.spec.ts` | Automated |
| F-04 | Offline generation is disabled; Provider secrets, generated POST requests, and full video responses are excluded from PWA storage | Workbox rules, media-cache tests, serialized-browser-state checks | Automated |
| F-05 | Prompt drafts survive refresh/offline reopen, flush before update, clear after submit, and stay isolated across sessions/tabs | Composer draft and PWA registration tests; `pr7.spec.ts` | Automated |
| F-06 | Closing the browser page does not own the JobRunner; reopening restores the server-owned Job and its completed Asset | Representative PR 7 browser acceptance | Automated |
| F-07 | Gallery long press, explicit selection, coarse-pointer menus, Viewer swipe/pinch/pan/double-tap, cancellation, and focus return | Gesture/unit tests and the eight-project PR 7 Playwright matrix | Automated |
| F-08 | Safe-area and `visualViewport` keyboard geometry avoid horizontal overflow and Composer occlusion | Two mobile geometry fixtures and screenshots | Simulated device geometry |
| F-09 | Gallery history uses independent Asset/Job cursors, stable deduplication, loading/error/end states, bounded pagination, and virtualized rendering | Gallery query/component tests | Automated |
| F-10 | Settings, Library, and Mask editor routes are split; the production entry has a hard raw-byte build budget | `app.test.tsx`, `check-build-budget.mjs` | Automated |
| F-11 | Serious/critical WCAG 2A/2AA violations, first-screen JS requests/bytes, and CLS have representative desktop/mobile gates | [`pr7-a11y-performance.md`](./pr7-a11y-performance.md), `pr7-a11y-perf.spec.ts` | Automated |

## Performance and accessibility

- The production entry chunk is `334,651` raw bytes, below the `500,000` byte
  build budget. The previous PR 5 entry advisory was `571.55 kB`.
- The browser performance gate allows at most eight first-screen JavaScript
  requests, `950,000` raw JavaScript bytes, and `0.10` cumulative layout shift.
- Axe runs the WCAG 2A and 2AA tags without disabled rules. Critical and serious
  violations fail CI; lower-impact results remain attached for review.
- Settings/Library/Mask route fallbacks have stable geometry. The Service Worker
  precache contains every emitted JavaScript chunk exactly once.

## Local acceptance

| Check | Result |
| --- | --- |
| Full workspace unit suite | Pass: 110 test files / 929 tests |
| Workspace lint | Pass |
| Workspace typecheck | Pass |
| Workspace production build and entry budget | Pass; entry `334,651` bytes |
| E2E TypeScript compilation | Pass |
| Representative PR 7 a11y/performance project discovery | Pass: 10 tests in each desktop/mobile project |
| Representative production/fixture performance browser run | Pass: 4/4 in an isolated reviewer run |
| Diff whitespace check | Pass |

The primary execution sandbox rejected the Playwright web server's isolated
`0.0.0.0` listener with `listen EPERM`, so no complete local axe run is claimed.
GitHub Actions is the runtime authority for the complete browser matrix and
isolated Docker smoke.

## GitHub Actions acceptance

Commit `a58ab7b` passed all 13 jobs in [run
33174754136](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136).

| Workflow surface | Evidence | Status |
| --- | --- | --- |
| Lint, typecheck, 929 unit tests, production build/budget | [Job 98860362163](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362163) | Pass |
| Base PR 1/3/4/5/6 Playwright suite | [Job 98860361984](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860361984) | Pass |
| Single-container build, API/media/persistence/restart smoke | [Job 98860362155](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362155) | Pass |
| PR 7 desktop 1280/1440/1920 | Jobs [98860362277](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362277), [98860362235](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362235), [98860362207](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362207) | Pass |
| PR 7 tablet 834/1024 | Jobs [98860362337](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362337), [98860362198](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362198) | Pass |
| PR 7 mobile 360/390/430 | Jobs [98860362357](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362357), [98860362115](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362115), [98860362139](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362139) | Pass |
| Desktop axe and performance | [Job 98860362200](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362200) | Pass |
| Mobile axe and performance | [Job 98860362147](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33174754136/job/98860362147) | Pass |

## Evidence boundary

- The Linux Chromium checks prove manifest/installability inputs, Service Worker
  control, standalone layout semantics, and install/update event handling. They
  do not prove completed installation on Windows, macOS, Android, or iOS.
- The keyboard and safe-area screenshots use deterministic browser geometry
  injection. They do not replace real iOS/Android device evidence.
- The committed PR 7 screenshots and report cover fixed implementation states,
  but the private authenticated Grok reference package is unavailable. Strict
  L3/L4 or the visual policy's pixel threshold is not claimed.
- These external evidence gaps do not weaken or substitute the automated pass;
  they stay explicit in `Hold.md` for device/reference review.
