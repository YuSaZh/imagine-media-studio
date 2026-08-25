# Visual Diff Report - PR 1

## Result

**Functional UI Shell: Local preflight captured; remote CI pending**

**Grok Imagine L3/L4 visual gate: Pending private authenticated reference package**

PR 1 has a desktop/mobile UI Shell and a Playwright acceptance definition for four fixed viewports. The remote GitHub Actions run and its screenshot artifact do not exist yet for this worktree, so this report records local preflight evidence and expected CI assertions rather than a remote pass. The available Grok Imagine evidence is limited to the public unauthenticated surface documented in [`pr1-public-reference.md`](./pr1-public-reference.md). Pixel similarity and authenticated-state fidelity cannot be claimed from that evidence.

## Environment

| Item | Value |
| --- | --- |
| Reference target | `https://grok.com/imagine` |
| Public reference capture | 2026-08-25, unauthenticated |
| Mock fixture | `pr1-v1` |
| Implementation data | 30 fixed image items, 8 fixed video Poster items, 10 Job states |
| Browser | Chromium, DPR 1 |
| Locale | `en-US` implementation; public reference captured in `zh-CN` |
| Motion | Disabled for screenshots |
| Local automated preflight | 32 unit tests; 24 Playwright tests across four projects |

## Implementation Screenshots

| Viewport | Evidence | Result |
| --- | --- | --- |
| 1920x1080 | `artifacts/visual/pr1/desktop-1920x1080.png` | Local capture reviewed; remote result pending |
| 1440x900 | `artifacts/visual/pr1/desktop-1440x900.png` | Local capture reviewed; remote result pending |
| 430x932 | `artifacts/visual/pr1/mobile-430x932.png` | Local capture reviewed; remote result pending |
| 390x844 | `artifacts/visual/pr1/mobile-390x844.png` | Local capture reviewed; remote result pending |

The CI definition requires a desktop card width above 200px and a mobile card width above 150px, keeps the first card and scrolled sticky header below the fixed mobile header, requires every Composer and parameter-surface edge to remain inside the viewport, and rejects horizontal document overflow. The same run generates all four screenshots plus 1440/390 parameter and Viewer states from the fixed Fixture. These assertions passed locally; they are not remote results until Actions completes.

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
| Root redirect and primary routes | Automated assertion | Automated assertion | Local pass; remote pending |
| Empty Prompt disabled | Automated assertion | Automated assertion | Local pass; remote pending |
| Image/video mode and parameter surface | Automated geometry assertion | Mobile Bottom Sheet geometry asserted | Local pass; remote pending |
| Mock submit | Capability-driven x2 increment and reference upload asserted | Same assertion through mobile parameters | Local pass; remote pending |
| Gallery video filter | Every rendered card must expose `data-kind="video"` | Same assertion | Local pass; remote pending |
| Viewer open/close, focus restore, ArrowRight | Counter and trigger focus asserted | Same assertion; touch swipe remains manual | Local pass; remote pending |
| Saved, Folder, Jobs, Provider settings | UI navigation assertion | Mobile menu navigation for all four paths | Local pass; remote pending |
| Saved and Folder cache consistency | Card action persists across primary routes | Mobile action menu persists across primary routes | Local pass; remote pending |
| Cancel, retry, and touch selection | State transition and single-toggle asserted | Synthetic touch/contextmenu ordering asserted | Local pass; remote pending |
| Viewer continuation Capability | Returns to image/video Composer with normalized count/references | Same assertion | Local pass; remote pending |
| Jobs batch grouping | x2 output batch produces one Job row | Same assertion | Local pass; remote pending |
| PWA installability and offline App Shell | Automated assertion | Automated assertion | Local pass; remote pending |
| Real soft keyboard and device safe area | Simulated geometry only | Not a true device | Pending |
| Long-press selection and OS gesture conflicts | Implemented | Not a true device | Pending manual device review |

## Known Gaps

1. The first remote GitHub Actions run and `pr1-ui-screenshots` artifact for this worktree are not yet available.
2. The private authenticated reference package named in `ui-reference-version.md` is absent.
3. Logged-in navigation, history Gallery, Saved, Folder, Viewer, task-state and settings comparisons remain `Missing`.
4. L3/L4 visual classification requires authenticated screenshots and human review; it is not inferred from green tests.
5. Windows/macOS installed PWA and Android/iOS standalone behavior require later platform verification.
6. PR 1 uses fixed Poster images for video; real playback and Range behavior belong to later PRs.

These gaps do not invalidate local preflight work, but they keep both the remote acceptance result and the strict UI Gate open until CI, the missing reference, and device evidence are supplied.
