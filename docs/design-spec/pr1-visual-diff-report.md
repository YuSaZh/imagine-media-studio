# Visual Diff Report - PR 1

## Result

**Functional UI Shell: Remote CI pass**

**Grok Imagine L3/L4 visual gate: Pending private authenticated reference package**

PR 1 has a desktop/mobile UI Shell and a Playwright acceptance definition for four fixed viewports. Commit `b82379480ff7e8a4d5aecdc3ab0626713f7f2236` passed [GitHub Actions run 32806743101](https://github.com/YuSaZh/imagine-media-studio/actions/runs/32806743101), including quality/build, 24 Playwright checks, screenshot upload, and single-container persistence smoke. The available Grok Imagine evidence remains limited to the public unauthenticated surface documented in [`pr1-public-reference.md`](./pr1-public-reference.md). Pixel similarity and authenticated-state fidelity cannot be claimed from that evidence.

## Environment

| Item | Value |
| --- | --- |
| Reference target | `https://grok.com/imagine` |
| Public reference capture | 2026-08-25, unauthenticated |
| Mock fixture | `pr1-v1` |
| Implementation data | 30 fixed image items, 8 fixed video Poster items, 10 Job states |
| Browser | Playwright 1.62.1 bundled Chromium on `ubuntu-24.04`, DPR 1 |
| Locale | `en-US` implementation; public reference captured in `zh-CN` |
| Motion | Disabled for screenshots |
| Local automated preflight | 32 unit tests; 24 Playwright tests across four projects |
| Remote automated acceptance | Actions run `32806743101`; artifact `pr1-ui-screenshots` (`9548417163`) |

## Implementation Screenshots

| Viewport | Evidence | Result |
| --- | --- | --- |
| 1920x1080 | `artifacts/visual/pr1/desktop-1920x1080.png` | Remote capture reviewed; functional pass |
| 1440x900 | `artifacts/visual/pr1/desktop-1440x900.png` | Remote capture reviewed; functional pass |
| 430x932 | `artifacts/visual/pr1/mobile-430x932.png` | Remote capture reviewed; functional pass |
| 390x844 | `artifacts/visual/pr1/mobile-390x844.png` | Remote capture reviewed; functional pass |

The CI definition requires a desktop card width above 200px and a mobile card width above 150px, keeps the first card and scrolled sticky header below the fixed mobile header, requires every Composer and parameter-surface edge to remain inside the viewport, and rejects horizontal document overflow. The successful remote run generated all four screenshots plus 1440/390 parameter and Viewer states from the fixed Fixture. All eight remote captures were reviewed without finding overlap or clipping regressions.

## Reference Comparison

| Region | Public evidence | Implementation | Conclusion |
| --- | --- | --- | --- |
| Canvas | White, visually quiet | White/near-white, media carries color | Aligned within available evidence |
| Composer | About 768px wide, two rows | 768px desktop, two rows | Aligned; authenticated controls remain unverified |
| Mobile Composer | Near-full-width bottom surface | 10px side insets with safe-area and keyboard offset | Direction aligned; device safe-area value pending |
| Gallery | Compact mixed-ratio masonry; public desktop shows three visible columns | Virtualized mixed-ratio masonry; four columns at 1440/1920, two on mobile | Intentional product extension; authenticated history layout missing |
| Parameter menus | Count and ratio menus above controls | Native compact selectors plus advanced Radix Popover | Functionally equivalent, not a pixel match |
| Brand/navigation | Public logged-out actions and Grok mark | Project-owned `IM` mark, narrow Rail, mobile header | Intentional project extension; no Grok brand assets copied |
| Task states | Not visible in public evidence | Ten distinct states mixed into the gallery | Product requirement; visual fidelity pending authenticated evidence |

Pixel-diff values are `N/A`: comparing an unauthenticated public template page against an authenticated product Shell with different media and locale would produce a misleading number. No mask is used to turn that mismatch into a passing result.

## Interaction Verification

| Path | Desktop | Mobile | Result |
| --- | --- | --- | --- |
| Root redirect and primary routes | Automated assertion | Automated assertion | Remote pass |
| Empty Prompt disabled | Automated assertion | Automated assertion | Remote pass |
| Image/video mode and parameter surface | Automated geometry assertion | Mobile Bottom Sheet geometry asserted | Remote pass |
| Mock submit | Capability-driven x2 increment and reference upload asserted | Same assertion through mobile parameters | Remote pass |
| Gallery video filter | Every rendered card must expose `data-kind="video"` | Same assertion | Remote pass |
| Viewer open/close, focus restore, ArrowRight | Counter and trigger focus asserted | Same assertion; touch swipe remains manual | Remote pass |
| Saved, Folder, Jobs, Provider settings | UI navigation assertion | Mobile menu navigation for all four paths | Remote pass |
| Saved and Folder cache consistency | Card action persists across primary routes | Mobile action menu persists across primary routes | Remote pass |
| Cancel, retry, and touch selection | State transition and single-toggle asserted | Synthetic touch/contextmenu ordering asserted | Remote pass |
| Viewer continuation Capability | Returns to image/video Composer with normalized count/references | Same assertion | Remote pass |
| Jobs batch grouping | x2 output batch produces one Job row | Same assertion | Remote pass |
| PWA installability and offline App Shell | Automated assertion | Automated assertion | Remote pass |
| Real soft keyboard and device safe area | Simulated geometry only | Not a true device | Pending |
| Long-press selection and OS gesture conflicts | Implemented | Not a true device | Pending manual device review |

## Known Gaps

1. The private authenticated reference package named in `ui-reference-version.md` is absent.
2. Logged-in navigation, history Gallery, Saved, Folder, Viewer, task-state and settings comparisons remain `Missing`.
3. L3/L4 visual classification requires authenticated screenshots and human review; it is not inferred from green tests.
4. Windows/macOS installed PWA and Android/iOS standalone behavior require later platform verification.
5. PR 1 uses fixed Poster images for video; real playback and Range behavior belong to later PRs.

These gaps do not invalidate the functional remote acceptance result. They keep the strict L3/L4 UI classification and device-specific validation open until the missing reference and platform evidence are supplied.
